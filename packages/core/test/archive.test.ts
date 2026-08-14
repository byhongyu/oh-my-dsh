import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { AgentSetup, CustomAgentSetup } from "@oh-my-dsh/schema";

import {
  computeArchiveSetupHash,
  createAgentArchive,
  parseAgentArchive,
  type ArchiveLock,
} from "../src/archive.js";

const setup: AgentSetup = {
  apiVersion: "omdsh.dev/v1alpha1",
  kind: "AgentSetup",
  metadata: {
    id: "local.portable-agent",
    name: "Portable Agent",
    version: "1.2.3",
    description: "A setup that can cross operating systems.",
    license: "MIT",
  },
  compatibility: {
    dsh: ">=0.1.0-rc.5 <0.2.0",
    adapters: ["dsh-rc5"],
  },
  capabilities: [{ id: "dev.oh-my-dsh.core-safety", version: "0.1.0" }],
  persona: { file: "instructions/persona.md" },
  instructions: {
    files: ["instructions/safety.md"],
    inline: ["Inspect before changing files."],
  },
  workflows: [
    {
      id: "inspect-first",
      description: "Inspect the relevant files before making a plan.",
      steps: ["Read the declared inputs.", "Report material uncertainty."],
      tools: ["filesystem.read"],
    },
  ],
  tools: { allow: ["filesystem.read"], deny: ["filesystem.write"] },
  permissions: {
    filesystem: "read-only",
    secrets: "deny",
    destructive: "deny",
  },
  output: { conventions: ["Report sources and uncertainty."] },
  examples: ["examples/inspect.md"],
};

function lockFor(value: AgentSetup = setup): ArchiveLock {
  return {
    setupId: value.metadata.id,
    setupVersion: value.metadata.version,
    normalizedHash: computeArchiveSetupHash(value),
    adapter: { id: "dsh-rc5", version: "0.1.0" },
    dshCompatibility: value.compatibility.dsh,
    capabilities: [{ id: "dev.oh-my-dsh.core-safety", version: "0.1.0" }],
  };
}

const files = [
  {
    path: "instructions/persona.md",
    content: "You are a careful research assistant.\n",
  },
  { path: "instructions/safety.md", content: "Do not expose credentials.\n" },
  {
    path: "examples/inspect.md",
    content: "# Inspect first\n\nRead, then report.\n",
  },
];

function createValidArchive(): Buffer {
  return createAgentArchive({ setup, lock: lockFor(), files });
}

function mutateEnvelope(
  archive: Uint8Array,
  mutate: (value: Record<string, unknown>) => void,
): Buffer {
  const value = JSON.parse(Buffer.from(archive).toString("utf8")) as Record<
    string,
    unknown
  >;
  mutate(value);
  return Buffer.from(JSON.stringify(value));
}

