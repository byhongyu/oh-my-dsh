import { createHash } from "node:crypto";

import type {
  AgentSetup,
  CapabilityPack,
  CustomAgentSetup,
  PluginRequirement,
  Workflow,
} from "@oh-my-dsh/schema";

export interface ResolvedSetup {
  metadata: AgentSetup["metadata"];
  compatibility: AgentSetup["compatibility"];
  capabilities: Array<{ id: string; version: string }>;
  persona: string;
  instructions: string[];
  workflows: Workflow[];
  tools: { allow: string[]; deny: string[] };
  permissions: EffectivePermissions;
  permissionElevations: Record<string, string>;
  plugins: PluginRequirement[];
  output: { conventions: string[] };
  hash: string;
}

export interface EffectivePermissions {
  network: "allow" | "ask" | "deny";
  filesystem: "workspace-write" | "read-only" | "deny";
  shell: "allow" | "ask" | "deny";
  destructive: "allow" | "ask" | "deny";
  secrets: "allow" | "ask" | "deny";
  dataExport: "allow" | "deny";
  brokerage: "allow" | "deny";
}

const defaults: EffectivePermissions = {
  network: "deny",
  filesystem: "deny",
  shell: "deny",
  destructive: "deny",
  secrets: "deny",
  dataExport: "deny",
  brokerage: "deny",
};

const permissionRanks = {
  network: { deny: 0, ask: 1, allow: 2 },
  filesystem: { deny: 0, "read-only": 1, "workspace-write": 2 },
  shell: { deny: 0, ask: 1, allow: 2 },
  destructive: { deny: 0, ask: 1, allow: 2 },
  secrets: { deny: 0, ask: 1, allow: 2 },
  dataExport: { deny: 0, allow: 1 },
  brokerage: { deny: 0, allow: 1 },
} as const;

type PermissionKey = keyof EffectivePermissions;

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

export function normalizedHash(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function comparePermission(
  key: PermissionKey,
  left: string,
  right: string,
): string {
  const ranks = permissionRanks[key] as Record<string, number>;
  return ranks[left]! <= ranks[right]! ? left : right;
}

function resolveCapabilities(
  setup: AgentSetup,
  available: readonly CapabilityPack[],
): CapabilityPack[] {
  const byId = new Map(available.map((pack) => [pack.metadata.id, pack]));
  const ordered: CapabilityPack[] = [];
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];

  const visit = (dependency: { id: string; version: string }): void => {
    const pack = byId.get(dependency.id);
    if (!pack)
      throw new Error(
        `missing capability ${dependency.id}@${dependency.version}`,
      );
    if (pack.metadata.version !== dependency.version) {
      throw new Error(
        `capability ${dependency.id} requires ${dependency.version}, found ${pack.metadata.version}`,
      );
    }
    if (state.get(pack.metadata.id) === "visited") return;
    if (state.get(pack.metadata.id) === "visiting") {
      const start = stack.indexOf(pack.metadata.id);
      const cycle = [...stack.slice(start), pack.metadata.id]
        .map((id) => id.split(".").at(-1))
        .join(" -> ");
      throw new Error(`dependency cycle: ${cycle}`);
    }
    state.set(pack.metadata.id, "visiting");
    stack.push(pack.metadata.id);
    for (const child of [...pack.dependencies].sort((a, b) =>
      a.id.localeCompare(b.id),
    ))
      visit(child);
    stack.pop();
    state.set(pack.metadata.id, "visited");
    ordered.push(pack);
  };

  for (const dependency of [...setup.capabilities].sort((a, b) =>
    a.id.localeCompare(b.id),
  ))
    visit(dependency);
  return ordered;
}

