# oh-my-dsh v0.1 test evidence

Date: 2026-08-14

The implementation was built in vertical slices. Each new slice began with a
focused failing test, then passed its focused suite before the workspace gate
was run.

## RED evidence

| Slice                           | Initial observed failure                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Schema/catalog/resolver/adapter | Three suites failed because the new package modules did not exist.                                       |
| Built-in scenario corpus        | Six scenario assertions failed before the Research/Investing catalog behavior was completed.             |
| Custom forks                    | Resolver tests failed before `resolveCustomSetup` existed.                                               |
| Fork persistence                | `setup-files.test.ts` failed on missing `setup-files.js`.                                                |
| Pinned Git source               | `git-source.test.ts` failed on missing `git-source.js`, then on one diagnostic contract mismatch.        |
| Fork update planning            | `update.test.ts` failed on missing `update.js`.                                                          |
| Portable archive                | `archive.test.ts` failed on missing `archive.js`.                                                        |
| DSH-home lifecycle              | `home.test.ts` failed on missing `home.js`.                                                              |
| Read-only CLI                   | `cli.test.ts` failed on missing `index.js`.                                                              |
| Stateful CLI                    | Five journey tests failed because `init`, `use`, lifecycle, and `agent` options were not yet recognized. |

## Focused GREEN evidence

- Portable archive: 50/50, including exact declared-file binding, archive limits,
  path collisions, and portable-content checks.
- DSH-home lifecycle: 17/17, including operation locking, stale-operation
  recovery, exact checksum coverage, symlink checks, and exhaustive observed
  mutation failure injection.
- Read-only CLI: 17/17; its initial focused coverage exceeded 80% in every
  category.
- Stateful CLI journeys: 10/10 after command wiring, bounded reads, lock
  enforcement, pinned-source provenance, and branch cases.
- Built-in scenarios: 13/13 deterministic, keyless assertions.
- Custom setup persistence: 6/6, including safe-root and unsafe-content guards.

## Final workspace gate

```text
pnpm test:coverage
11 test files passed
147 tests passed
91.83% statements
80.04% branches
97.34% functions
91.83% lines
```

The final `lint`, `format:check`, `typecheck`, and `build` commands also pass.
The build emits a bundled CommonJS executable with a Node shebang.

## Packed artifact smoke

`pnpm pack` produced `oh-my-dsh-0.1.0.tgz` containing only the bundled CLI,
license, README, and manifest. Installing that tarball into a clean temporary
directory with install scripts disabled succeeded; its installed binary printed
`0.1.0` and returned the three deterministic setups from `list --json` without
workspace packages present.
