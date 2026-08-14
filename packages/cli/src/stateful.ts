import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parse, stringify } from "yaml";

import {
  compilePreset,
  doctorDshHome,
  installResolvedSetups,
  rollbackDshHome,
} from "@oh-my-dsh/adapter-dsh-rc5";
import {
  computeArchiveSetupHash,
  createAgentArchive,
  createFork,
  DEFAULT_ARCHIVE_LIMITS,
  materializePinnedGitSource,
  parseAgentArchive,
  resolveCustomSetup,
  resolveSetup,
  saveCustomSetup,
  validatePortableAgentSetup,
  type ArchiveLock,
  type PortableAgentSetup,
  type ResolvedSetup,
  type SetupCatalog,
} from "@oh-my-dsh/core";
import {
  parseAgentSetup,
  parseCustomAgentSetup,
  type AgentSetup,
  type CapabilityPack,
  type CustomAgentSetup,
} from "@oh-my-dsh/schema";

export interface StatefulIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface StatefulCommandContext {
  io: StatefulIO;
  json: boolean;
  dshHome: string;
  operands: string[];
  setups: Readonly<Record<string, AgentSetup>>;
  capabilities: readonly CapabilityPack[];
  version: string;
}

interface LocalSetup {
  slug: string;
  setup: PortableAgentSetup;
  files: Map<string, Uint8Array>;
  lock?: unknown;
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const FULL_COMMIT = /^[a-f0-9]{40}$/;

function usageError(io: StatefulIO, message: string): number {
  io.stderr(`Error: ${message}\n`);
  return 2;
}

function operationError(io: StatefulIO, message: string): number {
  io.stderr(`Error: ${message}\n`);
  return 1;
}

function writeJson(io: StatefulIO, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function unexpected(io: StatefulIO, argument: string, command: string): number {
  return argument.startsWith("-")
    ? usageError(io, `Unknown option "${argument}" for "${command}".`)
    : usageError(io, `Unexpected argument "${argument}" for "${command}".`);
}

function messageOf(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.split("\n", 1)[0]?.trim();
  if (!message || message.length > 300) return fallback;
  return [...message]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? " " : character;
    })
    .join("");
}

function catalog(context: StatefulCommandContext): SetupCatalog {
  return { setups: { ...context.setups }, capabilities: context.capabilities };
}

function builtInParent(
  context: StatefulCommandContext,
  dependency: CustomAgentSetup["extends"],
): AgentSetup {
  const matches = Object.values(context.setups).filter(
    (setup) =>
      setup.metadata.id === dependency.id &&
      setup.metadata.version === dependency.version,
  );
  if (matches.length !== 1)
    throw new Error(
      `fork parent ${dependency.id}@${dependency.version} is not installed`,
    );
  return matches[0]!;
}

