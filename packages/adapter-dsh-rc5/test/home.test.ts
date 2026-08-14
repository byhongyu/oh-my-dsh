import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { agentSetups, capabilityPacks } from "@oh-my-dsh/catalog";
import { resolveSetup, type ResolvedSetup } from "@oh-my-dsh/core";

import {
  doctorDshHome,
  installResolvedSetups,
  resolveDshHome,
  rollbackDshHome,
  type FileMutation,
} from "../src/home.js";

const homes: string[] = [];

async function temporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "oh-my-dsh-home-"));
  homes.push(directory);
  return directory;
}

function setups(): Record<"coding" | "research", ResolvedSetup> {
  return {
    coding: resolveSetup(agentSetups.coding, capabilityPacks),
    research: resolveSetup(agentSetups.research, capabilityPacks),
  };
}

function changed(setup: ResolvedSetup): ResolvedSetup {
  return {
    ...setup,
    persona: `${setup.persona}\nThis is a deliberately changed generation.`,
    hash: `${setup.hash}-changed`,
  };
}

afterEach(async () => {
  await Promise.all(
    homes
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("resolveDshHome", () => {
  it("uses explicit, non-blank DSH_HOME, and home-directory values in priority order", () => {
    expect(
      resolveDshHome({
        explicit: "/explicit/dsh",
        env: { DSH_HOME: "/environment/dsh" },
        homeDirectory: "/users/example",
      }),
    ).toBe("/explicit/dsh");
    expect(
      resolveDshHome({
        env: { DSH_HOME: "/environment/dsh" },
        homeDirectory: "/users/example",
      }),
    ).toBe("/environment/dsh");
    expect(
      resolveDshHome({
        explicit: "  ",
        env: { DSH_HOME: "\t" },
        homeDirectory: "/users/example",
      }),
    ).toBe(join("/users/example", ".dsh"));
  });
});

describe("DSH home generations", () => {
  it("installs a complete immutable generation and publishes namespaced presets", async () => {
    const dshHome = await temporaryHome();
    const { coding, research } = setups();

    const result = await installResolvedSetups({
      dshHome,
      setups: [research, coding],
      defaultSetupId: coding.metadata.id,
    });

    expect(result.changed).toBe(true);
    expect(result.presetIds).toEqual([
      "oh-my-dsh-coding",
      "oh-my-dsh-research",
    ]);
    expect(await readFile(join(dshHome, "oh-my-dsh", "active"), "utf8")).toBe(
      `${result.generationId}\n`,
    );
    await expect(
      readFile(join(dshHome, "oh-my-dsh", "previous"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const generation = join(
      dshHome,
      "oh-my-dsh",
      "generations",
      result.generationId,
    );
    const manifest = JSON.parse(
      await readFile(join(generation, "manifest.json"), "utf8"),
    ) as {
      generationId: string;
      defaultPresetId: string;
      presets: Array<{ id: string }>;
    };
    const checksums = JSON.parse(
      await readFile(join(generation, "checksums.json"), "utf8"),
    ) as Record<string, string>;
    expect(manifest).toMatchObject({
      generationId: result.generationId,
      defaultPresetId: "oh-my-dsh-coding",
      presets: [{ id: "oh-my-dsh-coding" }, { id: "oh-my-dsh-research" }],
    });
    expect(Object.keys(checksums).sort()).toEqual([
      "manifest.json",
      "presets/oh-my-dsh-coding/agent.cordis.yml",
      "presets/oh-my-dsh-coding/preset.yml",
      "presets/oh-my-dsh-research/agent.cordis.yml",
      "presets/oh-my-dsh-research/preset.yml",
    ]);
    expect((await stat(generation)).isDirectory()).toBe(true);
    expect(
      await readFile(
        join(dshHome, ".agent-presets", "oh-my-dsh-coding", "agent.cordis.yml"),
        "utf8",
      ),
    ).toContain("@deepseek-ai/dsh-persona");
  });

  it("is mutation-free and returns the same generation for identical content", async () => {
    const dshHome = await temporaryHome();
    const { coding } = setups();
    const first = await installResolvedSetups({
      dshHome,
      setups: [coding],
      defaultSetupId: "coding",
    });
    const mutations: FileMutation[] = [];

    const second = await installResolvedSetups({
      dshHome,
      setups: [coding],
      defaultSetupId: "oh-my-dsh-coding",
      onMutation: (mutation) => mutations.push(mutation),
    });

    expect(second).toMatchObject({
      changed: false,
      generationId: first.generationId,
    });
    expect(mutations).toEqual([]);
  });

  it("publishes the complete list and removes only stale namespaced presets", async () => {
    const dshHome = await temporaryHome();
    const { coding, research } = setups();
    const native = join(dshHome, ".agent-presets", "my-native-preset");
    await mkdir(native, { recursive: true });
    await writeFile(join(native, "preset.yml"), "name: Native\n");
    await installResolvedSetups({
      dshHome,
      setups: [coding, research],
      defaultSetupId: "coding",
    });

    await installResolvedSetups({
      dshHome,
      setups: [coding],
      defaultSetupId: "coding",
    });

    await expect(
      stat(join(dshHome, ".agent-presets", "oh-my-dsh-research")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(native, "preset.yml"), "utf8")).toBe(
      "name: Native\n",
    );
  });

  it("rolls back already-replaced preset directories when publication fails", async () => {
    const dshHome = await temporaryHome();
    const { coding, research } = setups();
    const first = await installResolvedSetups({
      dshHome,
      setups: [coding],
      defaultSetupId: "coding",
    });
    const publishedPath = join(
      dshHome,
      ".agent-presets",
      "oh-my-dsh-coding",
      "agent.cordis.yml",
    );
    const originalPreset = await readFile(publishedPath, "utf8");

    await expect(
      installResolvedSetups({
        dshHome,
        setups: [changed(coding), research],
        defaultSetupId: "coding",
        onMutation: (mutation) => {
          if (
            mutation.operation === "publish-preset" &&
            mutation.path.endsWith("oh-my-dsh-research")
          ) {
            throw new Error("injected publish failure");
          }
        },
      }),
    ).rejects.toThrow("injected publish failure");

    expect(await readFile(publishedPath, "utf8")).toBe(originalPreset);
    await expect(
      stat(join(dshHome, ".agent-presets", "oh-my-dsh-research")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(dshHome, "oh-my-dsh", "active"), "utf8")).toBe(
      `${first.generationId}\n`,
    );
  });

  it("restores presets and settings when the final active-marker write fails", async () => {
    const dshHome = await temporaryHome();
    const { coding } = setups();
    const originalSettings = "# keep exactly\ntheme: dark\n";
    await writeFile(join(dshHome, "settings.yaml"), originalSettings);

    await expect(
      installResolvedSetups({
        dshHome,
        setups: [coding],
        defaultSetupId: "coding",
        onMutation: (mutation) => {
          if (mutation.operation === "write-active-marker")
            throw new Error("injected marker failure");
        },
      }),
    ).rejects.toThrow("injected marker failure");

    expect(await readFile(join(dshHome, "settings.yaml"), "utf8")).toBe(
      originalSettings,
    );
    await expect(
      stat(join(dshHome, ".agent-presets", "oh-my-dsh-coding")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(dshHome, "oh-my-dsh", "active"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the previous generation bootable when every observable update mutation is failed in turn", async () => {
    const { coding, research } = setups();
    const sampleHome = await temporaryHome();
    await installResolvedSetups({
      dshHome: sampleHome,
      setups: [coding],
      defaultSetupId: "coding",
    });
    const mutations: FileMutation[] = [];
    await installResolvedSetups({
      dshHome: sampleHome,
      setups: [changed(coding), research],
      defaultSetupId: "research",
      onMutation: (mutation) => mutations.push(mutation),
    });
    expect(mutations.at(-1)?.operation).toBe("write-active-marker");

    for (const [failureIndex, expectedMutation] of mutations.entries()) {
      const dshHome = await temporaryHome();
      const baseline = await installResolvedSetups({
        dshHome,
        setups: [coding],
        defaultSetupId: "coding",
      });
      let mutationIndex = 0;
      await expect(
        installResolvedSetups({
          dshHome,
          setups: [changed(coding), research],
          defaultSetupId: "research",
          onMutation: () => {
            if (mutationIndex++ === failureIndex)
              throw new Error(`injected ${expectedMutation.operation}`);
          },
        }),
      ).rejects.toThrow(`injected ${expectedMutation.operation}`);
      expect(await readFile(join(dshHome, "oh-my-dsh", "active"), "utf8")).toBe(
        `${baseline.generationId}\n`,
      );
      expect(await doctorDshHome({ dshHome })).toMatchObject({
        ok: true,
        activeGeneration: baseline.generationId,
      });
      expect(await readFile(join(dshHome, "settings.yaml"), "utf8")).toContain(
        "default: oh-my-dsh-coding",
      );
    }
  });

  it("retains the previous generation and can atomically roll back to it", async () => {
    const dshHome = await temporaryHome();
    const { coding } = setups();
    const first = await installResolvedSetups({
      dshHome,
      setups: [coding],
      defaultSetupId: "coding",
    });
    const firstPreset = await readFile(
      join(dshHome, ".agent-presets", "oh-my-dsh-coding", "agent.cordis.yml"),
      "utf8",
    );
    const second = await installResolvedSetups({
      dshHome,
      setups: [changed(coding)],
      defaultSetupId: "coding",
    });
    expect(second.generationId).not.toBe(first.generationId);
    expect(await readFile(join(dshHome, "oh-my-dsh", "previous"), "utf8")).toBe(
      `${first.generationId}\n`,
    );

    const rolledBack = await rollbackDshHome({ dshHome });

    expect(rolledBack).toMatchObject({
      activeGeneration: first.generationId,
      previousGeneration: second.generationId,
    });
    expect(
      await readFile(
        join(dshHome, ".agent-presets", "oh-my-dsh-coding", "agent.cordis.yml"),
        "utf8",
      ),
    ).toBe(firstPreset);
  });

  it("reports corruption in active generation checksums and published managed files", async () => {
    const dshHome = await temporaryHome();
    const { coding } = setups();
    const installed = await installResolvedSetups({
      dshHome,
      setups: [coding],
      defaultSetupId: "coding",
    });
    const generationFile = join(
      dshHome,
      "oh-my-dsh",
      "generations",
      installed.generationId,
      "presets",
      "oh-my-dsh-coding",
      "preset.yml",
    );
    const publishedFile = join(
      dshHome,
      ".agent-presets",
      "oh-my-dsh-coding",
      "agent.cordis.yml",
    );
    await writeFile(generationFile, "corrupt generation\n");
    await writeFile(publishedFile, "corrupt publication\n");

    const report = await doctorDshHome({ dshHome });

    expect(report.ok).toBe(false);
    expect(report.activeGeneration).toBe(installed.generationId);
    expect(report.issues.join("\n")).toMatch(/checksum mismatch.*preset\.yml/i);
    expect(report.issues.join("\n")).toMatch(
      /managed preset mismatch.*agent\.cordis\.yml/i,
    );
  });

  it("rejects a generation whose checksum index omits a manifest file", async () => {
    const dshHome = await temporaryHome();
    const { coding } = setups();
    const first = await installResolvedSetups({
      dshHome,
      setups: [coding],
      defaultSetupId: "coding",
    });
    await installResolvedSetups({
      dshHome,
      setups: [changed(coding)],
      defaultSetupId: "coding",
    });
    const checksumPath = join(first.generationPath, "checksums.json");
    const checksums = JSON.parse(
      await readFile(checksumPath, "utf8"),
    ) as Record<string, string>;
    delete checksums["presets/oh-my-dsh-coding/preset.yml"];
    await writeFile(checksumPath, `${JSON.stringify(checksums, null, 2)}\n`);

    await expect(rollbackDshHome({ dshHome })).rejects.toThrow(
      /checksum entry missing.*preset\.yml/i,
    );
  });

  it("reports a clean installation and missing lifecycle state", async () => {
    const missingHome = await temporaryHome();
    expect(await doctorDshHome({ dshHome: missingHome })).toEqual({
      ok: false,
      issues: ["active generation marker is missing"],
    });

    const dshHome = await temporaryHome();
    const { coding } = setups();
    const installed = await installResolvedSetups({
      dshHome,
      setups: [coding],
      defaultSetupId: "coding",
    });
    expect(await doctorDshHome({ dshHome })).toEqual({
      ok: true,
      activeGeneration: installed.generationId,
      issues: [],
    });
    await rm(join(dshHome, ".agent-presets", "oh-my-dsh-coding", "preset.yml"));
    await mkdir(join(dshHome, ".agent-presets", "oh-my-dsh-unexpected"));
    const damaged = await doctorDshHome({ dshHome });
    expect(damaged.issues.join("\n")).toMatch(
      /managed preset missing.*preset\.yml/i,
    );
    expect(damaged.issues.join("\n")).toMatch(
      /unexpected managed preset.*oh-my-dsh-unexpected/i,
    );
    await expect(rollbackDshHome({ dshHome })).rejects.toThrow(
      /no previous generation/i,
    );
  });

  it("rejects empty catalogs and defaults outside the complete installed list", async () => {
    const dshHome = await temporaryHome();
    const { coding } = setups();
    await expect(
      installResolvedSetups({ dshHome, setups: [], defaultSetupId: "coding" }),
    ).rejects.toThrow(/at least one resolved setup/i);
    await expect(
      installResolvedSetups({
        dshHome,
        setups: [coding],
        defaultSetupId: "research",
      }),
    ).rejects.toThrow(/default setup is not installed/i);
  });
});

describe("DSH settings", () => {
  it("changes only agent-presets.default while preserving sibling keys and comments", async () => {
    const dshHome = await temporaryHome();
    const { coding } = setups();
    await writeFile(
      join(dshHome, "settings.yaml"),
      "# user heading\nprovider: deepseek # keep provider\nagent-presets:\n  default: native\n  show-hidden: true # keep sibling\ntheme: dark\n",
    );

    await installResolvedSetups({
      dshHome,
      setups: [coding],
      defaultSetupId: "coding",
    });

    const settings = await readFile(join(dshHome, "settings.yaml"), "utf8");
    expect(settings).toContain("# user heading");
    expect(settings).toContain("provider: deepseek # keep provider");
    expect(settings).toContain("default: oh-my-dsh-coding");
    expect(settings).toContain("show-hidden: true # keep sibling");
    expect(settings).toContain("theme: dark");
  });

  it("refuses a settings symlink and an existing settings lock", async () => {
    const { coding } = setups();
    const symlinkHome = await temporaryHome();
    const outside = join(await temporaryHome(), "outside.yaml");
    await writeFile(outside, "theme: safe\n");
    await symlink(outside, join(symlinkHome, "settings.yaml"));

    await expect(
      installResolvedSetups({
        dshHome: symlinkHome,
        setups: [coding],
        defaultSetupId: "coding",
      }),
    ).rejects.toThrow(/settings\.yaml.*symbolic link/i);
    expect(await readFile(outside, "utf8")).toBe("theme: safe\n");

    const lockedHome = await temporaryHome();
    await writeFile(
      join(lockedHome, "settings.yaml.lock"),
      "host owns this lock\n",
    );
    await expect(
      installResolvedSetups({
        dshHome: lockedHome,
        setups: [coding],
        defaultSetupId: "coding",
      }),
    ).rejects.toThrow(/settings\.yaml\.lock.*exists/i);
  });

  it("refuses symlinks in managed generation and marker paths", async () => {
    const { coding } = setups();
    const managedLinkHome = await temporaryHome();
    const outsideManaged = await temporaryHome();
    await symlink(outsideManaged, join(managedLinkHome, "oh-my-dsh"));
    await expect(
      installResolvedSetups({
        dshHome: managedLinkHome,
        setups: [coding],
        defaultSetupId: "coding",
      }),
    ).rejects.toThrow(/managed root.*symbolic link/i);

    const generationLinkHome = await temporaryHome();
    const outsideGenerations = await temporaryHome();
    await mkdir(join(generationLinkHome, "oh-my-dsh"));
    await symlink(
      outsideGenerations,
      join(generationLinkHome, "oh-my-dsh", "generations"),
    );
    await expect(
      installResolvedSetups({
        dshHome: generationLinkHome,
        setups: [coding],
        defaultSetupId: "coding",
      }),
    ).rejects.toThrow(/generations root.*symbolic link/i);

    const markerLinkHome = await temporaryHome();
    await installResolvedSetups({
      dshHome: markerLinkHome,
      setups: [coding],
      defaultSetupId: "coding",
    });
    const outsideMarker = join(await temporaryHome(), "outside-active");
    await writeFile(outsideMarker, "outside\n");
    await rm(join(markerLinkHome, "oh-my-dsh", "active"));
    await symlink(outsideMarker, join(markerLinkHome, "oh-my-dsh", "active"));
    await expect(
      installResolvedSetups({
        dshHome: markerLinkHome,
        setups: [coding],
        defaultSetupId: "coding",
      }),
    ).rejects.toThrow(/active.*symbolic link/i);
  });

  it("serializes operations and recovers publication after a stale process lock", async () => {
    const dshHome = await temporaryHome();
    const { coding } = setups();
    const managedRoot = join(dshHome, "oh-my-dsh");
    await mkdir(managedRoot);
    await writeFile(
      join(managedRoot, "operation.lock"),
      `${JSON.stringify({ pid: process.pid, token: "live" })}\n`,
    );
    await expect(
      installResolvedSetups({
        dshHome,
        setups: [coding],
        defaultSetupId: "coding",
      }),
    ).rejects.toThrow(/operation is running/i);

    await writeFile(
      join(managedRoot, "operation.lock"),
      `${JSON.stringify({ pid: 2_147_483_647, token: "stale" })}\n`,
    );
    await installResolvedSetups({
      dshHome,
      setups: [coding],
      defaultSetupId: "coding",
    });
    const published = join(
      dshHome,
      ".agent-presets",
      "oh-my-dsh-coding",
      "preset.yml",
    );
    await writeFile(published, "corrupt after simulated crash\n");
    await mkdir(join(dshHome, ".agent-presets", ".oh-my-dsh-stage-stale"));
    await writeFile(
      join(managedRoot, "operation.lock"),
      `${JSON.stringify({ pid: 2_147_483_647, token: "stale-again" })}\n`,
    );

    await installResolvedSetups({
      dshHome,
      setups: [coding],
      defaultSetupId: "coding",
    });

    expect(await doctorDshHome({ dshHome })).toMatchObject({ ok: true });
    await expect(
      stat(join(dshHome, ".agent-presets", ".oh-my-dsh-stage-stale")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses malformed or structurally incompatible settings instead of reserializing them", async () => {
    const { coding } = setups();
    const malformedHome = await temporaryHome();
    await writeFile(
      join(malformedHome, "settings.yaml"),
      "theme: [unterminated\n",
    );
    await expect(
      installResolvedSetups({
        dshHome: malformedHome,
        setups: [coding],
        defaultSetupId: "coding",
      }),
    ).rejects.toThrow(/cannot parse settings\.yaml/i);

    const scalarHome = await temporaryHome();
    await writeFile(
      join(scalarHome, "settings.yaml"),
      "agent-presets: disabled\n",
    );
    await expect(
      installResolvedSetups({
        dshHome: scalarHome,
        setups: [coding],
        defaultSetupId: "coding",
      }),
    ).rejects.toThrow(/agent-presets is not a map/i);
  });
});
