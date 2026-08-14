import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { isMap, parseDocument } from "yaml";

import type { ResolvedSetup } from "@oh-my-dsh/core";

import { compilePreset } from "./index.js";

const MANAGED_DIRECTORY = "oh-my-dsh";
const PRESET_DIRECTORY = ".agent-presets";
const PRESET_PREFIX = "oh-my-dsh-";
const GENERATION_SCHEMA_VERSION = 1;
const OPERATION_LOCK = "operation.lock";

export interface ResolveDshHomeOptions {
  explicit?: string;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}

export interface FileMutation {
  operation:
    | "create-directory"
    | "create-generation-stage"
    | "write-generation-file"
    | "commit-generation"
    | "create-publication-stage"
    | "stage-preset-file"
    | "create-publication-backup"
    | "backup-preset"
    | "publish-preset"
    | "remove-stale-preset"
    | "write-settings-temp"
    | "write-settings"
    | "write-previous-marker-temp"
    | "write-previous-marker"
    | "write-active-marker-temp"
    | "write-active-marker";
  path: string;
}

export type MutationObserver = (mutation: FileMutation) => void | Promise<void>;

export interface InstallResolvedSetupsOptions {
  dshHome: string;
  setups: readonly ResolvedSetup[];
  defaultSetupId: string;
  onMutation?: MutationObserver;
}

export interface DshHomeOperationOptions {
  dshHome: string;
  onMutation?: MutationObserver;
}

export interface InstallResult {
  changed: boolean;
  generationId: string;
  generationPath: string;
  presetIds: string[];
  warnings: string[];
  activeGeneration: string;
  previousGeneration?: string;
}

export interface RollbackResult {
  activeGeneration: string;
  previousGeneration: string;
  generationPath: string;
  presetIds: string[];
}

export interface DoctorReport {
  ok: boolean;
  activeGeneration?: string;
  issues: string[];
}

interface GenerationPreset {
  id: string;
  setupId: string;
  files: Record<string, string>;
}

interface GenerationSetup {
  id: string;
  name: string;
  version: string;
  hash: string;
  presetId: string;
  warnings: string[];
}

interface GenerationSeed {
  schemaVersion: number;
  adapter: "dsh-rc5";
  defaultPresetId: string;
  setups: GenerationSetup[];
  presets: GenerationPreset[];
}

interface GenerationManifest extends GenerationSeed {
  generationId: string;
}

interface PreparedGeneration {
  id: string;
  manifest: GenerationManifest;
  files: Map<string, string>;
  checksums: Record<string, string>;
}

interface SettingsPlan {
  path: string;
  before?: string;
  after: string;
  changed: boolean;
  mode?: number;
}

