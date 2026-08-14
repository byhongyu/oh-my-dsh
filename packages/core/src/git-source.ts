import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const FULL_COMMIT = /^[a-f0-9]{40}$/;
const COMPONENT = /^[A-Za-z0-9_.-]+$/;
const PORTABLE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

export interface GithubSource {
  identity: string;
  repository: string;
  repositoryUrl: string;
  subpath: string;
}

export interface MaterializeGitSourceOptions {
  source: string;
  revision: string;
  stateRoot: string;
  repositoryUrlOverride?: string;
  allowLocalRepositoryForTests?: boolean;
}

export interface MaterializedGitSource {
  source: string;
  revision: string;
  contentDigest: string;
  directory: string;
  lockPath: string;
}

export function parseGithubSource(source: string): GithubSource {
  if (!source.startsWith("github:"))
    throw new Error(`invalid GitHub source: ${source}`);
  const segments = source.slice("github:".length).split("/");
  if (
    segments.length < 3 ||
    segments.some(
      (segment) =>
        !COMPONENT.test(segment) || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`invalid GitHub source: ${source}`);
  }
  const owner = segments[0]!;
  const repositoryName = segments[1]!;
  const pathSegments = segments.slice(2);
  if (pathSegments.some((segment) => !PORTABLE_SEGMENT.test(segment)))
    throw new Error(`invalid GitHub source: ${source}`);
  const repository = `${owner}/${repositoryName}`;
  const subpath = pathSegments.join("/");
  return {
    identity: `github:${repository}/${subpath}`,
    repository,
    repositoryUrl: `https://github.com/${repository}.git`,
    subpath,
  };
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const { stdout } = await execFileAsync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "submodule.recurse=false",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
      env: {
        ...environment,
        GIT_ATTR_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(cwd, ".oh-my-dsh-empty-gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  return stdout.trim();
}

async function runGitArchive(
  cwd: string,
  revision: string,
  subpath: string,
): Promise<Buffer> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const { stdout } = await execFileAsync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "submodule.recurse=false",
      "archive",
      "--format=tar",
      `${revision}:${subpath}`,
    ],
    {
      cwd,
      encoding: "buffer",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
      env: {
        ...environment,
        GIT_ATTR_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(cwd, ".oh-my-dsh-empty-gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

async function atomicWrite(path: string, value: string): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

interface CollectedFile {
  relative: string;
  contents: Buffer;
}

async function collectPortableFiles(
  root: string,
  maxFiles = 256,
): Promise<CollectedFile[]> {
  const collected: CollectedFile[] = [];
  const foldedPaths = new Set<string>();
  let totalBytes = 0;

  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.name === ".git")
        throw new Error("nested Git metadata is not allowed in a setup source");
      const windowsBase = entry.name.split(".")[0]!.toLowerCase();
      if (
        !PORTABLE_SEGMENT.test(entry.name) ||
        entry.name === "." ||
        entry.name === ".." ||
        entry.name.normalize("NFC") !== entry.name ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(windowsBase)
      ) {
        throw new Error(`source entry is not a portable path: ${entry.name}`);
      }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const folded = relative.normalize("NFC").toLocaleLowerCase("en-US");
      if (foldedPaths.has(folded))
        throw new Error(`case-insensitive path collision: ${relative}`);
      foldedPaths.add(folded);
      const source = join(directory, entry.name);
      const stat = await lstat(source);
      if (stat.isSymbolicLink())
        throw new Error(`symbolic link is not allowed: ${relative}`);
      if (stat.isDirectory()) {
        await visit(source, relative);
        continue;
      }
      if (!stat.isFile())
        throw new Error(`unsupported source entry: ${relative}`);
      if ((stat.mode & 0o111) !== 0)
        throw new Error(`executable source file is not allowed: ${relative}`);
      if (/\.(?:omdsh-agent|zip|tar|tgz|gz|7z)$/i.test(relative))
        throw new Error(`nested archive is not allowed: ${relative}`);
      if (stat.size > 1024 * 1024)
        throw new Error(`source file exceeds 1 MiB: ${relative}`);
      totalBytes += stat.size;
      if (totalBytes > 4 * 1024 * 1024)
        throw new Error("source exceeds 4 MiB expanded size limit");
      if (collected.length >= maxFiles)
        throw new Error(`source exceeds ${maxFiles} file limit`);
      collected.push({ relative, contents: await readFile(source) });
    }
  };

  await visit(root, "");
  if (collected.length === 0)
    throw new Error("Git source setup directory is empty");
  return collected;
}

function digestFiles(files: readonly CollectedFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relative.normalize("NFC"));
    hash.update("\0");
    hash.update(createHash("sha256").update(file.contents).digest("hex"));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function tarText(header: Buffer, start: number, length: number): string {
  return header
    .subarray(start, start + length)
    .toString("utf8")
    .replace(/\0.*$/s, "");
}

function tarNumber(header: Buffer, start: number, length: number): number {
  const value = tarText(header, start, length).trim();
  if (!/^[0-7]+$/.test(value))
    throw new Error("Git archive has invalid tar metadata");
  return Number.parseInt(value, 8);
}

function assertPortableArchivePath(path: string): void {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\"))
    throw new Error(`source entry is not a portable path: ${path}`);
  for (const segment of path.split("/")) {
    const windowsBase = segment.split(".")[0]!.toLowerCase();
    if (
      !PORTABLE_SEGMENT.test(segment) ||
      segment === "." ||
      segment === ".." ||
      segment.normalize("NFC") !== segment ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(windowsBase)
    )
      throw new Error(`source entry is not a portable path: ${path}`);
  }
}

function collectGitArchive(archive: Buffer): CollectedFile[] {
  const files: CollectedFile[] = [];
  const folded = new Set<string>();
  let totalBytes = 0;
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarText(header, 0, 100);
    const prefix = tarText(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = tarNumber(header, 124, 12);
    const mode = tarNumber(header, 100, 8);
    const type = String.fromCharCode(header[156] ?? 0);
    offset += 512;
    if (offset + size > archive.length)
      throw new Error("Git archive is truncated");
    assertPortableArchivePath(path.replace(/\/$/, ""));
    if (type === "5") {
      offset += Math.ceil(size / 512) * 512;
      continue;
    }
    if (type !== "0" && type !== "\0")
      throw new Error(
        `symbolic link or unsupported Git entry is not allowed: ${path}`,
      );
    if ((mode & 0o111) !== 0)
      throw new Error(`executable source file is not allowed: ${path}`);
    if (/\.(?:omdsh-agent|zip|tar|tgz|gz|7z)$/i.test(path))
      throw new Error(`nested archive is not allowed: ${path}`);
    if (size > 1024 * 1024)
      throw new Error(`source file exceeds 1 MiB: ${path}`);
    totalBytes += size;
    if (totalBytes > 4 * 1024 * 1024)
      throw new Error("source exceeds 4 MiB expanded size limit");
    if (files.length >= 256) throw new Error("source exceeds 256 file limit");
    const foldedPath = path.normalize("NFC").toLocaleLowerCase("en-US");
    if (folded.has(foldedPath))
      throw new Error(`case-insensitive path collision: ${path}`);
    folded.add(foldedPath);
    files.push({
      relative: path,
      contents: Buffer.from(archive.subarray(offset, offset + size)),
    });
    offset += Math.ceil(size / 512) * 512;
  }
  if (files.length === 0)
    throw new Error("Git source setup directory is empty");
  return files.sort((left, right) =>
    left.relative.localeCompare(right.relative),
  );
}

async function ensureDirectory(path: string, label: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink())
      throw new Error(`refusing ${label} symbolic link: ${path}`);
    if (!stats.isDirectory())
      throw new Error(`${label} is not a directory: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
}

async function verifyCachedSource(
  directory: string,
  expectedFiles: readonly CollectedFile[],
  lockContents: string,
): Promise<void> {
  const stats = await lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory())
    throw new Error("cached source path is not a regular directory");
  const cached = await collectPortableFiles(directory, 257);
  const expected = new Map<string, Buffer>([
    ...expectedFiles.map((file) => [file.relative, file.contents] as const),
    ["source-lock.json", Buffer.from(lockContents, "utf8")],
  ]);
  if (
    cached.length !== expected.size ||
    cached.some((file) => !expected.get(file.relative)?.equals(file.contents))
  ) {
    throw new Error("cached source content mismatch");
  }
}

export async function materializePinnedGitSource(
  options: MaterializeGitSourceOptions,
): Promise<MaterializedGitSource> {
  if (!FULL_COMMIT.test(options.revision))
    throw new Error(
      "Git source revision must be a full commit SHA (40 lowercase hex characters)",
    );
  const parsed = parseGithubSource(options.source);
  if (options.repositoryUrlOverride && !options.allowLocalRepositoryForTests) {
    throw new Error("repository URL overrides are test-only");
  }
  const repositoryUrl = options.repositoryUrlOverride ?? parsed.repositoryUrl;
  await ensureDirectory(options.stateRoot, "state root");
  const sourcesRoot = join(options.stateRoot, "sources");
  await ensureDirectory(sourcesRoot, "sources root");
  const stagingRoot = await mkdtemp(join(options.stateRoot, ".git-source-"));
  const checkout = join(stagingRoot, "checkout");

  try {
    await mkdir(checkout, { mode: 0o700 });
    await runGit(checkout, ["init", "--quiet"]);
    await runGit(checkout, ["remote", "add", "origin", repositoryUrl]);
    await runGit(checkout, [
      "fetch",
      "--quiet",
      "--depth=1",
      "--filter=blob:none",
      "--no-tags",
      "origin",
      options.revision,
    ]);
    const actualRevision = await runGit(checkout, ["rev-parse", "FETCH_HEAD"]);
    if (actualRevision !== options.revision) {
      throw new Error(
        `Git source revision mismatch: expected ${options.revision}, received ${actualRevision}`,
      );
    }

    const files = collectGitArchive(
      await runGitArchive(checkout, actualRevision, parsed.subpath),
    );
    const contentDigest = digestFiles(files);
    const identityDigest = createHash("sha256")
      .update(parsed.identity)
      .digest("hex")
      .slice(0, 12);
    const directory = join(sourcesRoot, `${contentDigest}-${identityDigest}`);
    const lockPath = join(directory, "source-lock.json");
    const lockContents = `${JSON.stringify(
      {
        source: parsed.identity,
        repository: parsed.repository,
        revision: options.revision,
        contentDigest,
      },
      null,
      2,
    )}\n`;

    try {
      await lstat(directory);
      await verifyCachedSource(directory, files, lockContents);
      return {
        source: parsed.identity,
        revision: options.revision,
        contentDigest,
        directory,
        lockPath,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const materialized = join(stagingRoot, "materialized");
    await mkdir(materialized, { recursive: true, mode: 0o700 });
    for (const file of files) {
      const destination = join(materialized, ...file.relative.split("/"));
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const handle = await open(destination, "wx", 0o600);
      try {
        await handle.writeFile(file.contents);
      } finally {
        await handle.close();
      }
    }
    await atomicWrite(join(materialized, "source-lock.json"), lockContents);
    try {
      await rename(materialized, directory);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" &&
        (error as NodeJS.ErrnoException).code !== "ENOTEMPTY"
      ) {
        throw error;
      }
      await verifyCachedSource(directory, files, lockContents);
    }
    return {
      source: parsed.identity,
      revision: options.revision,
      contentDigest,
      directory,
      lockPath,
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
