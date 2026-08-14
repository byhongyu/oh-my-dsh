# oh-my-dsh roadmap

`oh-my-dsh` aims to become the small, trustworthy Agent Setup layer for DeepSeek Harness—not a giant prompt marketplace. Priorities are ordered by user safety, DSH compatibility, and repeatable cross-host behavior.

The roadmap describes direction, not delivery dates. DSH is a developer preview, so upstream contracts may change the order or shape of individual items.

## v0.1 — prove the setup layer

Shipped:

- Coding, Research, and Investing built-ins with distinct permissions and workflows;
- semantic planning, atomic apply, doctor, and rollback;
- safe local forks with inheritance and lockfiles;
- portable import/export archives with integrity and secret/path checks;
- exact-commit Git sources with bounded, data-only extraction;
- a versioned adapter for DSH `0.1.0-rc.5` and `0.1.0-rc.6`; and
- deterministic JSON output and cross-package test coverage gates.

## v0.2 — prove evolution and social use

Planned:

- a second versioned DSH adapter;
- fork reconciliation when a parent setup changes;
- a curated community setup channel with explicit maintainer review;
- optional provenance verification for shared setups;
- stable Duplicate, Export, and Import front-end actions if DSH exposes suitable contracts; and
- a bounded “Continue as…” new-session handoff if DSH exposes a stable session-seed contract.

The v0.2 acceptance target is to import a reviewed community setup, inspect its permissions, fork it, update its parent across a breaking DSH release, resolve a deliberate conflict, and roll back without changing the source session or user overrides.

## v1.0 — stabilize the setup ecosystem

Targets:

- stable v1 schemas for Agent Setups, Capability Packs, locks, and exports;
- two supported DSH release lines with a documented deprecation policy;
- no more than five maintained built-ins;
- signed CLI and catalog releases with a reproducibility report; and
- cross-host compatibility for DSH Web and one desktop host.

## Principles that will not change

- Existing sessions keep the setup generation with which they started.
- Starting a session performs no package installation or network resolution.
- Setup data cannot enable data export, hidden credential access, or brokerage execution.
- Imported and Git-sourced setups remain inspectable data until explicitly applied.
- Popularity alone is not a curation or trust signal.

## Contribute

Ideas and design questions belong in [Discussions](https://github.com/byhongyu/oh-my-dsh/discussions). Concrete, bounded work belongs in [Issues](https://github.com/byhongyu/oh-my-dsh/issues). Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the [threat model](docs/threat-model.md) before proposing implementation changes.
