import { createHash } from "node:crypto";
import { posix as posixPath } from "node:path";
import { TextDecoder } from "node:util";

import {
  PortablePathSchema,
  parseAgentSetup,
  parseCustomAgentSetup,
  type AgentSetup,
  type CustomAgentSetup,
} from "@oh-my-dsh/schema";

const ARCHIVE_FORMAT = "oh-my-dsh-agent" as const;
const ARCHIVE_VERSION = 1 as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const ADAPTER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type PortableAgentSetup = AgentSetup | CustomAgentSetup;

export interface LockedCapability {
  id: string;
  version: string;
}

export interface ArchiveLock {
  setupId: string;
  setupVersion: string;
  normalizedHash: string;
  adapter: {
    id: string;
    version: string;
  };
  dshCompatibility: string;
  capabilities: LockedCapability[];
}

export interface PortableArchiveFileInput {
  path: string;
  content: string | Uint8Array;
}

export interface PortableArchiveFile {
  path: string;
  content: Uint8Array;
  sha256: string;
}

export interface CreateAgentArchiveInput {
  setup: unknown;
  lock: ArchiveLock;
  files: readonly PortableArchiveFileInput[];
}

export interface ImportedAgentArchive {
  setup: PortableAgentSetup;
  lock: ArchiveLock;
  files: PortableArchiveFile[];
}

export interface ArchiveLimits {
  maxInputBytes: number;
  maxFiles: number;
  maxFileBytes: number;
  maxExpandedBytes: number;
}

export const DEFAULT_ARCHIVE_LIMITS: Readonly<ArchiveLimits> = Object.freeze({
  maxInputBytes: 16 * 1024 * 1024,
  maxFiles: 256,
  maxFileBytes: 2 * 1024 * 1024,
  maxExpandedBytes: 8 * 1024 * 1024,
});

type JsonRecord = Record<string, unknown>;

interface EncodedArchiveFile {
  path: string;
  sha256: string;
  content: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, context: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  return value;
}

function assertAllowedFields(
  record: JsonRecord,
  allowed: readonly string[],
  context: string,
): void {
  const allowedSet = new Set(allowed);
  for (const field of Object.keys(record)) {
    if (!allowedSet.has(field))
      throw new Error(`${context} has unknown field ${field}`);
  }
}

function requireString(
  record: JsonRecord,
  field: string,
  context: string,
): string {
  const value = record[field];
  if (typeof value !== "string")
    throw new Error(`${context}.${field} must be a string`);
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("archive data cannot contain a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error(`archive data contains unsupported ${typeof value} value`);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function parsePortableSetup(input: unknown): PortableAgentSetup {
  const candidate = assertRecord(input, "archive setup");
  if (candidate.kind === "AgentSetup") return parseAgentSetup(candidate);
  if (candidate.kind === "AgentSetupFork")
    return parseCustomAgentSetup(candidate);
  throw new Error("archive setup kind must be AgentSetup or AgentSetupFork");
}

export function computeArchiveSetupHash(input: unknown): string {
  return sha256(canonicalJson(parsePortableSetup(input)));
}

/** Validate a portable setup's schema and non-executable, non-secret content. */
export function validatePortableAgentSetup(input: unknown): PortableAgentSetup {
  const setup = parsePortableSetup(input);
  assertSafeData(setup, "portable setup");
  return setup;
}

function resolveLimits(
  overrides: Partial<ArchiveLimits> | undefined,
): ArchiveLimits {
  if (overrides !== undefined) {
    const record = assertRecord(overrides, "archive limits");
    assertAllowedFields(
      record,
      Object.keys(DEFAULT_ARCHIVE_LIMITS),
      "archive limits",
    );
  }
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
    if (value <= 0) throw new Error(`${name} must be positive`);
    if (!Number.isSafeInteger(value))
      throw new Error(`${name} must be a safe integer`);
  }
  return limits;
}

