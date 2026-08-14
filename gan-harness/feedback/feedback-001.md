# GAN harness feedback 001

Date: 2026-08-14
Mode: code-only
Rubric: `gan-harness/eval-rubric.md`

## Score

9.0 / 10 — pass

## Evidence

- Functionality (3.1 / 3.5): all documented commands and the three built-in
  setup journeys are implemented. Forks, deterministic archives, pinned Git
  sources, generations, doctor, rollback, and installed-state update checks are
  exercised. Stock DSH lacks several semantic Research and Investing plugins;
  compilation exposes this as warnings rather than claiming unavailable tools.
- Safety and durability (2.8 / 3.0): strict schemas, bounded no-follow reads,
  content-safety checks, portable paths, exact checksums, local lock enforcement,
  isolated data-only Git ingestion, operation serialization, stale-operation
  recovery, failure injection, and rollback are covered. The DSH process remains
  the enforcement boundary for emitted plugins.
- Product coherence (1.8 / 2.0): Coding, Research, and Investing remain distinct;
  restrictive permissions remove contradictory tools, plans expose warnings and
  fork deltas, and the CLI consistently avoids sandbox claims.
- Engineering quality (1.3 / 1.5): strict TypeScript package boundaries, 147
  deterministic tests, all global coverage categories above 80%, release build,
  third-party inventory, and clean packed-install smoke coverage.

## Discriminator review

The first review identified overly broad adapter plugins, missing checksum-set
validation, concurrent lifecycle races, untrusted Git checkout behavior, unsafe
unbounded reads, unenforced installed locks, weak portable names, and misleading
credential-validation output. The implementation was revised to fail closed at
adapter boundaries, validate exact manifests and locks, serialize/recover home
mutations, parse bounded `git archive` data with isolated configuration, centralize
portable-content validation, and exercise those cases in regression tests.

## Residual limitations

- The verified stock rc.5/rc.6 host has no audited document, spreadsheet,
  arbitrary-fetch, browser, or market-data contribution for this project.
- Tool selection is not an operating-system sandbox. A loaded DSH plugin retains
  the authority of the DSH process.
- Scenario tests are deterministic and keyless; live provider behavior is outside
  this code-only evaluation.
