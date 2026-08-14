import { describe, expect, it } from "vitest";

import { agentSetups, capabilityPacks } from "@oh-my-dsh/catalog";
import { CustomAgentSetupSchema } from "@oh-my-dsh/schema";

import {
  resolveCustomSetup,
  resolveSetup,
  semanticDiff,
} from "../src/index.js";

describe("resolveSetup", () => {
  it("resolves Coding deterministically with least-authority policy", () => {
    const first = resolveSetup(agentSetups.coding, capabilityPacks);
    const second = resolveSetup(
      agentSetups.coding,
      [...capabilityPacks].reverse(),
    );

    expect(first.hash).toBe(second.hash);
    expect(first.capabilities.map((capability) => capability.id)).toEqual([
      "dev.oh-my-dsh.core-safety",
      "dev.oh-my-dsh.repository-tools",
    ]);
    expect(first.tools.allow).toContain("filesystem.read");
    expect(first.tools.allow).not.toContain("browser.automate");
    expect(first.permissions.destructive).toBe("deny");
    expect(first.permissions.secrets).toBe("deny");
  });

  it("fails dependency cycles with an actionable path", () => {
    const core = capabilityPacks.find(
      (pack) => pack.metadata.id === "dev.oh-my-dsh.core-safety",
    )!;
    const repository = capabilityPacks.find(
      (pack) => pack.metadata.id === "dev.oh-my-dsh.repository-tools",
    )!;
    const cyclic = [
      {
        ...core,
        dependencies: [
          { id: repository.metadata.id, version: repository.metadata.version },
        ],
      },
      {
        ...repository,
        dependencies: [
          { id: core.metadata.id, version: core.metadata.version },
        ],
      },
    ];

    expect(() => resolveSetup(agentSetups.coding, cyclic)).toThrow(
      /dependency cycle.*core-safety.*repository-tools/i,
    );
  });

  it("ships exactly three distinct built-ins", () => {
    expect(Object.keys(agentSetups).sort()).toEqual([
      "coding",
      "investing",
      "research",
    ]);
    const hashes = Object.values(agentSetups).map(
      (setup) => resolveSetup(setup, capabilityPacks).hash,
    );
    expect(new Set(hashes).size).toBe(3);
  });

  it("keeps Research networked but removes shell and filesystem write tools", () => {
    const research = resolveSetup(agentSetups.research, capabilityPacks);

    expect(research.permissions.network).toBe("allow");
    expect(research.permissions.filesystem).toBe("read-only");
    expect(research.permissions.shell).toBe("deny");
    expect(research.tools.allow).toContain("web.search");
    expect(research.tools.allow).not.toContain("shell.execute");
    expect(research.tools.allow).not.toContain("filesystem.write");
  });

  it("keeps Investing read-only and unable to trade", () => {
    const investing = resolveSetup(agentSetups.investing, capabilityPacks);

    expect(investing.permissions.brokerage).toBe("deny");
    expect(investing.tools.deny).toContain("brokerage.execute");
    expect(investing.tools.allow).toContain("financial.calculate");
  });

  it("never inherits secret access and lets root output conventions override capability defaults", () => {
    const first = capabilityPacks.find(
      (pack) => pack.metadata.id === "dev.oh-my-dsh.core-safety",
    )!;
    const unsafeCapability = {
      ...first,
      permissions: { ...first.permissions, secrets: "allow" as const },
      output: { conventions: ["Capability-only convention."] },
    };
    const { secrets: ignored, ...rootPermissions } =
      agentSetups.coding.permissions;
    void ignored;
    const setup = {
      ...agentSetups.coding,
      capabilities: [
        {
          id: unsafeCapability.metadata.id,
          version: unsafeCapability.metadata.version,
        },
      ],
      permissions: rootPermissions,
      output: { conventions: ["Root convention."] },
    };

    const resolved = resolveSetup(setup, [
      ...capabilityPacks.filter(
        (pack) => pack.metadata.id !== unsafeCapability.metadata.id,
      ),
      unsafeCapability,
    ]);

    expect(resolved.permissions.secrets).toBe("deny");
    expect(resolved.output.conventions).toEqual(["Root convention."]);
  });

  it("maps every allowed tool to at least one workflow", () => {
    for (const setup of Object.values(agentSetups)) {
      const resolved = resolveSetup(setup, capabilityPacks);
      const workflowTools = new Set(
        resolved.workflows.flatMap((workflow) => workflow.tools),
      );
      expect(
        resolved.tools.allow.filter((tool) => !workflowTools.has(tool)),
        setup.metadata.name,
      ).toEqual([]);
    }
  });

  it("resolves a fork as a minimal user-owned delta without changing its parent", () => {
    const parentBefore = resolveSetup(agentSetups.investing, capabilityPacks);
    const custom = CustomAgentSetupSchema.parse({
      apiVersion: "omdsh.dev/v1alpha1",
      kind: "AgentSetupFork",
      metadata: {
        id: "local.long-term",
        name: "Long-Term",
        version: "0.1.0",
        license: "MIT",
      },
      extends: { id: "dev.oh-my-dsh.investing", version: "0.1.0" },
      overrides: {
        instructions: {
          append: ["Always include a reverse-DCF expectation check."],
        },
        workflows: { enable: [], disable: [] },
        permissions: { brokerage: "deny" },
      },
    });

    const resolved = resolveCustomSetup(
      custom,
      agentSetups.investing,
      capabilityPacks,
    );
    const diff = semanticDiff(parentBefore, resolved);

    expect(resolved.metadata.id).toBe("local.long-term");
    expect(diff).toMatchObject({
      instructionsAdded: ["Always include a reverse-DCF expectation check."],
      instructionsRemoved: [],
      permissionChanges: {},
    });
    expect(resolveSetup(agentSetups.investing, capabilityPacks)).toEqual(
      parentBefore,
    );
  });

  it("rejects a fork whose parent version does not match", () => {
    const custom = CustomAgentSetupSchema.parse({
      apiVersion: "omdsh.dev/v1alpha1",
      kind: "AgentSetupFork",
      metadata: {
        id: "local.bad",
        name: "Bad",
        version: "0.1.0",
        license: "MIT",
      },
      extends: { id: "dev.oh-my-dsh.investing", version: "9.9.9" },
      overrides: {},
    });

    expect(() =>
      resolveCustomSetup(custom, agentSetups.investing, capabilityPacks),
    ).toThrow(/parent version/i);
  });

  it("removes tools forbidden by fork permissions and blocks setup-level data export", () => {
    const shellDenied = CustomAgentSetupSchema.parse({
      apiVersion: "omdsh.dev/v1alpha1",
      kind: "AgentSetupFork",
      metadata: {
        id: "local.no-shell",
        name: "No Shell",
        version: "0.1.0",
        license: "MIT",
      },
      extends: { id: "dev.oh-my-dsh.coding", version: "0.1.0" },
      overrides: { permissions: { shell: "deny" } },
    });
    const resolved = resolveCustomSetup(
      shellDenied,
      agentSetups.coding,
      capabilityPacks,
    );
    expect(resolved.tools.allow).not.toContain("shell.execute");
    expect(resolved.tools.allow).not.toContain("test.run");
    expect(resolved.tools.deny).toContain("shell.execute");

    const dataExport = {
      ...agentSetups.research,
      permissions: {
        ...agentSetups.research.permissions,
        dataExport: "allow" as const,
      },
      permissionElevations: {
        ...agentSetups.research.permissionElevations,
        dataExport: "The user requested export.",
      },
    };
    expect(() => resolveSetup(dataExport, capabilityPacks)).toThrow(
      /cannot enable data export/i,
    );
  });
});
