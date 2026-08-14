import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  materializePinnedGitSource,
  parseGithubSource,
} from "../src/git-source.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oh-my-dsh-git-source-"));
  roots.push(root);
  return root;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("pinned Git sources", () => {
  it("requires a normalized GitHub source and full commit identity", () => {
    expect(
      parseGithubSource("github:owner/repository/setups/research"),
    ).toEqual({
      identity: "github:owner/repository/setups/research",
      repository: "owner/repository",
      repositoryUrl: "https://github.com/owner/repository.git",
      subpath: "setups/research",
    });
    expect(() => parseGithubSource("github:owner/repo/../escape")).toThrow(
      /source/i,
    );
  });

  it("materializes data from exactly the requested commit and records a content digest", async () => {
    const root = await temporaryRoot();
    const repository = join(root, "repository");
    const stateRoot = join(root, "state");
    await mkdir(join(repository, "setups", "research"), { recursive: true });
    await git(repository, "init");
    await git(repository, "config", "user.email", "tests@example.invalid");
    await git(repository, "config", "user.name", "Tests");
    await writeFile(
      join(repository, "setups", "research", "agent.yaml"),
      "kind: AgentSetup\n",
      "utf8",
    );
    await git(repository, "add", ".");
    await git(repository, "commit", "-m", "fixture");
    const revision = await git(repository, "rev-parse", "HEAD");

    const result = await materializePinnedGitSource({
      source: "github:owner/repository/setups/research",
      revision,
      stateRoot,
      repositoryUrlOverride: repository,
      allowLocalRepositoryForTests: true,
    });

    expect(result.revision).toBe(revision);
    expect(result.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(result.directory, "agent.yaml"), "utf8")).toBe(
      "kind: AgentSetup\n",
    );
    expect(JSON.parse(await readFile(result.lockPath, "utf8"))).toMatchObject({
      source: "github:owner/repository/setups/research",
      revision,
      contentDigest: result.contentDigest,
    });
  });

  it("rejects mutable revisions before invoking Git", async () => {
    const root = await temporaryRoot();
    await expect(
      materializePinnedGitSource({
        source: "github:owner/repository/setup",
        revision: "main",
        stateRoot: root,
      }),
    ).rejects.toThrow(/full commit/i);
  });

  it("rejects symlinks in the selected setup directory", async () => {
    const root = await temporaryRoot();
    const repository = join(root, "repository");
    await mkdir(join(repository, "setups", "bad"), { recursive: true });
    await git(repository, "init");
    await git(repository, "config", "user.email", "tests@example.invalid");
    await git(repository, "config", "user.name", "Tests");
    await writeFile(join(repository, "outside.txt"), "outside", "utf8");
    await symlink(
      "../../outside.txt",
      join(repository, "setups", "bad", "linked.txt"),
    );
    await git(repository, "add", ".");
    await git(repository, "commit", "-m", "fixture");
    const revision = await git(repository, "rev-parse", "HEAD");

    await expect(
      materializePinnedGitSource({
        source: "github:owner/repository/setups/bad",
        revision,
        stateRoot: join(root, "state"),
        repositoryUrlOverride: repository,
        allowLocalRepositoryForTests: true,
      }),
    ).rejects.toThrow(/symbolic link/i);
  });

  it("rejects source entries that are not portable across supported hosts", async () => {
    const root = await temporaryRoot();
    const repository = join(root, "repository");
    await mkdir(join(repository, "setups", "bad"), { recursive: true });
    await git(repository, "init");
    await git(repository, "config", "user.email", "tests@example.invalid");
    await git(repository, "config", "user.name", "Tests");
    await writeFile(
      join(repository, "setups", "bad", "not:portable.md"),
      "data",
      "utf8",
    );
    await git(repository, "add", ".");
    await git(repository, "commit", "-m", "fixture");
    const revision = await git(repository, "rev-parse", "HEAD");

    await expect(
      materializePinnedGitSource({
        source: "github:owner/repository/setups/bad",
        revision,
        stateRoot: join(root, "state"),
        repositoryUrlOverride: repository,
        allowLocalRepositoryForTests: true,
      }),
    ).rejects.toThrow(/portable path/i);
  });

  it("does not trust a poisoned materialization cache or source-root symlink", async () => {
    const root = await temporaryRoot();
    const repository = join(root, "repository");
    const stateRoot = join(root, "state");
    await mkdir(join(repository, "setups", "research"), { recursive: true });
    await git(repository, "init");
    await git(repository, "config", "user.email", "tests@example.invalid");
    await git(repository, "config", "user.name", "Tests");
    await writeFile(
      join(repository, "setups", "research", "agent.yaml"),
      "kind: AgentSetup\n",
      "utf8",
    );
    await git(repository, "add", ".");
    await git(repository, "commit", "-m", "fixture");
    const revision = await git(repository, "rev-parse", "HEAD");
    const options = {
      source: "github:owner/repository/setups/research",
      revision,
      stateRoot,
      repositoryUrlOverride: repository,
      allowLocalRepositoryForTests: true,
    } as const;
    const first = await materializePinnedGitSource(options);
    await writeFile(join(first.directory, "agent.yaml"), "poisoned\n", "utf8");
    await expect(materializePinnedGitSource(options)).rejects.toThrow(
      /cached source.*mismatch/i,
    );

    const linkedRoot = join(root, "linked-state");
    const outside = await temporaryRoot();
    await symlink(outside, linkedRoot);
    await expect(
      materializePinnedGitSource({ ...options, stateRoot: linkedRoot }),
    ).rejects.toThrow(/state root.*symbolic link/i);
  });
});
