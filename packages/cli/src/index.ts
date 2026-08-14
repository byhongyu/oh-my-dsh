import {
  compilePreset,
  resolveDshHome,
  type CompiledPreset,
} from "@oh-my-dsh/adapter-dsh-rc5";
import { agentSetups, capabilityPacks } from "@oh-my-dsh/catalog";
import { resolveSetup, type ResolvedSetup } from "@oh-my-dsh/core";
import type { AgentSetup, CapabilityPack } from "@oh-my-dsh/schema";

import { localResolvedEntries, runStatefulCommand } from "./stateful.js";

export const CLI_VERSION = "0.1.0";

export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface CliDependencies {
  setups: Readonly<Record<string, AgentSetup>>;
  capabilityPacks: readonly CapabilityPack[];
  resolve(
    setup: AgentSetup,
    available: readonly CapabilityPack[],
  ): ResolvedSetup;
  compile(setup: ResolvedSetup): CompiledPreset;
  version: string;
}

export interface RunCliOptions {
  io?: CliIO;
  dependencies?: Partial<CliDependencies>;
}

interface SetupEntry {
  key: string;
  setup: AgentSetup;
}

interface ResolvedEntry extends SetupEntry {
  resolved: ResolvedSetup;
}

interface CommandContext {
  io: CliIO;
  dependencies: CliDependencies;
  json: boolean;
  dshHome: string;
  operands: string[];
}

type CommandHandler = (context: CommandContext) => number | Promise<number>;

const HELP = `Usage: oh-my-dsh <command> [options]

Curated agent setups for DeepSeek Harness.

Commands:
  init          Install the curated setups into DSH
  list          List available setups
  use <setup> --default
                Change the default setup for new sessions
  plan [setup]  Preview generated DSH presets
  apply         Atomically publish the current setup definitions
  update        Preview or apply shipped setup updates
  rollback      Restore the previous complete generation
  doctor        Verify the active generation and published presets
  agent <cmd>   Fork, save, export, import, or add a setup
  help          Show this help
  version       Show the CLI version

Options:
  --json        Emit deterministic JSON for list and plan
  --dsh-home P  Use P instead of DSH_HOME or ~/.dsh
  -h, --help    Show this help
  -v, --version Show the CLI version
`;

const processIO: CliIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

function isCliIO(value: RunCliOptions | CliIO): value is CliIO {
  return "stdout" in value && "stderr" in value;
}

function dependenciesFrom(
  overrides: Partial<CliDependencies> | undefined,
): CliDependencies {
  return {
    setups: overrides?.setups ?? agentSetups,
    capabilityPacks: overrides?.capabilityPacks ?? capabilityPacks,
    resolve: overrides?.resolve ?? resolveSetup,
    compile: overrides?.compile ?? compilePreset,
    version: overrides?.version ?? CLI_VERSION,
  };
}