function assertPortablePath(value: string): void {
  const parsed = PortablePathSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      `invalid portable path ${JSON.stringify(value)}: must be normalized and confined`,
    );
  if (
    posixPath.normalize(value) !== value ||
    value.normalize("NFC") !== value
  ) {
    throw new Error(
      `portable path ${JSON.stringify(value)} must be normalized`,
    );
  }

  for (const segment of value.split("/")) {
    const containsControlCharacter = [...segment].some(
      (character) => character.charCodeAt(0) <= 0x1f,
    );
    if (
      containsControlCharacter ||
      /[<>:"|?*]/.test(segment) ||
      /[. ]$/.test(segment)
    ) {
      throw new Error(
        `portable path ${JSON.stringify(value)} is not portable across operating systems`,
      );
    }
    const windowsBase = segment.split(".")[0]!.toLowerCase();
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(windowsBase)) {
      throw new Error(
        `portable path ${JSON.stringify(value)} uses a reserved filename`,
      );
    }
  }

  if (
    /\.(?:omdsh-agent|zip|tar|tar\.gz|tgz|gz|bz2|xz|7z|rar|jar|war)$/i.test(
      value,
    )
  ) {
    throw new Error(`nested archive is not allowed: ${value}`);
  }

  const foldedSegments = value
    .split("/")
    .map((segment) => segment.toLowerCase());
  const privateSegments = new Set([
    ".cache",
    "cache",
    "caches",
    "conversation",
    "conversations",
    "history",
    "histories",
    "log",
    "logs",
    "session",
    "sessions",
  ]);
  if (foldedSegments.some((segment) => privateSegments.has(segment))) {
    throw new Error(
      `session, history, cache, and log paths are not portable: ${value}`,
    );
  }

  const executableDirectories = new Set([
    "bin",
    "hook",
    "hooks",
    "script",
    "scripts",
  ]);
  if (
    foldedSegments.some((segment) => executableDirectories.has(segment)) ||
    /\.(?:bat|cmd|com|dll|dylib|exe|node|ps1|sh|so|zsh|bash|cjs|mjs)$/i.test(
      value,
    )
  ) {
    throw new Error(
      `executable and lifecycle-hook files are not supported: ${value}`,
    );
  }
}

