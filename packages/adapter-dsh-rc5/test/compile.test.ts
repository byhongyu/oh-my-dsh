import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { agentSetups, capabilityPacks } from "@oh-my-dsh/catalog";
import { resolveSetup } from "@oh-my-dsh/core";

import { compilePreset } from "../src/index.js";

describe("compilePreset", () => {
  it("emits a loadable DSH user preset directory", () => {
    const compiled = compilePreset(
      resolveSetup(agentSetups.coding, capabilityPacks),
    );

    expect(compiled.id).toBe("oh-my-dsh-coding");
    expect(Object.keys(compiled.files).sort()).toEqual([
      "agent.cordis.yml",
      "preset.yml",
    ]);

    const composition = parse(compiled.files["agent.cordis.yml"]!);
    expect(Array.isArray(composition)).toBe(true);
    expect(
      composition.every(
        (row: unknown) => typeof row === "object" && row !== null,
      ),
    ).toBe(true);

    const metadata = parse(compiled.files["preset.yml"]!);
    expect(metadata).toMatchObject({
      name: "Coding",
      description:
        "Build, debug, test, and review software with bounded autonomy.",
    });

    expect(composition[0]).toMatchObject({
      id: "persona",
      name: "@deepseek-ai/dsh-persona",
    });
    expect(
      composition.some(
        (row: { name?: string }) => row.name === "@deepseek-ai/dsh-tool-bash",
      ),
    ).toBe(true);
    expect(
      composition.some(
        (row: { name?: string }) => row.name === "@deepseek-ai/dsh-tool-fs",
      ),
    ).toBe(true);
    expect(
      composition.some(
        (row: { name?: string }) => row.name === "@deepseek-ai/dsh-tool-web",
      ),
    ).toBe(false);
  });

  it("compiles Research to verified search-only DSH tools and reports unsupported capabilities", () => {
    const compiled = compilePreset(
      resolveSetup(agentSetups.research, capabilityPacks),
    );
    const composition = parse(compiled.files["agent.cordis.yml"]!);

    expect(
      composition.some(
        (row: { name?: string }) => row.name === "@deepseek-ai/dsh-tool-web",
      ),
    ).toBe(true);
    expect(
      composition.some(
        (row: { name?: string }) => row.name === "@deepseek-ai/dsh-tool-bash",
      ),
    ).toBe(false);
    expect(compiled.warnings.join("\n")).toMatch(
      /document\.read.*not available/i,
    );
  });

  it("fails closed when a stock plugin would expose more tools than allowed", () => {
    const coding = resolveSetup(agentSetups.coding, capabilityPacks);
    const restricted = {
      ...coding,
      tools: {
        allow: coding.tools.allow.filter(
          (tool) => tool !== "filesystem.patch" && tool !== "git.diff",
        ),
        deny: [...coding.tools.deny, "filesystem.patch", "git.diff"],
      },
    };

    const compiled = compilePreset(restricted);
    const composition = parse(compiled.files["agent.cordis.yml"]!) as Array<{
      name?: string;
    }>;

    expect(composition.map(({ name }) => name)).not.toContain(
      "@deepseek-ai/dsh-tool-fs",
    );
    expect(composition.map(({ name }) => name)).not.toContain(
      "@deepseek-ai/dsh-tool-bash",
    );
    expect(compiled.warnings.join("\n")).toMatch(
      /filesystem\.read.*not emitted/i,
    );
    expect(compiled.warnings.join("\n")).toMatch(
      /shell\.execute.*not emitted/i,
    );
  });
});
