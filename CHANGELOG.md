# Changelog

All notable changes to oh-my-dsh are documented here.

## 0.1.0 — 2026-08-14

### Added

- Coding, Research, and Investing Agent Setups backed by five composable
  capability packs.
- Strict portable setup schemas, deterministic resolution, semantic diffs, and
  a versioned DSH rc.5/rc.6 adapter.
- CLI journeys for initialization, planning, switching, applying, updating,
  diagnosis, rollback, forks, archives, and pinned Git sources.
- Immutable DSH-home generations with atomic publication, operation locking,
  failure recovery, checksums, and rollback.
- Deterministic `.omdsh-agent` archives with resource limits, portable paths,
  content-safety validation, and exact lock/provenance verification.
- Data-only Git ingestion through bounded `git archive` streams with isolated
  Git configuration and immutable commit identities.

### Security

- Restrictive permission composition removes tools that contradict effective
  setup policy and fails closed when a stock DSH plugin is too broad.
- Local files use bounded, no-follow reads; managed roots reject symlinks and
  imported assets are bound to exact checksums.
- Concurrent lifecycle mutations are serialized and stale operations recover
  the last active immutable generation.

### Verification

- 147 deterministic tests pass across 11 test files.
- Coverage is 91.83% statements/lines, 80.04% branches, and 97.34% functions.
- The bundled CLI passes clean-install package smoke tests on Node.js 24.

### Known limitations

- Stock DSH rc.5/rc.6 lacks audited document, spreadsheet, browser, and
  market-data plugins required for some Research and Investing workflows; plans
  report these as unavailable.
- Tool selection is not an operating-system sandbox. Loaded DSH plugins retain
  the authority of the DSH process.