function isNestedArchive(bytes: Uint8Array): boolean {
  const startsWith = (...prefix: number[]): boolean =>
    prefix.every((byte, index) => bytes[index] === byte);
  if (startsWith(0x50, 0x4b, 0x03, 0x04) || startsWith(0x50, 0x4b, 0x05, 0x06))
    return true;
  if (
    startsWith(0x50, 0x4b, 0x07, 0x08) ||
    startsWith(0x1f, 0x8b) ||
    startsWith(0x42, 0x5a, 0x68)
  )
    return true;
  if (startsWith(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return true;
  if (
    startsWith(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c) ||
    startsWith(0x52, 0x61, 0x72, 0x21)
  )
    return true;
  return (
    bytes.byteLength >= 262 &&
    Buffer.from(bytes.subarray(257, 262)).toString("ascii") === "ustar"
  );
}

const forbiddenDataFields = new Set([
  "executable",
  "hardlink",
  "hook",
  "hooks",
  "installscript",
  "lifecycle",
  "linkname",
  "postinstall",
  "preinstall",
  "prepare",
  "script",
  "scripts",
  "symlink",
]);

const credentialFields = new Set([
  "accesstoken",
  "apikey",
  "apitoken",
  "authorization",
  "clientsecret",
  "credential",
  "credentials",
  "password",
  "passwd",
  "privatekey",
  "refreshtoken",
  "secretaccesskey",
]);

function isInertSecretReference(value: unknown): boolean {
  if (typeof value === "string") {
    return (
      /^(?:env:|secret:\/\/)[A-Z_][A-Z0-9_.-]*$/.test(value) ||
      /^\$\{(?:env:)?[A-Z_][A-Z0-9_]*\}$/.test(value)
    );
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.env !== "string"
  )
    return false;
  return /^[A-Z_][A-Z0-9_]*$/.test(value.env);
}

function assertSafeString(value: string, context: string): void {
  const machinePath =
    /(?:^|[\s('"`=])(?:file:\/\/\/|~\/|\/(?!\/)[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~ -]+)*|[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+)/m;
  if (machinePath.test(value))
    throw new Error(`${context} contains an absolute machine path`);

  const knownSecret =
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\bAIza[0-9A-Za-z_-]{30,}\b|\bgh[pousr]_[0-9A-Za-z]{20,}\b|\bxox[baprs]-[0-9A-Za-z-]{10,}\b|\b(?:sk|rk)-(?:live-|test-)?[0-9A-Za-z_-]{12,}\b|\bBearer\s+[0-9A-Za-z._~-]{12,}/i;
  if (knownSecret.test(value))
    throw new Error(`${context} contains a secret-like credential value`);

  const assignments = value.matchAll(
    /\b(?:api[ _-]?key|access[ _-]?token|auth[ _-]?token|client[ _-]?secret|password|private[ _-]?key|refresh[ _-]?token|secret)\s*[:=]\s*["']?([^\s"',;]+)/gi,
  );
  for (const match of assignments) {
    const assigned = match[1] ?? "";
    if (assigned.length > 0 && !isInertSecretReference(assigned)) {
      throw new Error(`${context} contains a secret-like credential value`);
    }
  }
}

function assertSafeData(value: unknown, context: string, depth = 0): void {
  if (depth > 64)
    throw new Error(`${context} exceeds the maximum nesting depth`);
  if (typeof value === "string") {
    assertSafeString(value, context);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertSafeData(item, `${context}[${index}]`, depth + 1),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const foldedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (forbiddenDataFields.has(foldedKey)) {
      throw new Error(
        `${context}.${key} declares an unsupported executable hook or link concept`,
      );
    }
    if (
      credentialFields.has(foldedKey) &&
      child !== null &&
      !isInertSecretReference(child)
    ) {
      throw new Error(`${context}.${key} contains a literal credential value`);
    }
    assertSafeData(child, `${context}.${key}`, depth + 1);
  }
}

function parseLock(input: unknown, setup: PortableAgentSetup): ArchiveLock {
  const lock = assertRecord(input, "archive lock");
  assertAllowedFields(
    lock,
    [
      "setupId",
      "setupVersion",
      "normalizedHash",
      "adapter",
      "dshCompatibility",
      "capabilities",
    ],
    "archive lock",
  );

  const setupId = requireString(lock, "setupId", "archive lock");
  const setupVersion = requireString(lock, "setupVersion", "archive lock");
  const normalizedHash = requireString(lock, "normalizedHash", "archive lock");
  const dshCompatibility = requireString(
    lock,
    "dshCompatibility",
    "archive lock",
  );
  if (!IDENTIFIER_PATTERN.test(setupId))
    throw new Error("archive lock setupId must be a reverse-DNS identifier");
  if (!SEMVER_PATTERN.test(setupVersion))
    throw new Error("archive lock setupVersion must be SemVer");
  if (!SHA256_PATTERN.test(normalizedHash))
    throw new Error(
      "archive lock normalizedHash must be a lowercase SHA-256 digest",
    );
  if (dshCompatibility.length === 0 || dshCompatibility.length > 200) {
    throw new Error(
      "archive lock dshCompatibility must be between 1 and 200 characters",
    );
  }

  const adapterRecord = assertRecord(lock.adapter, "archive lock adapter");
  assertAllowedFields(adapterRecord, ["id", "version"], "archive lock adapter");
  const adapter = {
    id: requireString(adapterRecord, "id", "archive lock adapter"),
    version: requireString(adapterRecord, "version", "archive lock adapter"),
  };
  if (!ADAPTER_ID_PATTERN.test(adapter.id))
    throw new Error("archive lock adapter id is invalid");
  if (!SEMVER_PATTERN.test(adapter.version))
    throw new Error("archive lock adapter version must be SemVer");

  if (!Array.isArray(lock.capabilities))
    throw new Error("archive lock capabilities must be an array");
  if (lock.capabilities.length > 256)
    throw new Error("archive lock capability count exceeds limit");
  const capabilities: LockedCapability[] = [];
  const capabilityIds = new Set<string>();
  for (const [index, value] of lock.capabilities.entries()) {
    const capability = assertRecord(value, `archive lock capability ${index}`);
    assertAllowedFields(
      capability,
      ["id", "version"],
      `archive lock capability ${index}`,
    );
    const parsed = {
      id: requireString(capability, "id", `archive lock capability ${index}`),
      version: requireString(
        capability,
        "version",
        `archive lock capability ${index}`,
      ),
    };
    if (!IDENTIFIER_PATTERN.test(parsed.id))
      throw new Error(`archive lock capability ${index} id is invalid`);
    if (!SEMVER_PATTERN.test(parsed.version))
      throw new Error(
        `archive lock capability ${index} version must be SemVer`,
      );
    if (capabilityIds.has(parsed.id))
      throw new Error(`duplicate archive lock capability id: ${parsed.id}`);
    capabilityIds.add(parsed.id);
    capabilities.push(parsed);
  }

  if (
    setupId !== setup.metadata.id ||
    setupVersion !== setup.metadata.version
  ) {
    throw new Error("archive lock identity and version do not match the setup");
  }
  if (normalizedHash !== computeArchiveSetupHash(setup)) {
    throw new Error("archive lock normalized hash does not match the setup");
  }
  if (setup.kind === "AgentSetup") {
    if (dshCompatibility !== setup.compatibility.dsh) {
      throw new Error(
        "archive lock DSH compatibility does not match the setup",
      );
    }
    if (!setup.compatibility.adapters.includes(adapter.id)) {
      throw new Error(
        `archive lock adapter ${adapter.id} is not declared by the setup`,
      );
    }
    const byId = new Map(
      capabilities.map((capability) => [capability.id, capability.version]),
    );
    for (const dependency of setup.capabilities) {
      if (byId.get(dependency.id) !== dependency.version) {
        throw new Error(
          `archive lock capability ${dependency.id} version does not match the setup`,
        );
      }
    }
  }

  const parsedLock = {
    setupId,
    setupVersion,
    normalizedHash,
    adapter,
    dshCompatibility,
    capabilities: capabilities.sort((left, right) =>
      compareText(left.id, right.id),
    ),
  };
  assertSafeData(parsedLock, "archive lock");
  return parsedLock;
}

function contentBytes(content: string | Uint8Array): Buffer {
  if (typeof content === "string") return Buffer.from(content, "utf8");
  if (content instanceof Uint8Array) return Buffer.from(content);
  throw new Error("archive file content must be a string or Uint8Array");
}

function assertSafeFileContent(path: string, bytes: Uint8Array): void {
  if (isNestedArchive(bytes))
    throw new Error(`nested archive content is not allowed: ${path}`);
  const text = Buffer.from(bytes).toString("utf8");
  assertSafeString(text, `archive file ${path}`);
  if (
    /^#!/.test(text) ||
    /^(?:preinstall|postinstall|prepare|scripts|hooks)\s*:/im.test(text)
  ) {
    throw new Error(
      `archive file ${path} contains an executable or lifecycle hook`,
    );
  }
  if (/\.json$/i.test(path)) {
    try {
      const value: unknown = JSON.parse(text);
      assertSafeData(value, `archive file ${path}`);
    } catch (error) {
      if (error instanceof SyntaxError) return;
      throw error;
    }
  }
}

function assertNoPathCollisions(
  path: string,
  exact: Set<string>,
  folded: Map<string, string>,
): void {
  if (exact.has(path)) throw new Error(`duplicate archive file path: ${path}`);
  const key = path.normalize("NFC").toLowerCase();
  const existing = folded.get(key);
  if (existing !== undefined)
    throw new Error(
      `case-insensitive collision between ${existing} and ${path}`,
    );
  for (const candidate of exact) {
    if (path.startsWith(`${candidate}/`) || candidate.startsWith(`${path}/`))
      throw new Error(
        `archive file/directory collision between ${candidate} and ${path}`,
      );
  }
  exact.add(path);
  folded.set(key, path);
}

function assertDeclaredFilesPresent(
  setup: PortableAgentSetup,
  files: readonly { path: string }[],
): void {
  const declared =
    setup.kind === "AgentSetup"
      ? [
          ...("file" in setup.persona ? [setup.persona.file] : []),
          ...(setup.instructions.files ?? []),
          ...setup.examples,
        ]
      : [];
  const available = new Set(files.map((file) => file.path));
  for (const path of declared) {
    if (!available.has(path))
      throw new Error(`declared file is missing from archive: ${path}`);
  }
  for (const path of available) {
    if (!declared.includes(path))
      throw new Error(`archive contains undeclared file: ${path}`);
  }
}

function prepareFiles(
  files: readonly PortableArchiveFileInput[],
  limits: ArchiveLimits,
): { encoded: EncodedArchiveFile[]; imported: PortableArchiveFile[] } {
  if (!Array.isArray(files)) throw new Error("archive files must be an array");
  if (files.length > limits.maxFiles)
    throw new Error("archive file count exceeds limit");
  const encoded: EncodedArchiveFile[] = [];
  const imported: PortableArchiveFile[] = [];
  const exact = new Set<string>();
  const folded = new Map<string, string>();
  let expandedBytes = 0;

  for (const [index, file] of files.entries()) {
    if (!isRecord(file))
      throw new Error(`archive file ${index} must be an object`);
    assertAllowedFields(file, ["path", "content"], `archive file ${index}`);
    const path = requireString(file, "path", `archive file ${index}`);
    assertPortablePath(path);
    assertNoPathCollisions(path, exact, folded);
    const bytes = contentBytes(file.content as string | Uint8Array);
    if (bytes.byteLength > limits.maxFileBytes)
      throw new Error(`archive per-file byte limit exceeded: ${path}`);
    expandedBytes += bytes.byteLength;
    if (expandedBytes > limits.maxExpandedBytes)
      throw new Error("archive expanded byte limit exceeded");
    assertSafeFileContent(path, bytes);
    const digest = sha256(bytes);
    encoded.push({ path, sha256: digest, content: bytes.toString("base64") });
    imported.push({ path, sha256: digest, content: bytes });
  }

  encoded.sort((left, right) => compareText(left.path, right.path));
  imported.sort((left, right) => compareText(left.path, right.path));
  return { encoded, imported };
}

function decodeBase64(value: unknown, context: string): Buffer {
  if (
    typeof value !== "string" ||
    !BASE64_PATTERN.test(value) ||
    value.length % 4 !== 0
  ) {
    throw new Error(`${context} content must be canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value)
    throw new Error(`${context} content must be canonical base64`);
  return decoded;
}

function parseFiles(
  input: unknown,
  limits: ArchiveLimits,
): PortableArchiveFile[] {
  if (!Array.isArray(input)) throw new Error("archive files must be an array");
  if (input.length > limits.maxFiles)
    throw new Error("archive file count exceeds limit");
  const files: PortableArchiveFile[] = [];
  const exact = new Set<string>();
  const folded = new Map<string, string>();
  let expandedBytes = 0;

  for (const [index, value] of input.entries()) {
    const file = assertRecord(value, `archive file ${index}`);
    assertAllowedFields(
      file,
      ["path", "sha256", "content"],
      `archive file ${index}`,
    );
    const path = requireString(file, "path", `archive file ${index}`);
    const digest = requireString(file, "sha256", `archive file ${index}`);
    assertPortablePath(path);
    assertNoPathCollisions(path, exact, folded);
    if (!SHA256_PATTERN.test(digest))
      throw new Error(
        `archive file ${path} checksum must be a lowercase SHA-256 digest`,
      );
    const bytes = decodeBase64(file.content, `archive file ${path}`);
    if (bytes.byteLength > limits.maxFileBytes)
      throw new Error(`archive per-file byte limit exceeded: ${path}`);
    expandedBytes += bytes.byteLength;
    if (expandedBytes > limits.maxExpandedBytes)
      throw new Error("archive expanded byte limit exceeded");
    assertSafeFileContent(path, bytes);
    if (sha256(bytes) !== digest)
      throw new Error(`archive file checksum mismatch: ${path}`);
    files.push({ path, sha256: digest, content: bytes });
  }

  return files.sort((left, right) => compareText(left.path, right.path));
}

function assertNoDuplicateJsonFields(text: string): void {
  let cursor = 0;
  const skipWhitespace = (): void => {
    while (/\s/.test(text[cursor] ?? "")) cursor += 1;
  };
  const parseStringToken = (): string => {
    const start = cursor;
    cursor += 1;
    while (cursor < text.length) {
      const character = text[cursor];
      if (character === "\\") {
        cursor += 2;
        continue;
      }
      cursor += 1;
      if (character === '"')
        return JSON.parse(text.slice(start, cursor)) as string;
    }
    throw new Error("invalid archive JSON string");
  };
  const scanValue = (depth: number): void => {
    if (depth > 64)
      throw new Error("archive JSON exceeds the maximum nesting depth");
    skipWhitespace();
    const character = text[cursor];
    if (character === "{") {
      cursor += 1;
      skipWhitespace();
      const fields = new Set<string>();
      if (text[cursor] === "}") {
        cursor += 1;
        return;
      }
      while (cursor < text.length) {
        skipWhitespace();
        if (text[cursor] !== '"')
          throw new Error("invalid archive JSON object key");
        const field = parseStringToken();
        if (fields.has(field))
          throw new Error(`duplicate JSON field: ${field}`);
        fields.add(field);
        skipWhitespace();
        if (text[cursor] !== ":")
          throw new Error("invalid archive JSON object separator");
        cursor += 1;
        scanValue(depth + 1);
        skipWhitespace();
        if (text[cursor] === "}") {
          cursor += 1;
          return;
        }
        if (text[cursor] !== ",")
          throw new Error("invalid archive JSON object delimiter");
        cursor += 1;
      }
      throw new Error("invalid archive JSON object");
    }
    if (character === "[") {
      cursor += 1;
      skipWhitespace();
      if (text[cursor] === "]") {
        cursor += 1;
        return;
      }
      while (cursor < text.length) {
        scanValue(depth + 1);
        skipWhitespace();
        if (text[cursor] === "]") {
          cursor += 1;
          return;
        }
        if (text[cursor] !== ",")
          throw new Error("invalid archive JSON array delimiter");
        cursor += 1;
      }
      throw new Error("invalid archive JSON array");
    }
    if (character === '"') {
      parseStringToken();
      return;
    }
    while (cursor < text.length && !/[\s,}\]]/.test(text[cursor] ?? ""))
      cursor += 1;
  };

  scanValue(0);
  skipWhitespace();
  if (cursor !== text.length)
    throw new Error("invalid trailing archive JSON data");
}

export function createAgentArchive(
  input: CreateAgentArchiveInput,
  limitOverrides?: Partial<ArchiveLimits>,
): Buffer {
  const limits = resolveLimits(limitOverrides);
  const setup = parsePortableSetup(input.setup);
  assertSafeData(setup, "archive setup");
  const lock = parseLock(input.lock, setup);
  const prepared = prepareFiles(input.files, limits);
  assertDeclaredFilesPresent(setup, prepared.imported);

  const envelope = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    setup,
    lock,
    files: prepared.encoded,
  };
  const result = Buffer.from(`${canonicalJson(envelope)}\n`, "utf8");
  if (result.byteLength > limits.maxInputBytes)
    throw new Error("archive input byte limit exceeded");
  return result;
}

export function parseAgentArchive(
  input: string | Uint8Array,
  limitOverrides?: Partial<ArchiveLimits>,
): ImportedAgentArchive {
  const limits = resolveLimits(limitOverrides);
  const inputBytes =
    typeof input === "string"
      ? Buffer.byteLength(input, "utf8")
      : input.byteLength;
  if (inputBytes > limits.maxInputBytes)
    throw new Error("archive input byte limit exceeded");

  let text: string;
  try {
    text =
      typeof input === "string"
        ? input
        : new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw new Error("archive must contain valid UTF-8 JSON");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("archive contains invalid JSON");
  }
  assertNoDuplicateJsonFields(text);
  const envelope = assertRecord(parsed, "archive envelope");
  assertAllowedFields(
    envelope,
    ["format", "version", "setup", "lock", "files"],
    "archive envelope",
  );
  if (envelope.format !== ARCHIVE_FORMAT)
    throw new Error(`archive format must be ${ARCHIVE_FORMAT}`);
  if (envelope.version !== ARCHIVE_VERSION)
    throw new Error(`unsupported archive version: ${String(envelope.version)}`);

  // Each stage builds local values only. Nothing is returned until every byte and
  // every cross-reference in the envelope has passed validation.
  const setup = parsePortableSetup(envelope.setup);
  assertSafeData(setup, "archive setup");
  const lock = parseLock(envelope.lock, setup);
  const files = parseFiles(envelope.files, limits);
  assertDeclaredFilesPresent(setup, files);
  return { setup, lock, files };
}