function slugFor(setup: PortableAgentSetup): string {
  const slug = setup.metadata.id.startsWith("local.")
    ? setup.metadata.id.slice("local.".length)
    : setup.metadata.id.split(".").at(-1);
  if (!slug || !SLUG.test(slug))
    throw new Error(
      `cannot derive a portable setup slug from ${setup.metadata.id}`,
    );
  return slug;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readRegularFile(
  path: string,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`${label} must be a regular file`);
    if (stats.size > maxBytes)
      throw new Error(`${label} exceeds ${maxBytes} byte limit`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function localAgentsRoot(
  dshHome: string,
  create: boolean,
): Promise<string | undefined> {
  const managedRoot = join(dshHome, "oh-my-dsh");
  const agents = join(managedRoot, "agents");
  for (const [label, path] of [
    ["managed root", managedRoot],
    ["agents root", agents],
  ] as const) {
    if (!(await pathExists(path))) {
      if (!create) return undefined;
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory())
      throw new Error(`${label} is not a regular directory`);
  }
  return agents;
}

async function assertSafeAssetParents(
  root: string,
  portablePath: string,
): Promise<void> {
  let current = root;
  for (const segment of portablePath.split("/").slice(0, -1)) {
    current = join(current, segment);
    const stats = await lstat(current);
    if (stats.isSymbolicLink() || !stats.isDirectory())
      throw new Error(
        `setup asset parent is not a regular directory: ${segment}`,
      );
  }
}

function parsePortableSetup(input: unknown): PortableAgentSetup {
  if (typeof input !== "object" || input === null || !("kind" in input)) {
    throw new Error("agent.yaml must contain an AgentSetup definition");
  }
  return input.kind === "AgentSetupFork"
    ? parseCustomAgentSetup(input)
    : parseAgentSetup(input);
}

async function readLocalSetups(dshHome: string): Promise<LocalSetup[]> {
  const root = await localAgentsRoot(dshHome, false);
  if (root === undefined) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const setups: LocalSetup[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory() || !SLUG.test(entry.name)) continue;
    const directory = join(root, entry.name);
    const manifest = join(directory, "agent.yaml");
    const manifestStat = await lstat(manifest);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink())
      throw new Error(`refusing non-regular setup file: ${manifest}`);
    const setup = validatePortableAgentSetup(
      parsePortableSetup(
        parse(
          (await readRegularFile(manifest, 1024 * 1024, "agent.yaml")).toString(
            "utf8",
          ),
          { maxAliasCount: 20 },
        ),
      ),
    );
    const files = new Map<string, Uint8Array>();
    const assetsRoot = join(directory, "files");
    if (await pathExists(assetsRoot)) {
      const assetsStat = await lstat(assetsRoot);
      if (!assetsStat.isDirectory() || assetsStat.isSymbolicLink())
        throw new Error(`refusing non-directory setup assets: ${assetsRoot}`);
      // Archive validation has already confined imported paths. Local users may
      // edit definitions, but executable assets are never traversed or loaded.
      for (const filename of setup.kind === "AgentSetup"
        ? declaredFiles(setup)
        : []) {
        const path = join(assetsRoot, ...filename.split("/"));
        await assertSafeAssetParents(assetsRoot, filename);
        const fileStat = await lstat(path);
        if (!fileStat.isFile() || fileStat.isSymbolicLink())
          throw new Error(`refusing non-regular setup asset: ${filename}`);
        files.set(
          filename,
          await readRegularFile(path, 2 * 1024 * 1024, "setup asset"),
        );
      }
    }
    const lockPath = join(directory, "omdsh.lock");
    const lock = (await pathExists(lockPath))
      ? (JSON.parse(
          (await readRegularFile(lockPath, 64 * 1024, "setup lock")).toString(
            "utf8",
          ),
        ) as unknown)
      : undefined;
    setups.push({
      slug: entry.name,
      setup,
      files,
      ...(lock === undefined ? {} : { lock }),
    });
  }
  return setups;
}

function declaredFiles(setup: AgentSetup): string[] {
  return [
    ...(setup.persona && "file" in setup.persona ? [setup.persona.file] : []),
    ...(setup.instructions.files ?? []),
    ...setup.examples,
  ];
}

function hydrateSetup(
  setup: AgentSetup,
  files: ReadonlyMap<string, Uint8Array>,
): AgentSetup {
  if (files.size === 0) return setup;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const readText = (path: string): string => {
    const content = files.get(path);
    if (!content) throw new Error(`setup file is missing: ${path}`);
    return decoder.decode(content);
  };
  return parseAgentSetup({
    ...setup,
    persona:
      "file" in setup.persona
        ? { text: readText(setup.persona.file) }
        : setup.persona,
    instructions: {
      inline: [
        ...(setup.instructions.inline ?? []),
        ...(setup.instructions.files ?? []).map(readText),
      ],
    },
  });
}

