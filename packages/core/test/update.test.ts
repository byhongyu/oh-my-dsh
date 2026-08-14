import { describe, expect, it } from "vitest";

import { agentSetups, capabilityPacks } from "@oh-my-dsh/catalog";
import { CustomAgentSetupSchema, type AgentSetup } from "@oh-my-dsh/schema";

import { planForkUpdate } from "../src/update.js";

function fork(disable: string[] = []) {
  return CustomAgentSetupSchema.parse({
    apiVersion: "omdsh.dev/v1alpha1",
    kind: "AgentSetupFork",
    metadata: {
      id: "local.mine",
      name: "Mine",
      version: "0.1.0",
      license: "MIT",
    },
    extends: { id: "dev.oh-my-dsh.investing", version: "0.1.0" },
    overrides: {
      instructions: { append: ["Keep my five-year lens."] },
      workflows: { enable: [], disable },
      permissions: { brokerage: "deny" },
    },
  });
}

function nextParent(): AgentSetup {
  return {
    ...structuredClone(agentSetups.investing),
    metadata: { ...agentSetups.investing.metadata, version: "0.2.0" },
    instructions: {
      inline: [
        ...(agentSetups.investing.instructions.inline ?? []),
        "Verify filing source provenance.",
      ],
    },
  };
}

describe("fork update planning", () => {
  it("rebases a compatible fork without overwriting its overrides", () => {
    const original = fork();
    const result = planForkUpdate(
      original,
      agentSetups.investing,
      nextParent(),
      capabilityPacks,
    );

    expect(result.conflicts).toEqual([]);
    expect(result.candidate?.extends.version).toBe("0.2.0");
    expect(result.resolved?.instructions).toEqual(
      expect.arrayContaining([
        "Verify filing source provenance.",
        "Keep my five-year lens.",
      ]),
    );
    expect(original.extends.version).toBe("0.1.0");
    expect(result.parentChanges.instructionsAdded).toContain(
      "Verify filing source provenance.",
    );
  });

  it("stops when an overridden workflow disappeared upstream", () => {
    const original = fork(["risk-register"]);
    const updated = nextParent();
    updated.workflows = updated.workflows.filter(
      (workflow) => workflow.id !== "risk-register",
    );
    const financialPack = capabilityPacks.find((pack) =>
      pack.metadata.id.endsWith("financial-documents"),
    )!;
    const packs = capabilityPacks.map((pack) =>
      pack === financialPack
        ? {
            ...pack,
            workflows: pack.workflows.filter(
              (workflow) => workflow.id !== "risk-register",
            ),
          }
        : pack,
    );

    const result = planForkUpdate(
      original,
      agentSetups.investing,
      updated,
      packs,
    );

    expect(result.candidate).toBeUndefined();
    expect(result.conflicts.join("\n")).toMatch(
      /risk-register.*no longer exists/i,
    );
  });

  it("rejects unrelated parent identities", () => {
    const unrelated = {
      ...nextParent(),
      metadata: { ...nextParent().metadata, id: "dev.example.other" },
    };
    expect(() =>
      planForkUpdate(fork(), agentSetups.investing, unrelated, capabilityPacks),
    ).toThrow(/identity/i);
  });
});