function mergePermissions(
  packs: readonly CapabilityPack[],
  setup: AgentSetup,
): { permissions: EffectivePermissions; elevations: Record<string, string> } {
  const merged = { ...defaults };
  let initialized = false;
  for (const pack of packs) {
    for (const key of Object.keys(pack.permissions) as PermissionKey[]) {
      const candidate = pack.permissions[key];
      if (candidate === undefined) continue;
      // Capability packs can request that a root grant access, but they never
      // confer secret access themselves. Only the root setup may explicitly
      // elevate this field with a recorded reason below.
      if (key === "secrets") continue;
      if (!initialized && merged[key] === "deny") {
        (merged as Record<PermissionKey, string>)[key] = candidate;
      } else {
        (merged as unknown as Record<PermissionKey, string>)[key] =
          comparePermission(key, merged[key], candidate);
      }
    }
    initialized = true;
  }

  const elevations: Record<string, string> = {};
  for (const key of Object.keys(setup.permissions) as PermissionKey[]) {
    const requested = setup.permissions[key];
    if (requested === undefined) continue;
    const ranks = permissionRanks[key] as Record<string, number>;
    if (ranks[requested]! > ranks[merged[key]]!) {
      const reason = setup.permissionElevations?.[key];
      if (!reason)
        throw new Error(
          `permission elevation for ${key} requires an explanation`,
        );
      elevations[key] = reason;
    }
    (merged as unknown as Record<PermissionKey, string>)[key] = requested;
  }
  return { permissions: merged, elevations };
}