function resolveLocal(
  local: LocalSetup,
  context: StatefulCommandContext,
): ResolvedSetup {
  const resolved =
    local.setup.kind === "AgentSetupFork"
      ? resolveCustomSetup(
          local.setup,
          builtInParent(context, local.setup.extends),
          context.capabilities,
        )
      : resolveSetup(
          hydrateSetup(local.setup, local.files),
          context.capabilities,
        );
  if (local.lock !== undefined)
    verifyLocalLock(local, resolved, context.version);
  return resolved;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function verifyLocalLock(
  local: LocalSetup,
  resolved: ResolvedSetup,
  adapterVersion: string,
): void {
  if (typeof local.lock !== "object" || local.lock === null)
    throw new Error(`setup ${local.slug} lock is invalid`);
  const lock = local.lock as Record<string, unknown>;
  const expectedCapabilities = resolved.capabilities
    .map((capability) => `${capability.id}@${capability.version}`)
    .sort();
  if (!Array.isArray(lock.capabilities))
    throw new Error(`setup ${local.slug} lock capabilities are invalid`);
  const actualCapabilities = lock.capabilities
    .map((value) => {
      if (typeof value !== "object" || value === null)
        throw new Error(`setup ${local.slug} lock capability is invalid`);
      const capability = value as { id?: unknown; version?: unknown };
      return `${String(capability.id)}@${String(capability.version)}`;
    })
    .sort();
  if (
    JSON.stringify(actualCapabilities) !== JSON.stringify(expectedCapabilities)
  )
    throw new Error(`setup ${local.slug} capability lock mismatch`);

  if ("setupId" in lock) {
    if (
      lock.setupId !== local.setup.metadata.id ||
      lock.setupVersion !== local.setup.metadata.version ||
      lock.normalizedHash !== computeArchiveSetupHash(local.setup)
    )
      throw new Error(`setup ${local.slug} archive lock mismatch`);
    const adapter = lock.adapter as { id?: unknown; version?: unknown };
    if (adapter?.id !== "dsh-rc5" || adapter.version !== adapterVersion)
      throw new Error(`setup ${local.slug} adapter lock mismatch`);
  } else if (lock.type === "git") {
    if (lock.setupHash !== computeArchiveSetupHash(local.setup))
      throw new Error(`setup ${local.slug} Git lock mismatch`);
    if (
      typeof lock.revision !== "string" ||
      !FULL_COMMIT.test(lock.revision) ||
      typeof lock.contentDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(lock.contentDigest)
    )
      throw new Error(`setup ${local.slug} Git provenance lock is invalid`);
    const adapter = lock.adapter as { id?: unknown; version?: unknown };
    if (adapter?.id !== "dsh-rc5" || adapter.version !== adapterVersion)
      throw new Error(`setup ${local.slug} adapter lock mismatch`);
  } else {
    const setup = lock.setup as { id?: unknown; version?: unknown };
    if (
      setup?.id !== local.setup.metadata.id ||
      setup.version !== local.setup.metadata.version ||
      lock.normalizedHash !== resolved.hash
    )
      throw new Error(`setup ${local.slug} saved lock mismatch`);
  }

  const expectedFiles = Object.fromEntries(
    [...local.files]
      .map(([path, content]) => [path, sha256(content)] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  if (JSON.stringify(lock.files ?? {}) !== JSON.stringify(expectedFiles))
    throw new Error(`setup ${local.slug} asset lock mismatch`);
}

async function resolvedSetups(
  context: StatefulCommandContext,
  requireLocks = false,
): Promise<Array<{ key: string; resolved: ResolvedSetup }>> {
  const entries = Object.entries(context.setups)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, setup]) => ({
      key,
      resolved: resolveSetup(setup, context.capabilities),
    }));
  const knownIds = new Set(entries.map(({ resolved }) => resolved.metadata.id));
  for (const local of await readLocalSetups(context.dshHome)) {
    if (requireLocks && local.lock === undefined)
      throw new Error(
        `setup ${local.slug} is not saved; run "oh-my-dsh agent save ${local.slug}" first`,
      );
    if (knownIds.has(local.setup.metadata.id))
      throw new Error(`duplicate setup id: ${local.setup.metadata.id}`);
    knownIds.add(local.setup.metadata.id);
    entries.push({ key: local.slug, resolved: resolveLocal(local, context) });
  }
  return entries.sort((left, right) => left.key.localeCompare(right.key));
}