describe("portable .omdsh-agent archives", () => {
  it("serializes deterministically and validates the complete archive before returning data", () => {
    const first = createAgentArchive({ setup, lock: lockFor(), files });
    const second = createAgentArchive({
      setup: structuredClone(setup),
      lock: lockFor(),
      files: [...files].reverse(),
    });

    expect(first.equals(second)).toBe(true);
    expect(first.at(-1)).toBe(10);

    const imported = parseAgentArchive(first);
    expect(imported.setup).toEqual(setup);
    expect(imported.lock).toEqual(lockFor());
    expect(imported.files.map((file) => file.path)).toEqual([
      "examples/inspect.md",
      "instructions/persona.md",
      "instructions/safety.md",
    ]);
    expect(Buffer.from(imported.files[0]!.content).toString("utf8")).toBe(
      "# Inspect first\n\nRead, then report.\n",
    );
    expect(imported.files[0]!.sha256).toBe(
      createHash("sha256")
        .update("# Inspect first\n\nRead, then report.\n")
        .digest("hex"),
    );
  });

  it("rejects malformed setup, lock, envelope, and file fields instead of ignoring them", () => {
    expect(() =>
      createAgentArchive({
        setup: { ...setup, unexpected: true } as AgentSetup,
        lock: lockFor(),
        files,
      }),
    ).toThrow(/unrecognized|unknown|setup/i);

    const envelopeUnknown = mutateEnvelope(createValidArchive(), (value) => {
      value.unexpected = true;
    });
    expect(() => parseAgentArchive(envelopeUnknown)).toThrow(
      /unknown field.*unexpected/i,
    );

    const lockUnknown = mutateEnvelope(createValidArchive(), (value) => {
      (value.lock as Record<string, unknown>).branch = "main";
    });
    expect(() => parseAgentArchive(lockUnknown)).toThrow(
      /unknown field.*branch/i,
    );

    const fileUnknown = mutateEnvelope(createValidArchive(), (value) => {
      const [file] = value.files as Array<Record<string, unknown>>;
      file!.mode = 0o755;
    });
    expect(() => parseAgentArchive(fileUnknown)).toThrow(
      /unknown field.*mode/i,
    );
  });

  it("rejects undeclared files and file/directory prefix collisions", () => {
    expect(() =>
      createAgentArchive({
        setup,
        lock: lockFor(),
        files: [...files, { path: "undeclared.md", content: "extra" }],
      }),
    ).toThrow(/undeclared file/i);
    expect(() =>
      createAgentArchive({
        setup,
        lock: lockFor(),
        files: [
          ...files,
          { path: "collision", content: "file" },
          { path: "collision/child", content: "child" },
        ],
      }),
    ).toThrow(/file\/directory collision/i);
  });

  it("rejects duplicate JSON object keys and duplicate or case-colliding paths", () => {
    const json = createValidArchive().toString("utf8");
    expect(() =>
      parseAgentArchive(
        json.replace('"format":', '"format":"shadow","format":'),
      ),
    ).toThrow(/duplicate JSON field.*format/i);

    expect(() =>
      createAgentArchive({
        setup,
        lock: lockFor(),
        files: [
          ...files,
          { path: "instructions/persona.md", content: "duplicate" },
        ],
      }),
    ).toThrow(/duplicate.*instructions\/persona\.md/i);

    expect(() =>
      createAgentArchive({
        setup,
        lock: lockFor(),
        files: [
          ...files,
          { path: "Instructions/Persona.md", content: "collision" },
        ],
      }),
    ).toThrow(/case-insensitive collision/i);
  });

  it.each([
    "../escape.md",
    "instructions/../escape.md",
    "./instructions/persona.md",
    "/Users/alice/persona.md",
    "C:\\Users\\alice\\persona.md",
    "instructions\\persona.md",
    "instructions//persona.md",
  ])("rejects unconfined or non-normalized portable path %s", (unsafePath) => {
    expect(() =>
      createAgentArchive({
        setup,
        lock: lockFor(),
        files: [{ ...files[0]!, path: unsafePath }, ...files.slice(1)],
      }),
    ).toThrow(/path|portable|normalized|confined/i);
  });

  it.each([
    "payload.omdsh-agent",
    "payload.ZIP",
    "payload.tar.gz",
    "payload.tgz",
    "payload.7z",
  ])("rejects nested archive path %s", (nestedPath) => {
    expect(() =>
      createAgentArchive({
        setup,
        lock: lockFor(),
        files: [...files, { path: nestedPath, content: "nested" }],
      }),
    ).toThrow(/nested archive/i);
  });

  it("rejects disguised nested archives by magic bytes", () => {
    expect(() =>
      createAgentArchive({
        setup,
        lock: lockFor(),
        files: [
          ...files,
          {
            path: "assets/payload.bin",
            content: Uint8Array.from([0x50, 0x4b, 0x03, 0x04]),
          },
        ],
      }),
    ).toThrow(/nested archive/i);
  });

  it.each([
    "sessions/transcript.json",
    "history/chat.md",
    ".cache/source.json",
    "logs/session.log",
  ])("rejects session, history, and cache material at %s", (unsafePath) => {
    expect(() =>
      createAgentArchive({
        setup,
        lock: lockFor(),
        files: [...files, { path: unsafePath, content: "private state" }],
      }),
    ).toThrow(/session|history|cache|log/i);
  });

  it.each(["hooks/postinstall.sh", "scripts/setup.ps1", "bin/activate.exe"])(
    "rejects executable or lifecycle-hook material at %s",
    (unsafePath) => {
      expect(() =>
        createAgentArchive({
          setup,
          lock: lockFor(),
          files: [...files, { path: unsafePath, content: "# executable" }],
        }),
      ).toThrow(/executable|hook/i);
    },
  );

  it("rejects symlink and hardlink concepts represented as extra file metadata", () => {
    for (const field of ["symlink", "hardlink"]) {
      const archive = mutateEnvelope(createValidArchive(), (value) => {
        const [file] = value.files as Array<Record<string, unknown>>;
        file![field] = "../outside";
      });
      expect(() => parseAgentArchive(archive)).toThrow(
        new RegExp(`unknown field.*${field}`, "i"),
      );
    }
  });

  it("rejects credential-like values but allows inert environment references", () => {
    expect(() =>
      createAgentArchive({
        setup,
        lock: lockFor(),
        files: [
          ...files,
          {
            path: "instructions/credentials.md",
            content: "OPENAI_API_KEY=sk-live-abcdefghijklmnop",
          },
        ],
      }),
    ).toThrow(/credential|secret/i);

    const safeSetup: AgentSetup = {
      ...setup,
      instructions: {
        ...setup.instructions,
        inline: ["Read the key from ${RESEARCH_API_KEY}."],
      },
    };
    expect(() =>
      createAgentArchive({ setup: safeSetup, lock: lockFor(safeSetup), files }),
    ).not.toThrow();
  });

  it.each([
    "Read /Users/alice/private/project.txt before starting.",
    "Read /mnt/company/private/data.csv before starting.",
    "Read C:\\Users\\Alice\\project\\notes.md before starting.",
    "Open file:///home/alice/private.txt.",
  ])(
    "rejects absolute machine paths in values and file contents",
    (machinePath) => {
      expect(() =>
        createAgentArchive({
          setup,
          lock: lockFor(),
          files: [
            ...files,
            { path: "instructions/machine.md", content: machinePath },
          ],
        }),
      ).toThrow(/absolute machine path/i);
    },
  );

  it("rejects corrupt checksums and malformed or non-canonical base64", () => {
    const corrupt = mutateEnvelope(createValidArchive(), (value) => {
      const [file] = value.files as Array<Record<string, unknown>>;
      file!.sha256 = "0".repeat(64);
    });
    expect(() => parseAgentArchive(corrupt)).toThrow(/checksum/i);

    for (const encoded of ["!!!!", "YQ", "YQ==\n"]) {
      const malformed = mutateEnvelope(createValidArchive(), (value) => {
        const [file] = value.files as Array<Record<string, unknown>>;
        file!.content = encoded;
      });
      expect(() => parseAgentArchive(malformed)).toThrow(/base64/i);
    }
  });

  it("binds lock identity, compatibility, capability versions, and normalized hash to the setup", () => {
    for (const mutate of [
      (lock: Record<string, unknown>) => (lock.setupId = "local.another-agent"),
      (lock: Record<string, unknown>) => (lock.setupVersion = "9.9.9"),
      (lock: Record<string, unknown>) => (lock.normalizedHash = "0".repeat(64)),
      (lock: Record<string, unknown>) => (lock.dshCompatibility = ">=9.0.0"),
      (lock: Record<string, unknown>) =>
        (lock.capabilities = [
          { id: "dev.oh-my-dsh.core-safety", version: "9.9.9" },
        ]),
    ]) {
      const archive = mutateEnvelope(createValidArchive(), (value) =>
        mutate(value.lock as Record<string, unknown>),
      );
      expect(() => parseAgentArchive(archive)).toThrow(
        /lock|hash|capability|compatibility|identity|version/i,
      );
    }
  });

  it("round-trips a strict custom setup while preserving its parent lineage", () => {
    const fork: CustomAgentSetup = {
      apiVersion: "omdsh.dev/v1alpha1",
      kind: "AgentSetupFork",
      metadata: {
        id: "local.portable-fork",
        name: "Portable Fork",
        version: "0.1.0",
        license: "MIT",
      },
      extends: { id: "dev.oh-my-dsh.investing", version: "0.1.0" },
      overrides: {
        instructions: { append: ["Prefer five-year business quality."] },
        permissions: { brokerage: "deny" },
      },
    };
    const forkLock: ArchiveLock = {
      setupId: fork.metadata.id,
      setupVersion: fork.metadata.version,
      normalizedHash: computeArchiveSetupHash(fork),
      adapter: { id: "dsh-rc5", version: "0.1.0" },
      dshCompatibility: ">=0.1.0-rc.5 <0.2.0",
      capabilities: [
        { id: "dev.oh-my-dsh.core-safety", version: "0.1.0" },
        { id: "dev.oh-my-dsh.financial-documents", version: "0.1.0" },
      ],
    };

    const imported = parseAgentArchive(
      createAgentArchive({ setup: fork, lock: forkLock, files: [] }),
    );
    expect(imported.setup).toEqual(fork);
    expect(imported.setup.kind).toBe("AgentSetupFork");
    if (imported.setup.kind === "AgentSetupFork")
      expect(imported.setup.extends).toEqual(fork.extends);
  });

  it("rejects missing setup-declared files before returning an import result", () => {
    expect(() =>
      createAgentArchive({
        setup,
        lock: lockFor(),
        files: files.filter((file) => file.path !== "instructions/persona.md"),
      }),
    ).toThrow(/declared file.*instructions\/persona\.md/i);
  });

  it("enforces input, file-count, per-file, and total expanded-byte limits on import", () => {
    const archive = createValidArchive();
    expect(() =>
      parseAgentArchive(archive, { maxInputBytes: archive.byteLength - 1 }),
    ).toThrow(/input.*limit/i);
    expect(() => parseAgentArchive(archive, { maxFiles: 2 })).toThrow(
      /file count.*limit/i,
    );
    expect(() => parseAgentArchive(archive, { maxFileBytes: 10 })).toThrow(
      /per-file.*limit/i,
    );
    expect(() => parseAgentArchive(archive, { maxExpandedBytes: 50 })).toThrow(
      /expanded.*limit/i,
    );
  });

  it("rejects invalid limits before doing archive work", () => {
    expect(() =>
      parseAgentArchive(createValidArchive(), { maxFiles: 0 }),
    ).toThrow(/maxFiles.*positive/i);
    expect(() =>
      createAgentArchive(
        { setup, lock: lockFor(), files },
        { maxExpandedBytes: 1.5 },
      ),
    ).toThrow(/maxExpandedBytes.*integer/i);
    expect(() =>
      parseAgentArchive(createValidArchive(), { surprise: 1 } as never),
    ).toThrow(/unknown field.*surprise/i);
  });

  it("accepts string input and rejects invalid UTF-8, JSON, format, and version before import", () => {
    expect(
      parseAgentArchive(createValidArchive().toString("utf8")).setup,
    ).toEqual(setup);
    expect(() => parseAgentArchive(Uint8Array.from([0xff]))).toThrow(/UTF-8/i);
    expect(() => parseAgentArchive("{")).toThrow(/invalid JSON/i);
    expect(() => parseAgentArchive("[]")).toThrow(/envelope.*object/i);

    const wrongFormat = mutateEnvelope(createValidArchive(), (value) => {
      value.format = "zip";
    });
    expect(() => parseAgentArchive(wrongFormat)).toThrow(/format/i);
    const wrongVersion = mutateEnvelope(createValidArchive(), (value) => {
      value.version = 2;
    });
    expect(() => parseAgentArchive(wrongVersion)).toThrow(/version/i);
  });

  it.each([
    Uint8Array.from([0x50, 0x4b, 0x05, 0x06]),
    Uint8Array.from([0x50, 0x4b, 0x07, 0x08]),
    Uint8Array.from([0x1f, 0x8b]),
    Uint8Array.from([0x42, 0x5a, 0x68]),
    Uint8Array.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]),
    Uint8Array.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
    Uint8Array.from([0x52, 0x61, 0x72, 0x21]),
    Uint8Array.from([...new Uint8Array(257), ...Buffer.from("ustar")]),
  ])("rejects common nested archive signatures %#", (signature) => {
    expect(() =>
      createAgentArchive({
        setup,
        lock: lockFor(),
        files: [...files, { path: "assets/payload.bin", content: signature }],
      }),
    ).toThrow(/nested archive/i);
  });

  it.each([
    "instructions/name?.md",
    "instructions/CON.txt",
    "instructions/trailing.",
  ])("rejects operating-system-specific path %s", (unsafePath) => {
    expect(() =>
      createAgentArchive({
        setup,
        lock: lockFor(),
        files: [{ ...files[0]!, path: unsafePath }, ...files.slice(1)],
      }),
    ).toThrow(/portable|reserved/i);
  });

  it("rejects duplicate locked capabilities and unsafe structured JSON assets", () => {
    const duplicateLock: ArchiveLock = {
      ...lockFor(),
      capabilities: [
        { id: "dev.oh-my-dsh.core-safety", version: "0.1.0" },
        { id: "dev.oh-my-dsh.core-safety", version: "0.1.0" },
      ],
    };
    expect(() =>
      createAgentArchive({ setup, lock: duplicateLock, files }),
    ).toThrow(/duplicate.*capability/i);
    const jsonSetup: AgentSetup = {
      ...setup,
      examples: [...setup.examples, "metadata.json"],
    };
    expect(() =>
      createAgentArchive({
        setup: jsonSetup,
        lock: lockFor(jsonSetup),
        files: [
          ...files,
          { path: "metadata.json", content: '{"symlink":"../outside"}' },
        ],
      }),
    ).toThrow(/link concept/i);
    expect(() =>
      createAgentArchive({
        setup: jsonSetup,
        lock: lockFor(jsonSetup),
        files: [...files, { path: "metadata.json", content: "{not-json" }],
      }),
    ).not.toThrow();
  });

  it("supports a full setup with inline persona and no declared files", () => {
    const inline: AgentSetup = {
      ...setup,
      metadata: { ...setup.metadata, id: "local.inline-agent" },
      persona: { text: "Be concise." },
      instructions: { inline: ["Inspect first."] },
      examples: [],
    };
    const imported = parseAgentArchive(
      createAgentArchive({ setup: inline, lock: lockFor(inline), files: [] }),
    );
    expect(imported.files).toEqual([]);
  });
});
