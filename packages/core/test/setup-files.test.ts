import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import { agentSetups, capabilityPacks } from "@oh-my-dsh/catalog";

import {
  createFork,
  listCustomSetups,
  loadCustomSetup,
  saveCustomSetup,
  type SetupCatalog,
} from "../src/setup-files.js";

const homes: string[] = [];
const catalog: SetupCatalog = {
  setups: agentSetups,
  capabilities: capabilityPacks,
};

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "oh-my-dsh-setup-files-"));
  homes.push(path);
  return path;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    homes.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("custom setup files", () => {
  it("handles absent roots and refuses an unsafe managed root", async () => {
    const dshHome = await home();

    await expect(listCustomSetups(dshHome)).resolves.toEqual([]);
    await expect(loadCustomSetup(dshHome, "missing")).rejects.toThrow(
      /does not exist/i,
    );
    await expect(
      createFork(dshHome, "missing", "mine", undefined, catalog),
    ).rejects.toThrow(/unknown built-in/i);

    const target = await home();
    await mkdir(join(dshHome, "oh-my-dsh"));
    await symlink(target, join(dshHome, "oh-my-dsh", "agents"));
    await expect(
      createFork(dshHome, "coding", "mine", undefined, catalog),
    ).rejects.toThrow(/agents root.*regular directory/i);
  });

  it("forks a built-in into a minimal, user-owned YAML delta", async () => {
    const dshHome = await home();
    const created = await createFork(
      dshHome,
      "investing",
      "long-term",
      "Long-Term Investing",
      catalog,
    );
    const yaml = parse(await readFile(created.manifestPath, "utf8"));

    expect(yaml).toEqual({
      apiVersion: "omdsh.dev/v1alpha1",
      kind: "AgentSetupFork",
      metadata: {
        id: "local.long-term",
        name: "Long-Term Investing",
        version: "0.1.0",
        license: "MIT",
      },
      extends: { id: "dev.oh-my-dsh.investing", version: "0.1.0" },
      overrides: {
        instructions: { append: [] },
        workflows: { enable: [], disable: [] },
        permissions: { brokerage: "deny" },
      },
    });
    expect(
      (await listCustomSetups(dshHome)).map((setup) => setup.metadata.id),
    ).toEqual(["local.long-term"]);
  });

  it("refuses unsafe slugs and existing destinations", async () => {
    const dshHome = await home();
    await expect(
      createFork(dshHome, "investing", "../escape", undefined, catalog),
    ).rejects.toThrow(/slug/i);
    await createFork(dshHome, "investing", "mine", undefined, catalog);
    await expect(
      createFork(dshHome, "investing", "mine", undefined, catalog),
    ).rejects.toThrow(/exists/i);
  });

  it("validates and locks a saved fork without rewriting its manifest", async () => {
    const dshHome = await home();
    const created = await createFork(
      dshHome,
      "investing",
      "mine",
      undefined,
      catalog,
    );
    const fork = await loadCustomSetup(dshHome, "mine");
    fork.overrides.instructions = { append: ["Use a five-year horizon."] };
    const edited = stringify(fork, { lineWidth: 0 });
    await writeFile(created.manifestPath, edited, "utf8");

    const saved = await saveCustomSetup(dshHome, "mine", catalog);

    expect(saved.resolved.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(await readFile(saved.lockPath, "utf8"))).toMatchObject({
      apiVersion: "omdsh.dev/lock/v1alpha1",
      setup: { id: "local.mine", version: "0.1.0" },
      normalizedHash: saved.resolved.hash,
      adapter: { id: "dsh-rc5", dsh: ">=0.1.0-rc.5 <0.2.0" },
    });
    expect(await readFile(created.manifestPath, "utf8")).toBe(edited);
  });

  it("rejects unsafe portable content before writing a lock", async () => {
    const dshHome = await home();
    const created = await createFork(
      dshHome,
      "investing",
      "unsafe",
      undefined,
      catalog,
    );
    const fork = await loadCustomSetup(dshHome, "unsafe");
    fork.overrides.instructions = {
      append: ["password=literal-secret-value"],
    };
    await writeFile(created.manifestPath, stringify(fork), "utf8");

    await expect(saveCustomSetup(dshHome, "unsafe", catalog)).rejects.toThrow(
      /credential/i,
    );
    await expect(
      readFile(join(created.directory, "omdsh.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a fork whose parent is not in the active catalog", async () => {
    const dshHome = await home();
    const created = await createFork(
      dshHome,
      "investing",
      "orphaned",
      undefined,
      catalog,
    );
    const fork = await loadCustomSetup(dshHome, "orphaned");
    fork.extends.id = "dev.example.missing";
    await writeFile(created.manifestPath, stringify(fork), "utf8");

    await expect(saveCustomSetup(dshHome, "orphaned", catalog)).rejects.toThrow(
      /unknown fork parent/i,
    );
  });
});
