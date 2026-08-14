import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import { agentSetups } from "@oh-my-dsh/catalog";
import {
  computeArchiveSetupHash,
  createAgentArchive,
  parseAgentArchive,
} from "@oh-my-dsh/core";
import { parseAgentSetup } from "@oh-my-dsh/schema";

import { runCli, type CliIO } from "../src/index.js";

const temporaryDirectories: string[] = [];

async function temporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "oh-my-dsh-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

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

async function invoke(args: readonly string[]) {
  const output = capture();
  const code = await runCli(args, output.io);
  return { code, stdout: output.stdout(), stderr: output.stderr() };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("state-changing CLI journeys", () => {
  it("initializes a clean DSH home and applies all curated setups", async () => {
    const dshHome = await temporaryHome();

    const result = await invoke(["init", "--dsh-home", dshHome]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("Installed built-in agent setups");
    expect(result.stdout).toContain("Default: coding");
    expect(await readFile(join(dshHome, "settings.yaml"), "utf8")).toContain(
      "default: oh-my-dsh-coding",
    );
    for (const setup of ["coding", "investing", "research"]) {
      expect(
        (
          await stat(join(dshHome, ".agent-presets", `oh-my-dsh-${setup}`))
        ).isDirectory(),
      ).toBe(true);
    }
  });

  it("changes the default, reports health, and rolls back atomically", async () => {
    const dshHome = await temporaryHome();
    expect((await invoke(["init", "--dsh-home", dshHome])).code).toBe(0);

    const switched = await invoke([
      "use",
      "research",
      "--default",
      "--dsh-home",
      dshHome,
    ]);
    expect(switched).toMatchObject({ code: 0, stderr: "" });
    expect(switched.stdout).toContain("Default Agent Setup changed");
    expect(await readFile(join(dshHome, "settings.yaml"), "utf8")).toContain(
      "default: oh-my-dsh-research",
    );

    const doctor = await invoke(["doctor", "--json", "--dsh-home", dshHome]);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      command: "doctor",
      ok: true,
    });

    const rolledBack = await invoke(["rollback", "--dsh-home", dshHome]);
    expect(rolledBack).toMatchObject({ code: 0, stderr: "" });
    expect(rolledBack.stdout).toContain("Rolled back");
    expect(await readFile(join(dshHome, "settings.yaml"), "utf8")).toContain(
      "default: oh-my-dsh-coding",
    );
  });

  it("forks, validates, exports, previews, imports, and applies a setup", async () => {
    const sourceHome = await temporaryHome();
    const targetHome = await temporaryHome();
    const exportPath = join(sourceHome, "long-term.omdsh-agent");

    const forked = await invoke([
      "agent",
      "fork",
      "investing",
      "--as",
      "long-term",
      "--dsh-home",
      sourceHome,
    ]);
    expect(forked).toMatchObject({ code: 0, stderr: "" });
    const manifestPath = join(
      sourceHome,
      "oh-my-dsh",
      "agents",
      "long-term",
      "agent.yaml",
    );
    const definition = parse(await readFile(manifestPath, "utf8")) as {
      overrides: { instructions: { append: string[] } };
    };
    definition.overrides.instructions.append.push("Use a five-year horizon.");
    await writeFile(manifestPath, stringify(definition), "utf8");

    const listed = JSON.parse(
      (await invoke(["list", "--json", "--dsh-home", sourceHome])).stdout,
    ) as { setups: Array<{ key: string; id: string }> };
    expect(listed.setups).toContainEqual(
      expect.objectContaining({ key: "long-term", id: "local.long-term" }),
    );
    const plan = JSON.parse(
      (await invoke(["plan", "long-term", "--json", "--dsh-home", sourceHome]))
        .stdout,
    ) as { setups: Array<{ key: string; instructions?: string[] }> };
    expect(plan.setups).toHaveLength(1);
    expect(plan.setups[0]?.key).toBe("long-term");

    const saved = await invoke([
      "agent",
      "save",
      "long-term",
      "--dsh-home",
      sourceHome,
    ]);
    expect(saved).toMatchObject({ code: 0, stderr: "" });
    expect(saved.stdout).toContain("Saved Agent Setup local.long-term@0.1.0");

    const exported = await invoke([
      "agent",
      "export",
      "long-term",
      "--output",
      exportPath,
      "--dsh-home",
      sourceHome,
    ]);
    expect(exported).toMatchObject({ code: 0, stderr: "" });
    const archive = parseAgentArchive(await readFile(exportPath));
    expect(archive.setup.metadata.id).toBe("local.long-term");

    const preview = await invoke([
      "agent",
      "import",
      exportPath,
      "--dsh-home",
      targetHome,
    ]);
    expect(preview.code).toBe(2);
    expect(preview.stdout).toContain("No plugin code has been executed");
    await expect(
      stat(join(targetHome, "oh-my-dsh", "agents", "long-term")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const imported = await invoke([
      "agent",
      "import",
      exportPath,
      "--yes",
      "--dsh-home",
      targetHome,
    ]);
    expect(imported).toMatchObject({ code: 0, stderr: "" });
    expect(imported.stdout).toContain("Imported local.long-term@0.1.0");
    expect((await invoke(["apply", "--dsh-home", targetHome])).code).toBe(0);
    expect(
      (
        await stat(join(targetHome, ".agent-presets", "oh-my-dsh-long-term"))
      ).isDirectory(),
    ).toBe(true);

    const importedManifest = join(
      targetHome,
      "oh-my-dsh",
      "agents",
      "long-term",
      "agent.yaml",
    );
    const tampered = (await readFile(importedManifest, "utf8")).replace(
      "name: Investing",
      "name: Tampered",
    );
    await writeFile(importedManifest, tampered, "utf8");
    const refused = await invoke(["apply", "--dsh-home", targetHome]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/archive lock mismatch/i);
  });

  it("requires pinned Git revisions before attempting source access", async () => {
    const dshHome = await temporaryHome();
    const result = await invoke([
      "agent",
      "add",
      "github:example/setups/research",
      "--rev",
      "main",
      "--dsh-home",
      dshHome,
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/full commit SHA/i);
  });

  it("reports shipped setups as current and can explicitly re-apply them", async () => {
    const dshHome = await temporaryHome();
    expect((await invoke(["init", "--dsh-home", dshHome])).code).toBe(0);
    const planned = await invoke(["update", "--dsh-home", dshHome]);
    expect(planned).toEqual({
      code: 0,
      stdout: "Built-in setups are current at 0.1.0. No changes applied.\n",
      stderr: "",
    });

    const applied = await invoke(["update", "--apply", "--dsh-home", dshHome]);
    expect(applied).toMatchObject({ code: 0, stderr: "" });
    expect(applied.stdout).toContain("Applied current built-in setups");
  });

  it("supports deterministic JSON for state changes and idempotent apply", async () => {
    const dshHome = await temporaryHome();
    const initialized = await invoke(["init", "--json", "--dsh-home", dshHome]);
    expect(JSON.parse(initialized.stdout)).toMatchObject({
      command: "init",
      changed: true,
      presetIds: [
        "oh-my-dsh-coding",
        "oh-my-dsh-investing",
        "oh-my-dsh-research",
      ],
    });

    const applied = await invoke(["apply", "--json", "--dsh-home", dshHome]);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      command: "apply",
      changed: false,
    });

    const switched = await invoke([
      "use",
      "investing",
      "--default",
      "--json",
      "--dsh-home",
      dshHome,
    ]);
    expect(JSON.parse(switched.stdout)).toMatchObject({
      command: "use",
      current: "investing",
    });
    const update = await invoke(["update", "--json", "--dsh-home", dshHome]);
    expect(JSON.parse(update.stdout)).toEqual({
      command: "update",
      version: "0.1.0",
      changes: [],
      applied: false,
    });
  });

  it("validates stateful command operands before mutating", async () => {
    const dshHome = await temporaryHome();
    const cases: Array<[string[], number, RegExp]> = [
      [["init", "extra"], 2, /Unexpected argument/],
      [["apply", "--force"], 2, /Unknown option/],
      [["use", "coding"], 2, /requires --default/],
      [["use", "--default"], 2, /requires a setup/],
      [["use", "missing", "--default"], 2, /Unknown setup/],
      [["doctor", "extra"], 2, /Unexpected argument/],
      [["rollback", "extra"], 2, /Unexpected argument/],
      [["update", "extra"], 2, /Unexpected argument/],
      [["agent"], 2, /requires fork, save/],
      [["agent", "publish"], 2, /Unknown agent command/],
      [["agent", "fork", "coding"], 2, /requires --as/],
      [["agent", "save"], 2, /requires a setup slug/],
      [["agent", "export"], 2, /requires a setup slug/],
      [["agent", "import"], 2, /requires an archive path/],
      [["agent", "add"], 2, /requires github/],
    ];

    for (const [args, code, message] of cases) {
      const result = await invoke([...args, "--dsh-home", dshHome]);
      expect(result.code, args.join(" ")).toBe(code);
      expect(result.stderr, args.join(" ")).toMatch(message);
    }
    await expect(invoke(["init", "--dsh-home"])).resolves.toMatchObject({
      code: 2,
      stderr: expect.stringMatching(/requires a path/),
    });
  });

  it("imports data-only full setups with declared portable text assets", async () => {
    const dshHome = await temporaryHome();
    const archivePath = join(dshHome, "writer.omdsh-agent");
    const setup = parseAgentSetup({
      ...structuredClone(agentSetups.coding),
      metadata: {
        ...agentSetups.coding.metadata,
        id: "com.example.writer",
        name: "Writer",
      },
      persona: { file: "persona.md" },
      instructions: { files: ["instructions/style.md"] },
      examples: ["examples/example.md"],
    });
    const archive = createAgentArchive({
      setup,
      lock: {
        setupId: setup.metadata.id,
        setupVersion: setup.metadata.version,
        normalizedHash: computeArchiveSetupHash(setup),
        adapter: { id: "dsh-rc5", version: "0.1.0" },
        dshCompatibility: setup.compatibility.dsh,
        capabilities: setup.capabilities,
      },
      files: [
        { path: "persona.md", content: "Write with clarity." },
        {
          path: "instructions/style.md",
          content: "Prefer concrete language.",
        },
        { path: "examples/example.md", content: "A concise example." },
      ],
    });
    await writeFile(archivePath, archive);

    const imported = await invoke([
      "agent",
      "import",
      archivePath,
      "--yes",
      "--json",
      "--dsh-home",
      dshHome,
    ]);
    expect(JSON.parse(imported.stdout)).toMatchObject({
      id: "com.example.writer",
      slug: "writer",
      confirmed: true,
    });
    expect(
      (await invoke(["apply", "--json", "--dsh-home", dshHome])).code,
    ).toBe(0);
    const composition = await readFile(
      join(dshHome, ".agent-presets", "oh-my-dsh-writer", "agent.cordis.yml"),
      "utf8",
    );
    expect(composition).toContain("Write with clarity.");
    expect(composition).toContain("Prefer concrete language.");
  });

  it("reports an unhealthy clean home and a safe rollback failure", async () => {
    const dshHome = await temporaryHome();
    const doctor = await invoke(["doctor", "--json", "--dsh-home", dshHome]);
    expect(doctor.code).toBe(1);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      command: "doctor",
      ok: false,
    });
    const rollback = await invoke(["rollback", "--dsh-home", dshHome]);
    expect(rollback.code).toBe(1);
    expect(rollback.stderr).toMatch(/^Error: /);
  });

  it("bounds archive reads and refuses an agents-root symlink", async () => {
    const dshHome = await temporaryHome();
    const oversized = join(dshHome, "oversized.omdsh-agent");
    await writeFile(oversized, Buffer.alloc(16 * 1024 * 1024 + 1));
    const rejectedArchive = await invoke([
      "agent",
      "import",
      oversized,
      "--yes",
      "--dsh-home",
      dshHome,
    ]);
    expect(rejectedArchive.code).toBe(1);
    expect(rejectedArchive.stderr).toMatch(/byte limit/i);

    const linkedHome = await temporaryHome();
    const outside = await temporaryHome();
    await mkdir(join(linkedHome, "oh-my-dsh"));
    await symlink(outside, join(linkedHome, "oh-my-dsh", "agents"));
    const rejectedLink = await invoke([
      "agent",
      "fork",
      "coding",
      "--as",
      "linked",
      "--dsh-home",
      linkedHome,
    ]);
    expect(rejectedLink.code).toBe(1);
    expect(rejectedLink.stderr).toMatch(/agents root.*regular directory/i);
  });
});
