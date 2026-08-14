import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";

import { parse, stringify } from "yaml";

import {
  CustomAgentSetupSchema,
  type AgentSetup,
  type CapabilityPack,
  type CustomAgentSetup,
} from "@oh-my-dsh/schema";

import { resolveCustomSetup, type ResolvedSetup } from "./index.js";
import { validatePortableAgentSetup } from "./archive.js";

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export interface SetupCatalog {
  setups: Record<string, AgentSetup>;
  capabilities: readonly CapabilityPack[];
}

export interface SavedCustomSetup {
  manifestPath: string;
  lockPath: string;
  setup: CustomAgentSetup;
  resolved: ResolvedSetup;
}

function agentsRoot(dshHome: string): string {
  return join(dshHome, "oh-my-dsh", "agents");
}

function setupDirectory(dshHome: string, slug: string): string {
  assertSlug(slug);
  return join(agentsRoot(dshHome), slug);
}

function assertSlug(slug: string): void {
  if (!SLUG.test(slug)) throw new Error(`invalid setup slug: ${slug}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ensureAgentsRoot(dshHome: string): Promise<string> {
  const managedRoot = join(dshHome, "oh-my-dsh");
  for (const [label, path] of [
    ["managed root", managedRoot],
    ["agents root", agentsRoot(dshHome)],
  ] as const) {
    if (await exists(path)) {
      const stats = await lstat(path);
      if (stats.isSymbolicLink() || !stats.isDirectory())
        throw new Error(`${label} is not a regular directory: ${path}`);
    } else {
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
  }
  return agentsRoot(dshHome);
}

async function validateAgentsRoot(dshHome: string): Promise<boolean> {
  for (const [label, path] of [
    ["managed root", join(dshHome, "oh-my-dsh")],
    ["agents root", agentsRoot(dshHome)],
  ] as const) {
    if (!(await exists(path))) return false;
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory())
      throw new Error(`${label} is not a regular directory: ${path}`);
  }
  return true;
}

async function readSetupFile(path: string): Promise<string> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile())
      throw new Error(`refusing non-regular setup file: ${path}`);
    if (stats.size > 1024 * 1024)
      throw new Error(`setup file exceeds 1 MiB: ${path}`);
    return (await handle.readFile()).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  if (await exists(path)) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`refusing to replace non-regular file: ${path}`);
  }
  const temporary = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function parentByKey(catalog: SetupCatalog, key: string): AgentSetup {
  const parent = catalog.setups[key];
  if (!parent) throw new Error(`unknown built-in setup: ${key}`);
  return parent;
}

function parentById(catalog: SetupCatalog, id: string): AgentSetup {
  const parent = Object.values(catalog.setups).find(
    (setup) => setup.metadata.id === id,
  );
  if (!parent) throw new Error(`unknown fork parent: ${id}`);
  return parent;
}

export async function createFork(
  dshHome: string,
  parentKey: string,
  slug: string,
  name: string | undefined,
  catalog: SetupCatalog,
): Promise<{
  directory: string;
  manifestPath: string;
  setup: CustomAgentSetup;
}> {
  assertSlug(slug);
  const parent = parentByKey(catalog, parentKey);
  await ensureAgentsRoot(dshHome);
  const directory = setupDirectory(dshHome, slug);
  if (await exists(directory))
    throw new Error(`custom setup already exists: ${slug}`);
  await mkdir(directory, { mode: 0o700 });

  const setup = CustomAgentSetupSchema.parse({
    apiVersion: "omdsh.dev/v1alpha1",
    kind: "AgentSetupFork",
    metadata: {
      id: `local.${slug}`,
      name: name ?? parent.metadata.name,
      version: "0.1.0",
      license: parent.metadata.license,
    },
    extends: { id: parent.metadata.id, version: parent.metadata.version },
    overrides: {
      instructions: { append: [] },
      workflows: { enable: [], disable: [] },
      permissions: { brokerage: "deny" },
    },
  });
  const manifestPath = join(directory, "agent.yaml");
  const handle = await open(manifestPath, "wx", 0o600);
  try {
    await handle.writeFile(stringify(setup, { lineWidth: 0 }), "utf8");
  } finally {
    await handle.close();
  }
  return { directory, manifestPath, setup };
}

export async function loadCustomSetup(
  dshHome: string,
  slug: string,
): Promise<CustomAgentSetup> {
  if (!(await validateAgentsRoot(dshHome)))
    throw new Error(`custom setup does not exist: ${slug}`);
  const directory = setupDirectory(dshHome, slug);
  const directoryStats = await lstat(directory);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory())
    throw new Error(`setup directory is not a regular directory: ${directory}`);
  const path = join(directory, "agent.yaml");
  return CustomAgentSetupSchema.parse(
    parse(await readSetupFile(path), { maxAliasCount: 20 }),
  );
}

export async function listCustomSetups(
  dshHome: string,
): Promise<CustomAgentSetup[]> {
  if (!(await validateAgentsRoot(dshHome))) return [];
  let entries;
  try {
    entries = await readdir(agentsRoot(dshHome), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const setups: CustomAgentSetup[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory() || !SLUG.test(entry.name)) continue;
    setups.push(await loadCustomSetup(dshHome, entry.name));
  }
  return setups;
}

export async function saveCustomSetup(
  dshHome: string,
  slug: string,
  catalog: SetupCatalog,
): Promise<SavedCustomSetup> {
  const setup = await loadCustomSetup(dshHome, slug);
  validatePortableAgentSetup(setup);
  const parent = parentById(catalog, setup.extends.id);
  const resolved = resolveCustomSetup(setup, parent, catalog.capabilities);
  const directory = setupDirectory(dshHome, slug);
  const manifestPath = join(directory, "agent.yaml");
  const lockPath = join(directory, "omdsh.lock");
  const lock = {
    apiVersion: "omdsh.dev/lock/v1alpha1",
    setup: { id: setup.metadata.id, version: setup.metadata.version },
    source: {
      type: "local",
      identity: setup.metadata.id,
      revision: setup.metadata.version,
    },
    capabilities: resolved.capabilities,
    adapter: { id: "dsh-rc5", dsh: resolved.compatibility.dsh },
    normalizedHash: resolved.hash,
  };
  await atomicWrite(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return { manifestPath, lockPath, setup, resolved };
}