function selectResolved(
  entries: readonly { key: string; resolved: ResolvedSetup }[],
  selector: string,
): { key: string; resolved: ResolvedSetup } | undefined {
  const normalized = selector.toLowerCase();
  return entries.find(
    ({ key, resolved }) =>
      key.toLowerCase() === normalized ||
      resolved.metadata.id.toLowerCase() === normalized ||
      resolved.metadata.name.toLowerCase() === normalized,
  );
}

async function currentDefault(dshHome: string): Promise<string> {
  try {
    const settings = parse(
      (
        await readRegularFile(
          join(dshHome, "settings.yaml"),
          1024 * 1024,
          "settings.yaml",
        )
      ).toString("utf8"),
      { maxAliasCount: 20 },
    ) as unknown;
    if (typeof settings === "object" && settings !== null) {
      const presets = (settings as Record<string, unknown>)["agent-presets"];
      if (typeof presets === "object" && presets !== null) {
        const value = (presets as Record<string, unknown>).default;
        if (typeof value === "string") return value;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return "coding";
}

async function applyAll(
  context: StatefulCommandContext,
  defaultSetupId: string,
) {
  const entries = await resolvedSetups(context, true);
  return installResolvedSetups({
    dshHome: context.dshHome,
    setups: entries.map(({ resolved }) => resolved),
    defaultSetupId,
  });
}

function warningText(warnings: readonly string[]): string {
  const unique = [...new Set(warnings)].sort();
  return unique.length === 0
    ? ""
    : `\nAdapter limitations:\n${unique.map((warning) => `  - ${warning}`).join("\n")}\n`;
}

async function initCommand(context: StatefulCommandContext): Promise<number> {
  if (context.operands.length > 0)
    return unexpected(context.io, context.operands[0]!, "init");
  const result = await applyAll(context, "coding");
  if (context.json) {
    writeJson(context.io, { command: "init", ...result });
  } else {
    context.io.stdout(
      "Installed built-in agent setups:\n\n" +
        "  coding      Build, debug, test, and review software\n" +
        "  research    Conduct cited, evidence-driven research\n" +
        "  investing   Analyze companies, filings, and investment theses\n\n" +
        "Default: coding\nOpen a new DSH session and choose an Agent Setup.\n" +
        warningText(result.warnings),
    );
  }
  return 0;
}

async function applyCommand(context: StatefulCommandContext): Promise<number> {
  if (context.operands.length > 0)
    return unexpected(context.io, context.operands[0]!, "apply");
  const result = await applyAll(context, await currentDefault(context.dshHome));
  if (context.json) writeJson(context.io, { command: "apply", ...result });
  else
    context.io.stdout(
      `${result.changed ? "Applied" : "Already current:"} ${result.presetIds.length} Agent Setups (${result.generationId}).\n${warningText(result.warnings)}`,
    );
  return 0;
}

async function useCommand(context: StatefulCommandContext): Promise<number> {
  const args = [...context.operands];
  const defaultIndex = args.indexOf("--default");
  if (defaultIndex < 0)
    return usageError(context.io, 'The "use" command requires --default.');
  args.splice(defaultIndex, 1);
  if (args.length !== 1) {
    return args.length === 0
      ? usageError(context.io, 'The "use" command requires a setup.')
      : unexpected(context.io, args[1]!, "use");
  }
  const entries = await resolvedSetups(context, true);
  const selected = selectResolved(entries, args[0]!);
  if (!selected) return usageError(context.io, `Unknown setup "${args[0]}".`);
  const before = await currentDefault(context.dshHome);
  const result = await installResolvedSetups({
    dshHome: context.dshHome,
    setups: entries.map(({ resolved }) => resolved),
    defaultSetupId: selected.resolved.metadata.id,
  });
  if (context.json)
    writeJson(context.io, {
      command: "use",
      previous: before,
      current: selected.key,
      ...result,
    });
  else
    context.io.stdout(
      `Default Agent Setup changed:\n  ${before.replace("oh-my-dsh-", "")} → ${selected.key}\n\nExisting sessions were not modified.\n${warningText(result.warnings)}`,
    );
  return 0;
}

async function doctorCommand(context: StatefulCommandContext): Promise<number> {
  if (context.operands.length > 0)
    return unexpected(context.io, context.operands[0]!, "doctor");
  const report = await doctorDshHome({ dshHome: context.dshHome });
  if (context.json) writeJson(context.io, { command: "doctor", ...report });
  else if (report.ok)
    context.io.stdout(`Healthy: generation ${report.activeGeneration}.\n`);
  else
    context.io.stdout(
      `Unhealthy:\n${report.issues.map((issue) => `  - ${issue}`).join("\n")}\n`,
    );
  return report.ok ? 0 : 1;
}

async function rollbackCommand(
  context: StatefulCommandContext,
): Promise<number> {
  if (context.operands.length > 0)
    return unexpected(context.io, context.operands[0]!, "rollback");
  const result = await rollbackDshHome({ dshHome: context.dshHome });
  if (context.json) writeJson(context.io, { command: "rollback", ...result });
  else
    context.io.stdout(
      `Rolled back to generation ${result.activeGeneration}.\n`,
    );
  return 0;
}

async function builtInUpdateChanges(
  context: StatefulCommandContext,
): Promise<Array<{ id: string; version: string; reason: string }>> {
  let installed: Array<{ id?: unknown; version?: unknown; hash?: unknown }> =
    [];
  try {
    const active = (
      await readRegularFile(
        join(context.dshHome, "oh-my-dsh", "active"),
        1024,
        "active generation marker",
      )
    )
      .toString("utf8")
      .trim();
    const manifest = JSON.parse(
      (
        await readRegularFile(
          join(
            context.dshHome,
            "oh-my-dsh",
            "generations",
            active,
            "manifest.json",
          ),
          1024 * 1024,
          "active generation manifest",
        )
      ).toString("utf8"),
    ) as { setups?: unknown };
    if (!Array.isArray(manifest.setups))
      throw new Error("active generation manifest is invalid");
    installed = manifest.setups;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  return Object.values(context.setups)
    .map((setup) => resolveSetup(setup, context.capabilities))
    .filter((setup) => {
      const previous = installed.find(({ id }) => id === setup.metadata.id);
      return (
        previous === undefined ||
        previous.version !== setup.metadata.version ||
        previous.hash !== setup.hash
      );
    })
    .map((setup) => ({
      id: setup.metadata.id,
      version: setup.metadata.version,
      reason: installed.some(({ id }) => id === setup.metadata.id)
        ? "definition changed"
        : "not installed",
    }));
}

async function updateCommand(context: StatefulCommandContext): Promise<number> {
  const args = [...context.operands];
  const applyIndex = args.indexOf("--apply");
  const shouldApply = applyIndex >= 0;
  if (applyIndex >= 0) args.splice(applyIndex, 1);
  if (args.length > 0) return unexpected(context.io, args[0]!, "update");
  const changes = await builtInUpdateChanges(context);
  if (!shouldApply) {
    if (context.json)
      writeJson(context.io, {
        command: "update",
        version: context.version,
        changes,
        applied: false,
      });
    else if (changes.length === 0)
      context.io.stdout(
        `Built-in setups are current at ${context.version}. No changes applied.\n`,
      );
    else
      context.io.stdout(
        `Built-in setup changes available:\n${changes
          .map(
            (change) => `  ${change.id}@${change.version} — ${change.reason}`,
          )
          .join("\n")}\n\nRun: oh-my-dsh update --apply\n`,
      );
    return 0;
  }
  const result = await applyAll(context, await currentDefault(context.dshHome));
  if (context.json)
    writeJson(context.io, { command: "update", applied: true, ...result });
  else
    context.io.stdout(
      `Applied current built-in setups at ${context.version} (${result.generationId}).\n${warningText(result.warnings)}`,
    );
  return 0;
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("-"))
    throw new Error(`option ${name} requires a value`);
  args.splice(index, 2);
  return value;
}

async function forkAgent(
  context: StatefulCommandContext,
  args: string[],
): Promise<number> {
  const slug = takeOption(args, "--as");
  const name = takeOption(args, "--name");
  if (!slug)
    return usageError(context.io, '"agent fork" requires --as <slug>.');
  if (args.length !== 1)
    return args.length === 0
      ? usageError(context.io, '"agent fork" requires a built-in setup.')
      : unexpected(context.io, args[1]!, "agent fork");
  const created = await createFork(
    context.dshHome,
    args[0]!,
    slug,
    name,
    catalog(context),
  );
  if (context.json)
    writeJson(context.io, {
      command: "agent fork",
      id: created.setup.metadata.id,
      path: created.manifestPath,
      extends: created.setup.extends,
    });
  else
    context.io.stdout(
      `Created ${created.setup.metadata.name}\nBased on: ${created.setup.extends.id}@${created.setup.extends.version}\n\nEditable file:\n  ${created.manifestPath}\n`,
    );
  return 0;
}

async function saveAgent(
  context: StatefulCommandContext,
  args: string[],
): Promise<number> {
  if (args.length !== 1)
    return args.length === 0
      ? usageError(context.io, '"agent save" requires a setup slug.')
      : unexpected(context.io, args[1]!, "agent save");
  const saved = await saveCustomSetup(
    context.dshHome,
    args[0]!,
    catalog(context),
  );
  if (context.json)
    writeJson(context.io, {
      command: "agent save",
      id: saved.setup.metadata.id,
      version: saved.setup.metadata.version,
      hash: saved.resolved.hash,
      lockPath: saved.lockPath,
    });
  else
    context.io.stdout(
      `✓ Schema valid\n✓ No embedded credentials\n✓ No absolute machine paths\n✓ Compatible with DSH rc.5/rc.6\n✓ Saved Agent Setup ${saved.setup.metadata.id}@${saved.setup.metadata.version}\n`,
    );
  return 0;
}

async function writeExclusive(
  path: string,
  contents: Uint8Array,
): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function exportAgent(
  context: StatefulCommandContext,
  args: string[],
): Promise<number> {
  const output = takeOption(args, "--output");
  if (args.length !== 1)
    return args.length === 0
      ? usageError(context.io, '"agent export" requires a setup slug.')
      : unexpected(context.io, args[1]!, "agent export");
  const saved = await saveCustomSetup(
    context.dshHome,
    args[0]!,
    catalog(context),
  );
  const lock: ArchiveLock = {
    setupId: saved.setup.metadata.id,
    setupVersion: saved.setup.metadata.version,
    normalizedHash: computeArchiveSetupHash(saved.setup),
    adapter: { id: "dsh-rc5", version: context.version },
    dshCompatibility: saved.resolved.compatibility.dsh,
    capabilities: saved.resolved.capabilities,
  };
  const path =
    output ?? `${args[0]}-${saved.setup.metadata.version}.omdsh-agent`;
  await writeExclusive(
    path,
    createAgentArchive({ setup: saved.setup, lock, files: [] }),
  );
  if (context.json)
    writeJson(context.io, {
      command: "agent export",
      path,
      id: saved.setup.metadata.id,
      hash: lock.normalizedHash,
      files: [],
    });
  else
    context.io.stdout(
      `Created:\n  ${path}\n\nContains the validated setup definition and lock.\nExcluded: credentials, session history, API keys, absolute paths, and caches.\n`,
    );
  return 0;
}

async function storeImported(
  context: StatefulCommandContext,
  setup: PortableAgentSetup,
  files: readonly { path: string; content: Uint8Array }[],
  lock: unknown,
): Promise<string> {
  if (
    Object.values(context.setups).some(
      (builtIn) => builtIn.metadata.id === setup.metadata.id,
    )
  ) {
    throw new Error(`refusing to replace built-in setup ${setup.metadata.id}`);
  }
  const slug = slugFor(setup);
  const root = (await localAgentsRoot(context.dshHome, true))!;
  const directory = join(root, slug);
  await mkdir(directory, { mode: 0o700 });
  try {
    const lockedFiles = Object.fromEntries(
      files
        .map((file) => [file.path, sha256(file.content)] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    await writeExclusive(
      join(directory, "agent.yaml"),
      Buffer.from(stringify(setup, { lineWidth: 0 }), "utf8"),
    );
    await writeExclusive(
      join(directory, "omdsh.lock"),
      Buffer.from(
        `${JSON.stringify({ ...(lock as object), files: lockedFiles }, null, 2)}\n`,
        "utf8",
      ),
    );
    for (const file of files) {
      const destination = join(directory, "files", ...file.path.split("/"));
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeExclusive(destination, file.content);
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return slug;
}

async function importAgent(
  context: StatefulCommandContext,
  args: string[],
): Promise<number> {
  const yesIndex = args.indexOf("--yes");
  const yes = yesIndex >= 0;
  if (yesIndex >= 0) args.splice(yesIndex, 1);
  if (args.length !== 1)
    return args.length === 0
      ? usageError(context.io, '"agent import" requires an archive path.')
      : unexpected(context.io, args[1]!, "agent import");
  const imported = parseAgentArchive(
    await readRegularFile(
      args[0]!,
      DEFAULT_ARCHIVE_LIMITS.maxInputBytes,
      "agent archive",
    ),
  );
  const candidate: LocalSetup = {
    slug: slugFor(imported.setup),
    setup: imported.setup,
    files: new Map(imported.files.map((file) => [file.path, file.content])),
  };
  const resolved = resolveLocal(candidate, context);
  compilePreset(resolved);
  if (
    imported.lock.adapter.id !== "dsh-rc5" ||
    imported.lock.adapter.version !== context.version
  ) {
    throw new Error(
      `archive requires unsupported adapter ${imported.lock.adapter.id}@${imported.lock.adapter.version}`,
    );
  }
  const lockedCapabilities = imported.lock.capabilities
    .map((capability) => `${capability.id}@${capability.version}`)
    .sort();
  const resolvedCapabilities = resolved.capabilities
    .map((capability) => `${capability.id}@${capability.version}`)
    .sort();
  if (
    JSON.stringify(lockedCapabilities) !== JSON.stringify(resolvedCapabilities)
  )
    throw new Error(
      "archive capability lock does not match the resolved setup",
    );
  const preview = {
    command: "agent import",
    id: imported.setup.metadata.id,
    name: imported.setup.metadata.name,
    version: imported.setup.metadata.version,
    hash: imported.lock.normalizedHash,
    capabilities: imported.lock.capabilities,
    permissions: resolved.permissions,
    ...(imported.setup.kind === "AgentSetupFork"
      ? { extends: imported.setup.extends }
      : {}),
    confirmed: yes,
  };
  if (!yes) {
    if (context.json) writeJson(context.io, preview);
    else
      context.io.stdout(
        `Agent Setup: ${preview.name} ${preview.version}\nPublisher:   unverified local export\nPermissions:\n${Object.entries(
          preview.permissions,
        )
          .map(([key, value]) => `  ${key.padEnd(14)} ${value}`)
          .join(
            "\n",
          )}\n\nNo plugin code has been executed.\nRe-run with --yes to import.\n`,
      );
    return 2;
  }
  const slug = await storeImported(
    context,
    imported.setup,
    imported.files,
    imported.lock,
  );
  if (context.json) writeJson(context.io, { ...preview, slug });
  else
    context.io.stdout(
      `Imported ${imported.setup.metadata.id}@${imported.setup.metadata.version}.\nRun "oh-my-dsh apply" to publish its DSH preset.\n`,
    );
  return 0;
}

async function addAgent(
  context: StatefulCommandContext,
  args: string[],
): Promise<number> {
  const revision = takeOption(args, "--rev");
  if (args.length !== 1 || !revision)
    return usageError(
      context.io,
      '"agent add" requires github:owner/repository/path --rev <full-commit-sha>.',
    );
  if (!FULL_COMMIT.test(revision))
    return operationError(
      context.io,
      "Git source revision must be a full commit SHA (40 lowercase hex characters).",
    );
  const materialized = await materializePinnedGitSource({
    source: args[0]!,
    revision,
    stateRoot: join(context.dshHome, "oh-my-dsh"),
  });
  const definition = parsePortableSetup(
    parse(
      (
        await readRegularFile(
          join(materialized.directory, "agent.yaml"),
          1024 * 1024,
          "agent.yaml",
        )
      ).toString("utf8"),
      { maxAliasCount: 20 },
    ),
  );
  const files = await Promise.all(
    (definition.kind === "AgentSetup" ? declaredFiles(definition) : []).map(
      async (path) => ({
        path,
        content: await readRegularFile(
          join(materialized.directory, ...path.split("/")),
          2 * 1024 * 1024,
          "Git setup asset",
        ),
      }),
    ),
  );
  const local: LocalSetup = {
    slug: slugFor(definition),
    setup: definition,
    files: new Map(files.map((file) => [file.path, file.content])),
  };
  const resolved = resolveLocal(local, context);
  const validationLock: ArchiveLock = {
    setupId: definition.metadata.id,
    setupVersion: definition.metadata.version,
    normalizedHash: computeArchiveSetupHash(definition),
    adapter: { id: "dsh-rc5", version: context.version },
    dshCompatibility: resolved.compatibility.dsh,
    capabilities: resolved.capabilities,
  };
  createAgentArchive({ setup: definition, lock: validationLock, files });
  const sourceLock = {
    type: "git",
    source: materialized.source,
    revision: materialized.revision,
    contentDigest: materialized.contentDigest,
    setupHash: validationLock.normalizedHash,
    adapter: validationLock.adapter,
    capabilities: validationLock.capabilities,
  };
  const slug = await storeImported(context, definition, files, sourceLock);
  if (context.json)
    writeJson(context.io, {
      command: "agent add",
      slug,
      source: materialized.source,
      revision: materialized.revision,
      contentDigest: materialized.contentDigest,
    });
  else
    context.io.stdout(
      `Added ${definition.metadata.id}@${definition.metadata.version} from ${materialized.source}.\nRevision: ${revision}\nContent digest: ${materialized.contentDigest}\n`,
    );
  return 0;
}

async function agentCommand(context: StatefulCommandContext): Promise<number> {
  const [subcommand, ...args] = context.operands;
  if (!subcommand)
    return usageError(
      context.io,
      'The "agent" command requires fork, save, export, import, or add.',
    );
  switch (subcommand) {
    case "fork":
      return forkAgent(context, args);
    case "save":
      return saveAgent(context, args);
    case "export":
      return exportAgent(context, args);
    case "import":
      return importAgent(context, args);
    case "add":
      return addAgent(context, args);
    default:
      return usageError(context.io, `Unknown agent command "${subcommand}".`);
  }
}

export async function runStatefulCommand(
  command: string,
  context: StatefulCommandContext,
): Promise<number | undefined> {
  try {
    switch (command) {
      case "init":
        return await initCommand(context);
      case "apply":
        return await applyCommand(context);
      case "use":
        return await useCommand(context);
      case "doctor":
        return await doctorCommand(context);
      case "rollback":
        return await rollbackCommand(context);
      case "update":
        return await updateCommand(context);
      case "agent":
        return await agentCommand(context);
      default:
        return undefined;
    }
  } catch (error) {
    return operationError(
      context.io,
      messageOf(error, `Command "${command}" failed.`),
    );
  }
}

export async function localResolvedEntries(
  context: StatefulCommandContext,
): Promise<
  Array<{
    key: string;
    resolved: ResolvedSetup;
    delta?: CustomAgentSetup["overrides"];
  }>
> {
  const locals = await readLocalSetups(context.dshHome);
  return locals.map((local) => ({
    key: local.slug,
    resolved: resolveLocal(local, context),
    ...(local.setup.kind === "AgentSetupFork"
      ? { delta: local.setup.overrides }
      : {}),
  }));
}
