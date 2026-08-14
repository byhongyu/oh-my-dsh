import { describe, expect, it, vi } from "vitest";

import { agentSetups, capabilityPacks } from "@oh-my-dsh/catalog";

import {
  CLI_VERSION,
  runCli,
  type CliIO,
  type RunCliOptions,
} from "../src/index.js";

function capture(): { io: CliIO; stdout: () => string; stderr: () => string } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    io: {
      stdout: (text) => output.push(text),
      stderr: (text) => errors.push(text),
    },
    stdout: () => output.join(""),
    stderr: () => errors.join(""),
  };
}

async function invoke(
  args: readonly string[],
  options: Omit<RunCliOptions, "io"> = {},
) {
  const captured = capture();
  const code = await runCli(args, { ...options, io: captured.io });
  return { code, stdout: captured.stdout(), stderr: captured.stderr() };
}

describe("runCli", () => {
  it.each([[[]], [["help"]], [["--help"]], [["-h"]]])(
    "prints stable help for %j",
    async (args) => {
      const result = await invoke(args);

      expect(result).toEqual({
        code: 0,
        stdout: expect.stringContaining("Usage: oh-my-dsh <command> [options]"),
        stderr: "",
      });
      expect(result.stdout).toContain("list");
      expect(result.stdout).toContain("plan [setup]");
      expect(result.stdout).not.toContain("\u001b[");
    },
  );

  it.each([[["--version"]], [["-v"]], [["version"]]])(
    "prints only the package version for %j",
    async (args) => {
      await expect(invoke(args)).resolves.toEqual({
        code: 0,
        stdout: `${CLI_VERSION}\n`,
        stderr: "",
      });
    },
  );

  it("lists all resolved built-ins in deterministic human-readable order", async () => {
    const first = await invoke(["list"]);
    const second = await invoke(["list"]);

    expect(first).toEqual(second);
    expect(first.code).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).toMatchInlineSnapshot(`
      "Available setups:
        coding     Coding     0.1.0  Build, debug, test, and review software with bounded autonomy.
        investing  Investing  0.1.0  Analyze companies, filings, valuation scenarios, and thesis risks without trading.
        research   Research   0.1.0  Conduct cited, evidence-driven research with explicit uncertainty.
      "
    `);
  });

  it("lists machine-readable resolved setup metadata with stable key ordering", async () => {
    const result = await invoke(["list", "--json"]);
    const parsed = JSON.parse(result.stdout) as {
      command: string;
      setups: Array<{ key: string; id: string; hash: string }>;
    };

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(parsed.command).toBe("list");
    expect(parsed.setups.map(({ key }) => key)).toEqual([
      "coding",
      "investing",
      "research",
    ]);
    expect(parsed.setups.map(({ id }) => id)).toEqual([
      "dev.oh-my-dsh.coding",
      "dev.oh-my-dsh.investing",
      "dev.oh-my-dsh.research",
    ]);
    expect(parsed.setups.every(({ hash }) => /^[a-f0-9]{64}$/.test(hash))).toBe(
      true,
    );
    expect(result.stdout).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
  });

  it("plans one setup through the resolver and DSH rc5 adapter", async () => {
    const result = await invoke(["plan", "coding", "--json"]);
    const parsed = JSON.parse(result.stdout) as {
      command: string;
      setups: Array<{
        key: string;
        preset: { id: string; files: string[]; warnings: string[] };
        permissions: Record<string, string>;
        workflows: string[];
      }>;
    };

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(parsed.command).toBe("plan");
    expect(parsed.setups).toHaveLength(1);
    expect(parsed.setups[0]).toMatchObject({
      key: "coding",
      preset: {
        id: "oh-my-dsh-coding",
        files: ["agent.cordis.yml", "preset.yml"],
        warnings: [],
      },
      permissions: {
        brokerage: "deny",
        dataExport: "deny",
        destructive: "deny",
        filesystem: "workspace-write",
        network: "ask",
        secrets: "deny",
        shell: "allow",
      },
    });
    expect(parsed.setups[0]?.workflows).toEqual([
      "diagnose-without-fixing",
      "plan-implement-test",
      "review-current-diff",
      "understand-repo",
    ]);
  });

  it("plans all built-ins when setup is omitted and surfaces adapter warnings", async () => {
    const result = await invoke(["--json", "plan"]);
    const parsed = JSON.parse(result.stdout) as {
      setups: Array<{ key: string; preset: { warnings: string[] } }>;
    };

    expect(result.code).toBe(0);
    expect(parsed.setups.map(({ key }) => key)).toEqual([
      "coding",
      "investing",
      "research",
    ]);
    expect(
      parsed.setups
        .find(({ key }) => key === "research")
        ?.preset.warnings.join("\n"),
    ).toMatch(/document\.read.*not available/i);
    expect(
      parsed.setups
        .find(({ key }) => key === "investing")
        ?.preset.warnings.join("\n"),
    ).toMatch(/financial\.calculate.*not available/i);
  });

  it("renders a concise deterministic human plan", async () => {
    const result = await invoke(["plan", "coding"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Plan: Coding (coding) v0.1.0");
    expect(result.stdout).toContain("Preset: oh-my-dsh-coding");
    expect(result.stdout).toContain("Files: agent.cordis.yml, preset.yml");
    expect(result.stdout).toContain("filesystem=workspace-write");
    expect(result.stdout).toContain("Warnings: none");
    expect(result.stdout).not.toContain("\u001b[");
  });

  it("accepts a full built-in ID as a setup selector", async () => {
    const result = await invoke(["plan", "dev.oh-my-dsh.research", "--json"]);
    const parsed = JSON.parse(result.stdout) as {
      setups: Array<{ key: string }>;
    };

    expect(result.code).toBe(0);
    expect(parsed.setups.map(({ key }) => key)).toEqual(["research"]);
  });

  it("returns a usage error with available names for an unknown setup", async () => {
    const result = await invoke(["plan", "writer"]);

    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr:
        'Error: Unknown setup "writer". Available setups: coding, investing, research.\n',
    });
  });

  it("returns a usage error and help hint for unknown commands and options", async () => {
    await expect(invoke(["deploy"])).resolves.toEqual({
      code: 2,
      stdout: "",
      stderr:
        'Error: Unknown command "deploy". Run "oh-my-dsh --help" for usage.\n',
    });
    await expect(invoke(["list", "--colour"])).resolves.toEqual({
      code: 2,
      stdout: "",
      stderr:
        'Error: Unknown option "--colour". Run "oh-my-dsh --help" for usage.\n',
    });
  });

  it("injects resolution and compilation dependencies without exposing thrown details", async () => {
    const resolve = vi.fn(() => {
      throw new Error("TOP_SECRET_TOKEN=do-not-print");
    });
    const compile = vi.fn();

    const result = await invoke(["plan", "coding"], {
      dependencies: {
        setups: agentSetups,
        capabilityPacks,
        resolve,
        compile,
      },
    });

    expect(resolve).toHaveBeenCalledOnce();
    expect(compile).not.toHaveBeenCalled();
    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: 'Error: Could not resolve setup "coding".\n',
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      "TOP_SECRET_TOKEN",
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain("do-not-print");
  });

  it("does not mutate the caller argument array", async () => {
    const args = ["plan", "coding", "--json"];
    await invoke(args);
    expect(args).toEqual(["plan", "coding", "--json"]);
  });
});
