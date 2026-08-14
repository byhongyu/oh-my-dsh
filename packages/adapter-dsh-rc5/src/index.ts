import { stringify } from "yaml";

import type { ResolvedSetup } from "@oh-my-dsh/core";

export const DSH_RC5_COMPATIBILITY = ">=0.1.0-rc.5 <0.2.0";
export const DSH_USER_PRESET_DIRECTORY = ".agent-presets";

export interface CompiledPreset {
  id: string;
  files: Record<"agent.cordis.yml" | "preset.yml", string>;
  warnings: string[];
}

function presetId(setupId: string): string {
  const leaf = setupId.split(".").at(-1);
  if (!leaf || !/^[a-z0-9][a-z0-9-]*$/.test(leaf))
    throw new Error(`cannot derive DSH preset id from ${setupId}`);
  return `oh-my-dsh-${leaf}`;
}

export function compilePreset(setup: ResolvedSetup): CompiledPreset {
  if (!setup.compatibility.adapters.includes("dsh-rc5")) {
    throw new Error(
      `setup ${setup.metadata.id} is not compatible with adapter dsh-rc5`,
    );
  }

  const prompt = [
    setup.persona,
    ...setup.instructions,
    "Effective Agent Setup policy (this declaration is not an OS sandbox; do not exceed it):",
    ...Object.entries(setup.permissions).map(
      ([permission, value]) => `- ${permission}: ${value}`,
    ),
    `Denied tools: ${setup.tools.deny.join(", ") || "none"}`,
    "Available workflows:",
    ...setup.workflows.map(
      (workflow) => `- ${workflow.id}: ${workflow.description}`,
    ),
    "Output conventions:",
    ...setup.output.conventions.map((convention) => `- ${convention}`),
  ].join("\n\n");

  const composition: Array<Record<string, unknown>> = [
    {
      id: "persona",
      name: "@deepseek-ai/dsh-persona",
      config: { text: prompt },
    },
  ];

  const filesystemPluginTools = ["filesystem.read", "filesystem.patch"];
  const shellPluginTools = [
    "shell.execute",
    "test.run",
    "git.status",
    "git.diff",
  ];

  if (filesystemPluginTools.every((tool) => setup.tools.allow.includes(tool))) {
    composition.push({
      id: "agent-instructions",
      name: "@deepseek-ai/dsh-agent-instructions",
      config: { maxBytes: 65_536 },
    });
    composition.push({ id: "tool-fs", name: "@deepseek-ai/dsh-tool-fs" });
  }
  if (setup.tools.allow.includes("code.search")) {
    composition.push({
      id: "tool-fs-search",
      name: "@deepseek-ai/dsh-tool-fs-search",
      config: { sampleOverCapGlobResults: false },
    });
  }
  if (shellPluginTools.every((tool) => setup.tools.allow.includes(tool))) {
    composition.push({
      id: process.platform === "win32" ? "tool-pwsh" : "tool-bash",
      name:
        process.platform === "win32"
          ? "@deepseek-ai/dsh-tool-pwsh"
          : "@deepseek-ai/dsh-tool-bash",
    });
  }
  if (setup.tools.allow.includes("web.search")) {
    composition.push({
      id: "tool-web",
      name: "@deepseek-ai/dsh-tool-web",
      config: { fetch: false, searchTimeoutMs: 60_000 },
    });
  }

  const compiledTools = new Set<string>();
  if (composition.some((row) => row["id"] === "tool-fs"))
    compiledTools.add("filesystem.read").add("filesystem.patch");
  if (composition.some((row) => row["id"] === "tool-fs-search"))
    compiledTools.add("code.search");
  if (
    composition.some(
      (row) => row["id"] === "tool-bash" || row["id"] === "tool-pwsh",
    )
  ) {
    compiledTools
      .add("shell.execute")
      .add("test.run")
      .add("git.status")
      .add("git.diff");
  }
  if (composition.some((row) => row["id"] === "tool-web"))
    compiledTools.add("web.search");
  const warnings = setup.tools.allow
    .filter((tool) => !compiledTools.has(tool))
    .map(
      (tool) =>
        `${tool} is not available in stock DSH rc.5/rc.6 and was not emitted`,
    );

  return {
    id: presetId(setup.metadata.id),
    warnings,
    files: {
      "agent.cordis.yml": stringify(composition, { lineWidth: 0 }),
      "preset.yml": stringify(
        {
          name: setup.metadata.name,
          description: setup.metadata.description,
        },
        { lineWidth: 0 },
      ),
    },
  };
}

export * from "./home.js";