function uniqueById<T extends { id: string }>(
  items: readonly T[],
  kind: string,
): T[] {
  const result = new Map<string, T>();
  for (const item of items) {
    if (result.has(item.id))
      throw new Error(`duplicate ${kind} id: ${item.id}`);
    result.set(item.id, item);
  }
  return [...result.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

function applyPermissionToolPolicy(
  tools: ResolvedSetup["tools"],
  permissions: EffectivePermissions,
): ResolvedSetup["tools"] {
  if (permissions.dataExport === "allow")
    throw new Error(
      "Agent Setups cannot enable data export; it requires an external root user policy",
    );
  const denied = new Set(tools.deny);
  const shellTools = new Set([
    "shell.execute",
    "test.run",
    "git.status",
    "git.diff",
    "git.commit",
    "git.push",
  ]);
  const shouldDeny = (tool: string): boolean => {
    if (permissions.shell === "deny" && shellTools.has(tool)) return true;
    if (
      permissions.filesystem === "deny" &&
      (tool.startsWith("filesystem.") || tool === "code.search")
    )
      return true;
    if (
      permissions.filesystem !== "workspace-write" &&
      (tool === "filesystem.patch" || tool === "filesystem.write")
    )
      return true;
    if (
      permissions.network === "deny" &&
      (tool.startsWith("web.") ||
        tool.startsWith("browser.") ||
        tool === "market.data")
    )
      return true;
    if (permissions.brokerage === "deny" && tool.startsWith("brokerage."))
      return true;
    if (
      permissions.destructive === "deny" &&
      (tool === "deployment.execute" || tool === "brokerage.execute")
    )
      return true;
    return false;
  };
  const allow = tools.allow.filter((tool) => {
    if (!shouldDeny(tool)) return true;
    denied.add(tool);
    return false;
  });
  return { allow, deny: [...denied].sort() };
}

export function resolveSetup(
  setup: AgentSetup,
  available: readonly CapabilityPack[],
): ResolvedSetup {
  const packs = resolveCapabilities(setup, available);
  const { permissions, elevations } = mergePermissions(packs, setup);
  const workflows = uniqueById(
    [...packs.flatMap((pack) => pack.workflows), ...setup.workflows],
    "workflow",
  );
  const plugins = uniqueById(
    packs.flatMap((pack) => pack.plugins ?? []),
    "plugin",
  );
  const denied = new Set([
    ...packs.flatMap((pack) => pack.tools.deny ?? []),
    ...(setup.tools.deny ?? []),
  ]);
  const allowed = new Set([
    ...packs.flatMap((pack) => pack.tools.allow),
    ...setup.tools.allow,
  ]);
  for (const tool of denied) allowed.delete(tool);
  const tools = applyPermissionToolPolicy(
    { allow: [...allowed].sort(), deny: [...denied].sort() },
    permissions,
  );

  const withoutHash = {
    metadata: setup.metadata,
    compatibility: setup.compatibility,
    capabilities: packs.map((pack) => ({
      id: pack.metadata.id,
      version: pack.metadata.version,
    })),
    persona:
      "text" in setup.persona
        ? setup.persona.text
        : `@file:${setup.persona.file}`,
    instructions: [
      ...packs.flatMap((pack) => pack.instructions ?? []),
      ...(setup.instructions.inline ?? []),
      ...(setup.instructions.files ?? []).map((file) => `@file:${file}`),
    ],
    workflows,
    tools,
    permissions,
    permissionElevations: elevations,
    plugins,
    output: {
      conventions: [...setup.output.conventions],
    },
  };
  return { ...withoutHash, hash: normalizedHash(withoutHash) };
}

function withResolvedHash(setup: Omit<ResolvedSetup, "hash">): ResolvedSetup {
  return { ...setup, hash: normalizedHash(setup) };
}

export function resolveCustomSetup(
  custom: CustomAgentSetup,
  parent: AgentSetup,
  available: readonly CapabilityPack[],
): ResolvedSetup {
  if (custom.extends.id !== parent.metadata.id) {
    throw new Error(
      `fork parent ${custom.extends.id} does not match ${parent.metadata.id}`,
    );
  }
  if (custom.extends.version !== parent.metadata.version) {
    throw new Error(
      `parent version mismatch: fork requires ${custom.extends.version}, found ${parent.metadata.version}`,
    );
  }

  const base = resolveSetup(parent, available);
  const instructions = custom.overrides.instructions?.replace
    ? [...custom.overrides.instructions.replace]
    : [...base.instructions, ...(custom.overrides.instructions?.append ?? [])];
  const disabled = new Set(custom.overrides.workflows?.disable ?? []);
  const workflowIds = new Set(base.workflows.map((workflow) => workflow.id));
  for (const enabled of custom.overrides.workflows?.enable ?? []) {
    if (!workflowIds.has(enabled))
      throw new Error(`fork enables unknown workflow ${enabled}`);
    disabled.delete(enabled);
  }
  const permissions = { ...base.permissions };
  const elevations = { ...base.permissionElevations };
  for (const key of Object.keys(
    custom.overrides.permissions ?? {},
  ) as PermissionKey[]) {
    const requested = custom.overrides.permissions?.[key];
    if (requested === undefined) continue;
    const ranks = permissionRanks[key] as Record<string, number>;
    if (ranks[requested]! > ranks[permissions[key]]!) {
      const reason = custom.overrides.permissionElevations?.[key];
      if (!reason)
        throw new Error(
          `permission elevation for ${key} requires an explanation`,
        );
      elevations[key] = reason;
    }
    (permissions as unknown as Record<PermissionKey, string>)[key] = requested;
  }

  const tools = applyPermissionToolPolicy(base.tools, permissions);

  return withResolvedHash({
    ...base,
    metadata: {
      ...base.metadata,
      ...custom.metadata,
      description: custom.metadata.description ?? base.metadata.description,
    },
    instructions,
    workflows: base.workflows.filter((workflow) => !disabled.has(workflow.id)),
    permissions,
    permissionElevations: elevations,
    tools,
    output: {
      conventions: [
        ...base.output.conventions,
        ...(custom.overrides.output?.append ?? []),
      ],
    },
  });
}

export interface SemanticDiff {
  instructionsAdded: string[];
  instructionsRemoved: string[];
  workflowsAdded: string[];
  workflowsRemoved: string[];
  permissionChanges: Partial<
    Record<PermissionKey, { from: string; to: string }>
  >;
}

export function semanticDiff(
  before: ResolvedSetup,
  after: ResolvedSetup,
): SemanticDiff {
  const beforeInstructions = new Set(before.instructions);
  const afterInstructions = new Set(after.instructions);
  const beforeWorkflows = new Set(
    before.workflows.map((workflow) => workflow.id),
  );
  const afterWorkflows = new Set(
    after.workflows.map((workflow) => workflow.id),
  );
  const permissionChanges: SemanticDiff["permissionChanges"] = {};
  for (const key of Object.keys(before.permissions) as PermissionKey[]) {
    if (before.permissions[key] !== after.permissions[key]) {
      permissionChanges[key] = {
        from: before.permissions[key],
        to: after.permissions[key],
      };
    }
  }
  return {
    instructionsAdded: after.instructions.filter(
      (instruction) => !beforeInstructions.has(instruction),
    ),
    instructionsRemoved: before.instructions.filter(
      (instruction) => !afterInstructions.has(instruction),
    ),
    workflowsAdded: after.workflows
      .map((workflow) => workflow.id)
      .filter((id) => !beforeWorkflows.has(id)),
    workflowsRemoved: before.workflows
      .map((workflow) => workflow.id)
      .filter((id) => !afterWorkflows.has(id)),
    permissionChanges,
  };
}

export * from "./archive.js";
export * from "./git-source.js";
export * from "./setup-files.js";
export * from "./update.js";