function entriesFor(dependencies: CliDependencies): SetupEntry[] {
  return Object.entries(dependencies.setups)
    .map(([key, setup]) => ({ key, setup }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function writeJson(io: CliIO, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function usageError(io: CliIO, message: string): number {
  io.stderr(`Error: ${message}\n`);
  return 2;
}

function operationError(io: CliIO, message: string): number {
  io.stderr(`Error: ${message}\n`);
  return 1;
}

function resolveEntries(
  entries: readonly SetupEntry[],
  dependencies: CliDependencies,
): { entries?: ResolvedEntry[]; failedKey?: string } {
  const resolved: ResolvedEntry[] = [];
  for (const entry of entries) {
    try {
      resolved.push({
        ...entry,
        resolved: dependencies.resolve(
          entry.setup,
          dependencies.capabilityPacks,
        ),
      });
    } catch {
      return { failedKey: entry.key };
    }
  }
  return { entries: resolved };
}

function listView(entry: { key: string; resolved: ResolvedSetup }) {
  return {
    key: entry.key,
    id: entry.resolved.metadata.id,
    name: entry.resolved.metadata.name,
    version: entry.resolved.metadata.version,
    description: entry.resolved.metadata.description ?? "",
    hash: entry.resolved.hash,
  };
}

const listCommand: CommandHandler = async ({
  io,
  dependencies,
  json,
  dshHome,
  operands,
}) => {
  if (operands.length > 0) {
    if (operands[0]!.startsWith("-"))
      return usageError(
        io,
        `Unknown option "${operands[0]}". Run "oh-my-dsh --help" for usage.`,
      );
    return usageError(io, `Unexpected argument "${operands[0]}" for "list".`);
  }

  const result = resolveEntries(entriesFor(dependencies), dependencies);
  if (!result.entries)
    return operationError(io, `Could not resolve setup "${result.failedKey}".`);
  const local = await localResolvedEntries({
    io,
    json,
    dshHome,
    operands,
    setups: dependencies.setups,
    capabilities: dependencies.capabilityPacks,
    version: dependencies.version,
  });
  const setups = [
    ...result.entries.map(listView),
    ...local.map(({ key, resolved }) => listView({ key, resolved })),
  ].sort((left, right) => left.key.localeCompare(right.key));

  if (json) {
    writeJson(io, { command: "list", setups });
    return 0;
  }

  const lines = setups.map(
    (setup) =>
      `  ${setup.key.padEnd(11)}${setup.name.padEnd(11)}${setup.version}  ${setup.description}`,
  );
  io.stdout(`Available setups:\n${lines.join("\n")}\n`);
  return 0;
};

function selectEntries(
  selector: string | undefined,
  dependencies: CliDependencies,
): SetupEntry[] | undefined {
  const entries = entriesFor(dependencies);
  if (selector === undefined) return entries;
  const normalized = selector.toLowerCase();
  const match = entries.find(
    ({ key, setup }) =>
      key.toLowerCase() === normalized ||
      setup.metadata.id.toLowerCase() === normalized ||
      setup.metadata.name.toLowerCase() === normalized,
  );
  return match ? [match] : undefined;
}

function sortedRecord(record: object): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function planView(
  entry: { key: string; resolved: ResolvedSetup },
  compiled: CompiledPreset,
  delta?: unknown,
) {
  return {
    key: entry.key,
    id: entry.resolved.metadata.id,
    name: entry.resolved.metadata.name,
    version: entry.resolved.metadata.version,
    description: entry.resolved.metadata.description ?? "",
    hash: entry.resolved.hash,
    capabilities: entry.resolved.capabilities.map(
      (capability) => `${capability.id}@${capability.version}`,
    ),
    plugins: entry.resolved.plugins
      .map((plugin) => `${plugin.package}@${plugin.version}`)
      .sort(),
    tools: {
      allow: [...entry.resolved.tools.allow],
      deny: [...entry.resolved.tools.deny],
    },
    permissions: sortedRecord(entry.resolved.permissions),
    workflows: entry.resolved.workflows.map((workflow) => workflow.id),
    preset: {
      id: compiled.id,
      files: Object.keys(compiled.files).sort(),
      warnings: [...compiled.warnings],
    },
    ...(delta === undefined ? {} : { delta }),
  };
}

type PlanView = ReturnType<typeof planView>;

function renderHumanPlan(setups: readonly PlanView[]): string {
  return `${setups
    .map((setup) => {
      const permissions = Object.entries(setup.permissions)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ");
      const warnings =
        setup.preset.warnings.length === 0
          ? "none"
          : setup.preset.warnings
              .map((warning) => `\n    - ${warning}`)
              .join("");
      const delta =
        "delta" in setup
          ? `\n  Fork delta: ${JSON.stringify(setup.delta)}`
          : "";
      return [
        `Plan: ${setup.name} (${setup.key}) v${setup.version}`,
        `  ID: ${setup.id}`,
        `  Hash: ${setup.hash}`,
        `  Preset: ${setup.preset.id}`,
        `  Files: ${setup.preset.files.join(", ")}`,
        `  Permissions: ${permissions}`,
        `  Workflows: ${setup.workflows.join(", ") || "none"}`,
        `  Warnings: ${warnings}${delta}`,
      ].join("\n");
    })
    .join("\n\n")}\n`;
}

const planCommand: CommandHandler = async ({
  io,
  dependencies,
  json,
  dshHome,
  operands,
}) => {
  if (operands.length > 1) {
    return usageError(io, `Unexpected argument "${operands[1]}" for "plan".`);
  }

  const builtIns = selectEntries(operands[0], dependencies);
  const local = await localResolvedEntries({
    io,
    json,
    dshHome,
    operands,
    setups: dependencies.setups,
    capabilities: dependencies.capabilityPacks,
    version: dependencies.version,
  });
  const normalizedSelector = operands[0]?.toLowerCase();
  const selectedLocal =
    normalizedSelector === undefined
      ? local
      : local.filter(
          ({ key, resolved }) =>
            key.toLowerCase() === normalizedSelector ||
            resolved.metadata.id.toLowerCase() === normalizedSelector ||
            resolved.metadata.name.toLowerCase() === normalizedSelector,
        );
  if (!builtIns && selectedLocal.length === 0) {
    const available = [
      ...entriesFor(dependencies).map(({ key }) => key),
      ...local.map(({ key }) => key),
    ]
      .sort()
      .join(", ");
    return usageError(
      io,
      `Unknown setup "${operands[0]}". Available setups: ${available}.`,
    );
  }

  const result = resolveEntries(builtIns ?? [], dependencies);
  if (!result.entries)
    return operationError(io, `Could not resolve setup "${result.failedKey}".`);

  const setups: PlanView[] = [];
  for (const entry of result.entries) {
    try {
      setups.push(planView(entry, dependencies.compile(entry.resolved)));
    } catch {
      return operationError(
        io,
        `Could not compile setup "${entry.key}" for DSH rc5.`,
      );
    }
  }
  for (const entry of selectedLocal) {
    try {
      setups.push(
        planView(
          {
            key: entry.key,
            resolved: entry.resolved,
          },
          dependencies.compile(entry.resolved),
          entry.delta,
        ),
      );
    } catch {
      return operationError(
        io,
        `Could not compile setup "${entry.key}" for DSH rc5.`,
      );
    }
  }
  setups.sort((left, right) => left.key.localeCompare(right.key));

  if (json) writeJson(io, { command: "plan", setups });
  else io.stdout(renderHumanPlan(setups));
  return 0;
};

const commandHandlers: Readonly<Record<string, CommandHandler>> = {
  list: listCommand,
  plan: planCommand,
};

interface ParsedArguments {
  json: boolean;
  dshHome?: string;
  positional: string[];
  help: boolean;
  version: boolean;
  unknownOption?: string;
  parseError?: string;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const positional: string[] = [];
  let json = false;
  let help = false;
  let version = false;
  let dshHome: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--json") json = true;
    else if (argument === "-h" || argument === "--help") help = true;
    else if (argument === "-v" || argument === "--version") version = true;
    else if (argument === "--dsh-home") {
      const value = args[index + 1];
      if (!value || value.startsWith("-"))
        return {
          json,
          positional,
          help,
          version,
          parseError: 'Option "--dsh-home" requires a path.',
        };
      index += 1;
      dshHome = value;
    } else positional.push(argument);
  }

  return {
    json,
    positional,
    help,
    version,
    ...(dshHome === undefined ? {} : { dshHome }),
  };
}

export async function runCli(
  args: readonly string[],
  input: RunCliOptions | CliIO = {},
): Promise<number> {
  const options = isCliIO(input) ? { io: input } : input;
  const io = options.io ?? processIO;
  const dependencies = dependenciesFrom(options.dependencies);
  const parsed = parseArguments(args);

  if (parsed.parseError) return usageError(io, parsed.parseError);

  if (parsed.unknownOption) {
    return usageError(
      io,
      `Unknown option "${parsed.unknownOption}". Run "oh-my-dsh --help" for usage.`,
    );
  }
  if (parsed.help || parsed.positional[0] === "help") {
    io.stdout(HELP);
    return 0;
  }
  if (parsed.version || parsed.positional[0] === "version") {
    io.stdout(`${dependencies.version}\n`);
    return 0;
  }
  if (parsed.positional.length === 0) {
    io.stdout(HELP);
    return 0;
  }

  const command = parsed.positional[0]!;
  const dshHome = resolveDshHome(
    parsed.dshHome === undefined ? {} : { explicit: parsed.dshHome },
  );
  const statefulResult = await runStatefulCommand(command, {
    io,
    json: parsed.json,
    dshHome,
    operands: parsed.positional.slice(1),
    setups: dependencies.setups,
    capabilities: dependencies.capabilityPacks,
    version: dependencies.version,
  });
  if (statefulResult !== undefined) return statefulResult;
  const handler = commandHandlers[command];
  if (!handler) {
    return usageError(
      io,
      `Unknown command "${command}". Run "oh-my-dsh --help" for usage.`,
    );
  }

  try {
    return await handler({
      io,
      dependencies,
      json: parsed.json,
      dshHome,
      operands: parsed.positional.slice(1),
    });
  } catch {
    return operationError(io, `Command "${command}" failed.`);
  }
}