interface ReversibleMutation {
  rollback(): Promise<void>;
  commit(): Promise<void>;
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

export function resolveDshHome(options: ResolveDshHomeOptions = {}): string {
  const explicit = nonBlank(options.explicit);
  if (explicit !== undefined) return explicit;
  const environment = nonBlank((options.env ?? process.env).DSH_HOME);
  if (environment !== undefined) return environment;
  return join(options.homeDirectory ?? homedir(), ".dsh");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function statsIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function notify(
  observer: MutationObserver | undefined,
  operation: FileMutation["operation"],
  path: string,
): Promise<void> {
  await observer?.({ operation, path });
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function portableSegments(path: string): string[] | undefined {
  if (path.length === 0 || path.includes("\\") || path.startsWith("/"))
    return undefined;
  const segments = path.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  )
    ? segments
    : undefined;
}

function generationPaths(dshHome: string): {
  managedRoot: string;
  generationsRoot: string;
} {
  const managedRoot = join(dshHome, MANAGED_DIRECTORY);
  return { managedRoot, generationsRoot: join(managedRoot, "generations") };
}

async function preflightManagedRoots(dshHome: string): Promise<void> {
  const { managedRoot, generationsRoot } = generationPaths(dshHome);
  for (const [label, path] of [
    ["managed root", managedRoot],
    ["generations root", generationsRoot],
  ] as const) {
    const stats = await statsIfPresent(path);
    if (stats?.isSymbolicLink())
      throw new Error(`refusing ${label} symbolic link: ${path}`);
    if (stats !== undefined && !stats.isDirectory())
      throw new Error(`${label} is not a directory: ${path}`);
  }
}

interface HeldOperationLock {
  recovered: boolean;
  release(): Promise<void>;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireOperationLock(
  dshHome: string,
): Promise<HeldOperationLock> {
  await preflightManagedRoots(dshHome);
  const { managedRoot } = generationPaths(dshHome);
  await mkdir(managedRoot, { recursive: true, mode: 0o700 });
  const lockPath = join(managedRoot, OPERATION_LOCK);
  let recovered = false;
  const existing = await statsIfPresent(lockPath);
  if (existing !== undefined) {
    if (existing.isSymbolicLink() || !existing.isFile())
      throw new Error("operation lock is not a regular file");
    let owner: unknown;
    try {
      owner = JSON.parse(await readFile(lockPath, "utf8")) as unknown;
    } catch {
      throw new Error(
        "operation lock is invalid; remove it after verifying no operation is running",
      );
    }
    const pid =
      typeof owner === "object" && owner !== null && "pid" in owner
        ? (owner as { pid?: unknown }).pid
        : undefined;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
      throw new Error(
        "operation lock is invalid; remove it after verifying no operation is running",
      );
    if (processIsAlive(pid))
      throw new Error(`another oh-my-dsh operation is running (pid ${pid})`);
    await rm(lockPath);
    recovered = true;
  }

  const token = randomUUID();
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(json({ pid: process.pid, token }), "utf8");
    await handle.sync();
  } catch (error) {
    await handle?.close();
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("another oh-my-dsh operation is running");
    throw error;
  }
  await handle.close();
  return {
    recovered,
    release: async () => {
      try {
        const current = JSON.parse(await readFile(lockPath, "utf8")) as {
          token?: unknown;
        };
        if (current.token === token) await rm(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

function prepareGeneration(
  setups: readonly ResolvedSetup[],
  defaultSetupId: string,
): PreparedGeneration {
  if (setups.length === 0)
    throw new Error("at least one resolved setup is required");

  const compiled = setups
    .map((setup) => ({ setup, compiled: compilePreset(setup) }))
    .sort((left, right) => left.compiled.id.localeCompare(right.compiled.id));
  const duplicate = compiled.find(
    (entry, index) => entry.compiled.id === compiled[index - 1]?.compiled.id,
  );
  if (duplicate)
    throw new Error(`duplicate compiled preset id: ${duplicate.compiled.id}`);

  const defaultMatches = compiled.filter(({ setup, compiled: preset }) => {
    const leaf = setup.metadata.id.split(".").at(-1);
    return (
      defaultSetupId === setup.metadata.id ||
      defaultSetupId === preset.id ||
      defaultSetupId === leaf
    );
  });
  if (defaultMatches.length !== 1)
    throw new Error(
      `default setup is not installed or is ambiguous: ${defaultSetupId}`,
    );
  const defaultPresetId = defaultMatches[0]!.compiled.id;

  const files = new Map<string, string>();
  const presets: GenerationPreset[] = [];
  const generationSetups: GenerationSetup[] = [];
  for (const { setup, compiled: preset } of compiled) {
    const presetFiles: Record<string, string> = {};
    for (const filename of Object.keys(preset.files).sort()) {
      const content = preset.files[filename as keyof typeof preset.files];
      const path = `presets/${preset.id}/${filename}`;
      files.set(path, content);
      presetFiles[filename] = sha256(content);
    }
    presets.push({
      id: preset.id,
      setupId: setup.metadata.id,
      files: presetFiles,
    });
    generationSetups.push({
      id: setup.metadata.id,
      name: setup.metadata.name,
      version: setup.metadata.version,
      hash: setup.hash,
      presetId: preset.id,
      warnings: [...preset.warnings].sort(),
    });
  }

  const seed: GenerationSeed = {
    schemaVersion: GENERATION_SCHEMA_VERSION,
    adapter: "dsh-rc5",
    defaultPresetId,
    setups: generationSetups,
    presets,
  };
  const id = sha256(canonicalize(seed));
  const manifest: GenerationManifest = { ...seed, generationId: id };
  const manifestText = json(manifest);
  files.set("manifest.json", manifestText);

  const checksums: Record<string, string> = {};
  for (const [path, content] of [...files].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    checksums[path] = sha256(content);
  }
  return { id, manifest, files, checksums };
}

async function writePreparedGeneration(
  dshHome: string,
  prepared: PreparedGeneration,
  observer: MutationObserver | undefined,
): Promise<string> {
  const { generationsRoot } = generationPaths(dshHome);
  const target = join(generationsRoot, prepared.id);
  const targetStats = await statsIfPresent(target);
  if (targetStats !== undefined) {
    if (targetStats.isSymbolicLink() || !targetStats.isDirectory())
      throw new Error(
        `generation target is not a regular directory: ${target}`,
      );
    await requireValidGeneration(target, prepared.id);
    return target;
  }

  if ((await statsIfPresent(generationsRoot)) === undefined) {
    await notify(observer, "create-directory", generationsRoot);
    await mkdir(generationsRoot, { recursive: true });
  }
  const stage = join(generationsRoot, `.tmp-${prepared.id}-${randomUUID()}`);
  try {
    await notify(observer, "create-generation-stage", stage);
    await mkdir(stage);
    const directories = new Set<string>();
    for (const path of [...prepared.files.keys(), "checksums.json"])
      directories.add(dirname(path));
    for (const directory of [...directories]
      .filter((path) => path !== ".")
      .sort()) {
      const destination = join(stage, ...directory.split("/"));
      await notify(observer, "create-directory", destination);
      await mkdir(destination, { recursive: true });
    }
    for (const [path, content] of [...prepared.files].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const destination = join(stage, ...path.split("/"));
      await notify(observer, "write-generation-file", destination);
      await writeFile(destination, content, { encoding: "utf8", mode: 0o600 });
    }
    const checksumsPath = join(stage, "checksums.json");
    await notify(observer, "write-generation-file", checksumsPath);
    await writeFile(checksumsPath, json(prepared.checksums), {
      encoding: "utf8",
      mode: 0o600,
    });
    await notify(observer, "commit-generation", target);
    await rename(stage, target);
  } catch (error) {
    await rm(stage, { force: true, recursive: true });
    if (
      isNodeError(error) &&
      (error.code === "EEXIST" || error.code === "ENOTEMPTY")
    ) {
      await requireValidGeneration(target, prepared.id);
      return target;
    }
    throw error;
  }
  return target;
}

function parseManifest(source: string): GenerationManifest {
  const value = JSON.parse(source) as unknown;
  if (value === null || typeof value !== "object")
    throw new Error("manifest is not an object");
  const manifest = value as Partial<GenerationManifest>;
  if (
    manifest.schemaVersion !== GENERATION_SCHEMA_VERSION ||
    manifest.adapter !== "dsh-rc5" ||
    typeof manifest.generationId !== "string" ||
    typeof manifest.defaultPresetId !== "string" ||
    !Array.isArray(manifest.presets) ||
    !Array.isArray(manifest.setups)
  ) {
    throw new Error("manifest has an unsupported shape");
  }
  for (const preset of manifest.presets) {
    if (
      preset === null ||
      typeof preset !== "object" ||
      typeof (preset as GenerationPreset).id !== "string" ||
      !(preset as GenerationPreset).id.startsWith(PRESET_PREFIX) ||
      (preset as GenerationPreset).files === null ||
      typeof (preset as GenerationPreset).files !== "object"
    ) {
      throw new Error("manifest contains an invalid preset");
    }
  }
  return manifest as GenerationManifest;
}

function parseChecksums(source: string): Record<string, string> {
  const value = JSON.parse(source) as unknown;
  if (value === null || Array.isArray(value) || typeof value !== "object")
    throw new Error("checksums are not an object");
  const result: Record<string, string> = {};
  for (const [path, checksum] of Object.entries(value)) {
    if (
      portableSegments(path) === undefined ||
      typeof checksum !== "string" ||
      !/^[a-f0-9]{64}$/.test(checksum)
    ) {
      throw new Error(`invalid checksum entry: ${path}`);
    }
    result[path] = checksum;
  }
  return result;
}

async function inspectGeneration(
  generationPath: string,
  expectedId?: string,
): Promise<{
  manifest?: GenerationManifest;
  checksums?: Record<string, string>;
  issues: string[];
}> {
  const issues: string[] = [];
  const generationStats = await statsIfPresent(generationPath);
  if (generationStats === undefined)
    return { issues: ["generation directory is missing"] };
  if (generationStats.isSymbolicLink() || !generationStats.isDirectory())
    return { issues: ["generation path is not a regular directory"] };
  let manifest: GenerationManifest | undefined;
  let checksums: Record<string, string> | undefined;
  try {
    manifest = parseManifest(
      await readFile(join(generationPath, "manifest.json"), "utf8"),
    );
  } catch (error) {
    issues.push(
      `invalid generation manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    checksums = parseChecksums(
      await readFile(join(generationPath, "checksums.json"), "utf8"),
    );
  } catch (error) {
    issues.push(
      `invalid generation checksums: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (manifest !== undefined) {
    if (expectedId !== undefined && manifest.generationId !== expectedId) {
      issues.push(
        `generation id mismatch: expected ${expectedId}, found ${manifest.generationId}`,
      );
    }
    const { generationId: ignored, ...seed } = manifest;
    void ignored;
    const derivedId = sha256(canonicalize(seed));
    if (derivedId !== manifest.generationId)
      issues.push(
        `generation manifest digest mismatch: ${manifest.generationId}`,
      );
  }

  if (manifest !== undefined && checksums !== undefined) {
    const expectedPaths = new Set<string>(["manifest.json"]);
    for (const preset of manifest.presets) {
      for (const filename of Object.keys(preset.files))
        expectedPaths.add(`presets/${preset.id}/${filename}`);
    }
    for (const expected of expectedPaths) {
      if (!(expected in checksums))
        issues.push(`checksum entry missing: ${expected}`);
    }
    for (const actual of Object.keys(checksums)) {
      if (!expectedPaths.has(actual))
        issues.push(`unexpected checksum entry: ${actual}`);
    }
  }

  if (checksums !== undefined) {
    for (const [relativePath, expected] of Object.entries(checksums).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      const segments = portableSegments(relativePath);
      if (segments === undefined) continue;
      const path = join(generationPath, ...segments);
      const fileStats = await statsIfPresent(path);
      if (fileStats === undefined) {
        issues.push(`checksum file missing: ${relativePath}`);
      } else if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
        issues.push(`checksum file is not a regular file: ${relativePath}`);
      } else if (sha256(await readFile(path, "utf8")) !== expected) {
        issues.push(`checksum mismatch: ${relativePath}`);
      }
    }
  }
  return {
    ...(manifest === undefined ? {} : { manifest }),
    ...(checksums === undefined ? {} : { checksums }),
    issues,
  };
}

async function requireValidGeneration(
  generationPath: string,
  expectedId?: string,
): Promise<{
  manifest: GenerationManifest;
  checksums: Record<string, string>;
}> {
  const inspection = await inspectGeneration(generationPath, expectedId);
  if (
    inspection.issues.length > 0 ||
    inspection.manifest === undefined ||
    inspection.checksums === undefined
  ) {
    throw new Error(
      `invalid generation ${basename(generationPath)}: ${inspection.issues.join("; ")}`,
    );
  }
  return { manifest: inspection.manifest, checksums: inspection.checksums };
}

async function preflightSettings(
  dshHome: string,
  defaultPresetId: string,
): Promise<SettingsPlan> {
  const path = join(dshHome, "settings.yaml");
  const lockPath = `${path}.lock`;
  if ((await statsIfPresent(lockPath)) !== undefined)
    throw new Error(`refusing to edit settings because ${lockPath} exists`);
  const fileStats = await statsIfPresent(path);
  if (fileStats?.isSymbolicLink())
    throw new Error(
      `refusing to edit settings.yaml because it is a symbolic link`,
    );
  if (fileStats !== undefined && !fileStats.isFile())
    throw new Error(
      "refusing to edit settings.yaml because it is not a regular file",
    );
  if (fileStats !== undefined && fileStats.size > 1024 * 1024)
    throw new Error("refusing to edit settings.yaml because it exceeds 1 MiB");

  const before =
    fileStats === undefined ? undefined : await readFile(path, "utf8");
  const document = parseDocument(before ?? "{}\n", {
    prettyErrors: false,
    strict: true,
  });
  if (document.errors.length > 0)
    throw new Error(
      `cannot parse settings.yaml: ${document.errors[0]!.message}`,
    );
  if (document.contents !== null && !isMap(document.contents))
    throw new Error("cannot edit settings.yaml because its root is not a map");
  const presets = document.get("agent-presets", true);
  if (presets !== undefined && presets !== null && !isMap(presets)) {
    throw new Error(
      "cannot edit settings.yaml because agent-presets is not a map",
    );
  }
  if (document.getIn(["agent-presets", "default"]) === defaultPresetId) {
    return {
      path,
      ...(before === undefined ? {} : { before }),
      after: before ?? "",
      changed: false,
      ...(fileStats === undefined ? {} : { mode: fileStats.mode & 0o777 }),
    };
  }
  document.setIn(["agent-presets", "default"], defaultPresetId);
  return {
    path,
    ...(before === undefined ? {} : { before }),
    after: document.toString({ lineWidth: 0 }),
    changed: true,
    ...(fileStats === undefined ? {} : { mode: fileStats.mode & 0o777 }),
  };
}

async function writeAtomic(
  path: string,
  content: string,
  tempOperation: FileMutation["operation"],
  commitOperation: FileMutation["operation"],
  observer: MutationObserver | undefined,
  mode = 0o600,
): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.tmp-${randomUUID()}`);
  try {
    await notify(observer, tempOperation, temp);
    await writeFile(temp, content, { encoding: "utf8", mode });
    await notify(observer, commitOperation, path);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function restoreFile(
  path: string,
  content: string | undefined,
  mode = 0o600,
): Promise<void> {
  if (content === undefined) {
    await rm(path, { force: true });
    return;
  }
  const temp = join(
    dirname(path),
    `.${basename(path)}.rollback-${randomUUID()}`,
  );
  try {
    await writeFile(temp, content, { encoding: "utf8", mode });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

async function applySettings(
  plan: SettingsPlan,
  observer: MutationObserver | undefined,
): Promise<ReversibleMutation> {
  if (!plan.changed)
    return { rollback: async () => undefined, commit: async () => undefined };
  const lockPath = `${plan.path}.lock`;
  if ((await statsIfPresent(lockPath)) !== undefined)
    throw new Error(`refusing to edit settings because ${lockPath} exists`);
  const currentStats = await statsIfPresent(plan.path);
  if (
    currentStats?.isSymbolicLink() ||
    (currentStats && !currentStats.isFile())
  )
    throw new Error("settings.yaml changed to an unsafe file during apply");
  if (currentStats !== undefined && currentStats.size > 1024 * 1024)
    throw new Error("settings.yaml grew beyond 1 MiB during apply");
  const current =
    currentStats === undefined ? undefined : await readFile(plan.path, "utf8");
  if (current !== plan.before)
    throw new Error("settings.yaml changed concurrently during apply");
  await writeAtomic(
    plan.path,
    plan.after,
    "write-settings-temp",
    "write-settings",
    observer,
    plan.mode,
  );
  return {
    rollback: async () => restoreFile(plan.path, plan.before, plan.mode),
    commit: async () => undefined,
  };
}

async function copyPresetToStage(
  generationPath: string,
  preset: GenerationPreset,
  stageRoot: string,
  observer: MutationObserver | undefined,
): Promise<void> {
  const destinationRoot = join(stageRoot, preset.id);
  await notify(observer, "create-directory", destinationRoot);
  await mkdir(destinationRoot);
  for (const filename of Object.keys(preset.files).sort()) {
    const segments = portableSegments(filename);
    if (segments === undefined || segments.length !== 1)
      throw new Error(`invalid preset filename: ${filename}`);
    const source = join(generationPath, "presets", preset.id, filename);
    const destination = join(destinationRoot, filename);
    const sourceStats = await statsIfPresent(source);
    if (
      sourceStats === undefined ||
      sourceStats.isSymbolicLink() ||
      !sourceStats.isFile()
    ) {
      throw new Error(
        `generation preset file is not regular: ${preset.id}/${filename}`,
      );
    }
    await notify(observer, "stage-preset-file", destination);
    await writeFile(destination, await readFile(source), { mode: 0o600 });
  }
}

async function publishGeneration(
  dshHome: string,
  generationPath: string,
  manifest: GenerationManifest,
  observer: MutationObserver | undefined,
): Promise<ReversibleMutation> {
  const presetRoot = join(dshHome, PRESET_DIRECTORY);
  const rootStats = await statsIfPresent(presetRoot);
  if (rootStats?.isSymbolicLink())
    throw new Error(`refusing to publish through symbolic link: ${presetRoot}`);
  if (rootStats !== undefined && !rootStats.isDirectory())
    throw new Error(`preset root is not a directory: ${presetRoot}`);
  if (rootStats === undefined) {
    await notify(observer, "create-directory", presetRoot);
    await mkdir(presetRoot, { recursive: true });
  }

  const transaction = randomUUID();
  const stageRoot = join(presetRoot, `.oh-my-dsh-stage-${transaction}`);
  const backupRoot = join(presetRoot, `.oh-my-dsh-backup-${transaction}`);
  const movedOld: Array<{ target: string; backup: string }> = [];
  const installed: string[] = [];
  let finished = false;

  const rollback = async (): Promise<void> => {
    if (finished) return;
    for (const target of [...installed].reverse())
      await rm(target, { force: true, recursive: true });
    for (const { target, backup } of [...movedOld].reverse()) {
      await rm(target, { force: true, recursive: true });
      if ((await statsIfPresent(backup)) !== undefined)
        await rename(backup, target);
    }
    await rm(stageRoot, { force: true, recursive: true });
    await rm(backupRoot, { force: true, recursive: true });
    finished = true;
  };

  try {
    await notify(observer, "create-publication-stage", stageRoot);
    await mkdir(stageRoot);
    for (const preset of manifest.presets)
      await copyPresetToStage(generationPath, preset, stageRoot, observer);
    await notify(observer, "create-publication-backup", backupRoot);
    await mkdir(backupRoot);

    const desired = new Set(manifest.presets.map((preset) => preset.id));
    const existing = (await readdir(presetRoot, { withFileTypes: true }))
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(PRESET_PREFIX) && !name.startsWith("."))
      .sort();

    for (const preset of manifest.presets) {
      const target = join(presetRoot, preset.id);
      const backup = join(backupRoot, preset.id);
      if ((await statsIfPresent(target)) !== undefined) {
        await notify(observer, "backup-preset", target);
        await rename(target, backup);
        movedOld.push({ target, backup });
      }
      await notify(observer, "publish-preset", target);
      await rename(join(stageRoot, preset.id), target);
      installed.push(target);
    }
    for (const name of existing.filter((entry) => !desired.has(entry))) {
      const target = join(presetRoot, name);
      const backup = join(backupRoot, name);
      await notify(observer, "remove-stale-preset", target);
      await rename(target, backup);
      movedOld.push({ target, backup });
    }
  } catch (error) {
    await rollback();
    throw error;
  }

  return {
    rollback,
    commit: async () => {
      if (finished) return;
      await rm(stageRoot, { force: true, recursive: true });
      await rm(backupRoot, { force: true, recursive: true });
      finished = true;
    },
  };
}

async function inspectPublishedPresets(
  dshHome: string,
  generationPath: string,
  manifest: GenerationManifest,
  checksums: Record<string, string>,
): Promise<string[]> {
  const issues: string[] = [];
  const presetRoot = join(dshHome, PRESET_DIRECTORY);
  const rootStats = await statsIfPresent(presetRoot);
  if (rootStats === undefined) return ["managed preset root is missing"];
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory())
    return ["managed preset root is not a regular directory"];

  const desired = new Set(manifest.presets.map((preset) => preset.id));
  const existing = (await readdir(presetRoot, { withFileTypes: true }))
    .map((entry) => entry.name)
    .filter((name) => name.startsWith(PRESET_PREFIX) && !name.startsWith("."));
  for (const unexpected of existing
    .filter((name) => !desired.has(name))
    .sort()) {
    issues.push(`unexpected managed preset: ${unexpected}`);
  }
  for (const preset of manifest.presets) {
    for (const filename of Object.keys(preset.files).sort()) {
      const relative = `presets/${preset.id}/${filename}`;
      const expected = checksums[relative];
      const published = join(presetRoot, preset.id, filename);
      const publishedStats = await statsIfPresent(published);
      if (publishedStats === undefined) {
        issues.push(`managed preset missing: ${preset.id}/${filename}`);
      } else if (publishedStats.isSymbolicLink() || !publishedStats.isFile()) {
        issues.push(
          `managed preset is not a regular file: ${preset.id}/${filename}`,
        );
      } else if (
        expected === undefined ||
        sha256(await readFile(published, "utf8")) !== expected
      ) {
        issues.push(`managed preset mismatch: ${preset.id}/${filename}`);
      }
    }
  }
  void generationPath;
  return issues;
}

async function readMarker(path: string): Promise<string | undefined> {
  const stats = await statsIfPresent(path);
  if (stats === undefined) return undefined;
  if (stats.isSymbolicLink())
    throw new Error(`refusing ${basename(path)} marker symbolic link`);
  if (!stats.isFile())
    throw new Error(`${basename(path)} marker is not a regular file`);
  return readFile(path, "utf8");
}

async function marker(path: string): Promise<string | undefined> {
  const source = await readMarker(path);
  const value = source?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

async function updateMarkers(
  managedRoot: string,
  activeGeneration: string,
  previousGeneration: string | undefined,
  observer: MutationObserver | undefined,
): Promise<ReversibleMutation> {
  const activePath = join(managedRoot, "active");
  const previousPath = join(managedRoot, "previous");
  const activeBefore = await readMarker(activePath);
  const previousBefore = await readMarker(previousPath);
  const activeValue = `${activeGeneration}\n`;
  const previousValue =
    previousGeneration === undefined ? undefined : `${previousGeneration}\n`;

  try {
    if (previousValue !== undefined && previousValue !== previousBefore) {
      await writeAtomic(
        previousPath,
        previousValue,
        "write-previous-marker-temp",
        "write-previous-marker",
        observer,
      );
    }
    if (activeValue !== activeBefore) {
      await writeAtomic(
        activePath,
        activeValue,
        "write-active-marker-temp",
        "write-active-marker",
        observer,
      );
    }
  } catch (error) {
    await restoreFile(previousPath, previousBefore);
    await restoreFile(activePath, activeBefore);
    throw error;
  }
  return {
    rollback: async () => {
      await restoreFile(previousPath, previousBefore);
      await restoreFile(activePath, activeBefore);
    },
    commit: async () => undefined,
  };
}

async function activateGeneration(
  dshHome: string,
  generationPath: string,
  manifest: GenerationManifest,
  currentActive: string | undefined,
  observer: MutationObserver | undefined,
): Promise<void> {
  const settingsPlan = await preflightSettings(
    dshHome,
    manifest.defaultPresetId,
  );
  let publication: ReversibleMutation | undefined;
  let settings: ReversibleMutation | undefined;
  let markers: ReversibleMutation | undefined;
  try {
    publication = await publishGeneration(
      dshHome,
      generationPath,
      manifest,
      observer,
    );
    settings = await applySettings(settingsPlan, observer);
    const previous =
      currentActive === manifest.generationId ? undefined : currentActive;
    markers = await updateMarkers(
      generationPaths(dshHome).managedRoot,
      manifest.generationId,
      previous,
      observer,
    );
    await markers.commit();
    await settings.commit();
    await publication.commit();
  } catch (error) {
    await markers?.rollback();
    await settings?.rollback();
    await publication?.rollback();
    throw error;
  }
}

async function recoverInterruptedOperation(dshHome: string): Promise<void> {
  const { managedRoot, generationsRoot } = generationPaths(dshHome);
  const active = await marker(join(managedRoot, "active"));
  if (active !== undefined) {
    const generationPath = join(generationsRoot, active);
    const verified = await requireValidGeneration(generationPath, active);
    await activateGeneration(
      dshHome,
      generationPath,
      verified.manifest,
      active,
      undefined,
    );
  }
  const presetRoot = join(dshHome, PRESET_DIRECTORY);
  const presetStats = await statsIfPresent(presetRoot);
  if (presetStats === undefined) return;
  if (presetStats.isSymbolicLink() || !presetStats.isDirectory())
    throw new Error("cannot recover through an unsafe preset root");
  for (const entry of await readdir(presetRoot, { withFileTypes: true })) {
    if (
      entry.name.startsWith(".oh-my-dsh-stage-") ||
      entry.name.startsWith(".oh-my-dsh-backup-")
    ) {
      await rm(join(presetRoot, entry.name), { recursive: true, force: true });
    }
  }
}

async function installResolvedSetupsUnlocked(
  options: InstallResolvedSetupsOptions,
): Promise<InstallResult> {
  await preflightManagedRoots(options.dshHome);
  const prepared = prepareGeneration(options.setups, options.defaultSetupId);
  const { managedRoot, generationsRoot } = generationPaths(options.dshHome);
  const generationPath = join(generationsRoot, prepared.id);
  const settingsPlan = await preflightSettings(
    options.dshHome,
    prepared.manifest.defaultPresetId,
  );
  const currentActive = await marker(join(managedRoot, "active"));
  await marker(join(managedRoot, "previous"));
  const existingGeneration = await statsIfPresent(generationPath);

  if (existingGeneration !== undefined) {
    if (
      existingGeneration.isSymbolicLink() ||
      !existingGeneration.isDirectory()
    )
      throw new Error(
        `generation target is not a regular directory: ${generationPath}`,
      );
    const verified = await requireValidGeneration(generationPath, prepared.id);
    if (currentActive === prepared.id && !settingsPlan.changed) {
      const publicationIssues = await inspectPublishedPresets(
        options.dshHome,
        generationPath,
        verified.manifest,
        verified.checksums,
      );
      if (publicationIssues.length === 0) {
        const previous = await marker(join(managedRoot, "previous"));
        return {
          changed: false,
          generationId: prepared.id,
          generationPath,
          presetIds: prepared.manifest.presets.map((preset) => preset.id),
          warnings: prepared.manifest.setups.flatMap((setup) => setup.warnings),
          activeGeneration: prepared.id,
          ...(previous === undefined ? {} : { previousGeneration: previous }),
        };
      }
    }
  } else {
    await writePreparedGeneration(
      options.dshHome,
      prepared,
      options.onMutation,
    );
  }

  await activateGeneration(
    options.dshHome,
    generationPath,
    prepared.manifest,
    currentActive,
    options.onMutation,
  );
  return {
    changed: true,
    generationId: prepared.id,
    generationPath,
    presetIds: prepared.manifest.presets.map((preset) => preset.id),
    warnings: prepared.manifest.setups.flatMap((setup) => setup.warnings),
    activeGeneration: prepared.id,
    ...(currentActive === undefined || currentActive === prepared.id
      ? {}
      : { previousGeneration: currentActive }),
  };
}

export async function installResolvedSetups(
  options: InstallResolvedSetupsOptions,
): Promise<InstallResult> {
  const lock = await acquireOperationLock(options.dshHome);
  try {
    if (lock.recovered) await recoverInterruptedOperation(options.dshHome);
    return await installResolvedSetupsUnlocked(options);
  } finally {
    await lock.release();
  }
}

async function rollbackDshHomeUnlocked(
  options: DshHomeOperationOptions,
): Promise<RollbackResult> {
  await preflightManagedRoots(options.dshHome);
  const { managedRoot, generationsRoot } = generationPaths(options.dshHome);
  const active = await marker(join(managedRoot, "active"));
  const previous = await marker(join(managedRoot, "previous"));
  if (active === undefined)
    throw new Error("cannot roll back: there is no active generation");
  if (previous === undefined)
    throw new Error("cannot roll back: there is no previous generation");
  if (active === previous)
    throw new Error(
      "cannot roll back: active and previous generations are identical",
    );

  const generationPath = join(generationsRoot, previous);
  const verified = await requireValidGeneration(generationPath, previous);
  await preflightSettings(options.dshHome, verified.manifest.defaultPresetId);
  await activateGeneration(
    options.dshHome,
    generationPath,
    verified.manifest,
    active,
    options.onMutation,
  );
  return {
    activeGeneration: previous,
    previousGeneration: active,
    generationPath,
    presetIds: verified.manifest.presets.map((preset) => preset.id),
  };
}

export async function rollbackDshHome(
  options: DshHomeOperationOptions,
): Promise<RollbackResult> {
  const lock = await acquireOperationLock(options.dshHome);
  try {
    if (lock.recovered) await recoverInterruptedOperation(options.dshHome);
    return await rollbackDshHomeUnlocked(options);
  } finally {
    await lock.release();
  }
}

export async function doctorDshHome(
  options: Pick<DshHomeOperationOptions, "dshHome">,
): Promise<DoctorReport> {
  try {
    await preflightManagedRoots(options.dshHome);
  } catch (error) {
    return {
      ok: false,
      issues: [error instanceof Error ? error.message : "invalid managed root"],
    };
  }
  const { managedRoot, generationsRoot } = generationPaths(options.dshHome);
  let active: string | undefined;
  try {
    active = await marker(join(managedRoot, "active"));
  } catch (error) {
    return {
      ok: false,
      issues: [
        error instanceof Error ? error.message : "invalid active marker",
      ],
    };
  }
  if (active === undefined)
    return { ok: false, issues: ["active generation marker is missing"] };
  const generationPath = join(generationsRoot, active);
  const inspection = await inspectGeneration(generationPath, active);
  const issues = [...inspection.issues];
  if (inspection.manifest !== undefined && inspection.checksums !== undefined) {
    issues.push(
      ...(await inspectPublishedPresets(
        options.dshHome,
        generationPath,
        inspection.manifest,
        inspection.checksums,
      )),
    );
  }
  return { ok: issues.length === 0, activeGeneration: active, issues };
}
