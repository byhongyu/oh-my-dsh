import { describe, expect, it } from "vitest";

import {
  AgentSetupSchema,
  CapabilityPackSchema,
  CustomAgentSetupSchema,
} from "../src/index.js";

const minimalSetup = {
  apiVersion: "omdsh.dev/v1alpha1",
  kind: "AgentSetup",
  metadata: {
    id: "dev.oh-my-dsh.coding",
    name: "Coding",
    version: "0.1.0",
    description: "Build and review software.",
    license: "MIT",
  },
  compatibility: {
    dsh: ">=0.1.0-rc.5 <0.2.0",
    adapters: ["dsh-rc5"],
  },
  capabilities: [{ id: "dev.oh-my-dsh.core-safety", version: "0.1.0" }],
  persona: { text: "Inspect first." },
  instructions: { inline: ["Make bounded changes."] },
  workflows: [],
  tools: { allow: ["filesystem.read"], deny: [] },
  permissions: {
    network: "ask",
    filesystem: "workspace-write",
    shell: "allow",
    destructive: "deny",
    secrets: "deny",
    dataExport: "deny",
    brokerage: "deny",
  },
  output: { conventions: ["Report tests run."] },
  examples: [],
};

describe("AgentSetupSchema", () => {
  it("accepts a strict v1alpha1 setup", () => {
    expect(AgentSetupSchema.parse(minimalSetup).metadata.id).toBe(
      "dev.oh-my-dsh.coding",
    );
  });

  it("rejects unknown fields instead of silently ignoring them", () => {
    expect(() =>
      AgentSetupSchema.parse({
        ...minimalSetup,
        lifecycleHook: "curl example.com",
      }),
    ).toThrow();
  });

  it("rejects terminal control characters in displayed metadata", () => {
    expect(() =>
      AgentSetupSchema.parse({
        ...minimalSetup,
        metadata: { ...minimalSetup.metadata, name: "Safe\u001b[2Jspoof" },
      }),
    ).toThrow(/control/i);
  });

  it.each([
    "../escape.md",
    "/tmp/absolute.md",
    "C:\\secret.txt",
    "CON.txt",
    "bad:name.md",
  ])("rejects unsafe portable path %s", (path) => {
    expect(() =>
      AgentSetupSchema.parse({
        ...minimalSetup,
        persona: { file: path },
      }),
    ).toThrow();
  });

  it("rejects declared file paths that collide after case folding", () => {
    expect(() =>
      AgentSetupSchema.parse({
        ...minimalSetup,
        persona: { file: "Persona.md" },
        instructions: { files: ["persona.md"] },
      }),
    ).toThrow(/collides/i);
  });
});

describe("CapabilityPackSchema", () => {
  it("rejects inline secrets in capability data", () => {
    expect(() =>
      CapabilityPackSchema.parse({
        apiVersion: "omdsh.dev/v1alpha1",
        kind: "CapabilityPack",
        metadata: {
          id: "dev.oh-my-dsh.bad",
          name: "Bad",
          version: "0.1.0",
          license: "MIT",
        },
        dependencies: [],
        tools: { allow: [] },
        workflows: [],
        permissions: {},
        secrets: { apiKey: "sk-plaintext" },
      }),
    ).toThrow();
  });
});

describe("CustomAgentSetupSchema", () => {
  it("accepts a minimal fork delta with lineage", () => {
    const fork = CustomAgentSetupSchema.parse({
      apiVersion: "omdsh.dev/v1alpha1",
      kind: "AgentSetupFork",
      metadata: {
        id: "local.my-investing",
        name: "My Investing",
        version: "0.1.0",
        license: "MIT",
      },
      extends: { id: "dev.oh-my-dsh.investing", version: "0.1.0" },
      overrides: {
        instructions: { append: ["Focus on long-term reinvestment runway."] },
        workflows: { enable: [], disable: [] },
        permissions: { brokerage: "deny" },
      },
    });

    expect(fork.extends.id).toBe("dev.oh-my-dsh.investing");
  });

  it("rejects a non-local fork id", () => {
    expect(() =>
      CustomAgentSetupSchema.parse({
        apiVersion: "omdsh.dev/v1alpha1",
        kind: "AgentSetupFork",
        metadata: {
          id: "dev.example.stolen",
          name: "Bad",
          version: "0.1.0",
          license: "MIT",
        },
        extends: { id: "dev.oh-my-dsh.investing", version: "0.1.0" },
        overrides: {},
      }),
    ).toThrow(/local/i);
  });
});
