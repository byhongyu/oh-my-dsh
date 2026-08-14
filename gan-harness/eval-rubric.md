# oh-my-dsh v0.1 evaluator rubric

Evaluation mode: `code-only`. Pass threshold: 8.0/10. Critical security or data-loss findings are an automatic failure.

## Functionality — 35%

- All documented v0.1 commands are present and exercise real application services.
- Exactly three built-ins and five capability packs resolve deterministically.
- Generated rc.5/rc.6 presets follow verified DSH contracts.
- Fork, archive, pinned-source, update, doctor, and rollback journeys work end to end.

## Safety and durability — 30%

- Strict schemas reject unknown fields, unsafe paths, unsupported hooks, and embedded credentials.
- Permission composition defaults to the most restrictive value and highlights elevation.
- Import and planning execute no third-party plugin code.
- Publication is staged, validated, atomic at the commit point, and recoverable.
- Archive and Git inputs resist traversal, links, bombs, mutable identities, and shell injection.

## Product coherence — 20%

- Each exposed tool supports a documented workflow and each built-in has a distinct job.
- Coding excludes broad research/deployment authority; Research excludes shell/write; Investing excludes trade execution.
- User-facing output uses Agent Setup terminology and communicates capability selection without claiming process isolation.

## Engineering quality — 15%

- Strict TypeScript boundaries match the specified package architecture.
- Unit, integration, packed-CLI, adapter-conformance, scenario, and failure-injection tests are deterministic.
- Global branches/functions/lines/statements coverage is at least 80%.
- Build, typecheck, lint, tests, coverage, and package smoke all pass on Node 24+ without native dependencies.
