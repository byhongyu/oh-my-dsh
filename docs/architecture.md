# Architecture

oh-my-dsh keeps portable intent separate from host materialization:

```text
Agent Setup YAML / built-in catalog
              │
              ▼
 strict schema + dependency resolver + restrictive policy merge
              │
              ▼
 host-neutral ResolvedSetup + normalized SHA-256
              │
              ▼
 dsh-rc5 adapter → immutable generation → validated publication
              │
              ▼
 <DSH_HOME>/.agent-presets/oh-my-dsh-*/
```

## Packages

- `@oh-my-dsh/schema` owns strict `v1alpha1` data contracts and portable path rules.
- `@oh-my-dsh/catalog` owns exactly three setups and five reusable capability packs.
- `@oh-my-dsh/core` owns topological resolution, permission policy, canonical hashes, forks, semantic diffs, archives, and pinned sources. It has no DSH-home path knowledge.
- `@oh-my-dsh/adapter-dsh-rc5` compiles verified DSH rows and owns DSH-home generations, settings, publication, doctor, and rollback.
- `oh-my-dsh` is the user-facing CLI and packaged executable.

## Resolution

Capability dependencies are topologically sorted. Cycles, missing exact versions, and duplicate workflow/plugin IDs fail. Denied tools override allowed tools. Capability permissions combine restrictively; a root setup can request a more permissive value only with a recorded explanation. Secrets never appear in capability or lock data.

Canonical hashes recursively sort object keys while retaining list order. They cover semantic portable content, not host paths or archive-container metadata.

## DSH integration

The supported DSH Web profile already composes `@deepseek-ai/dsh-agent-presets` and appends `<DSH_HOME>/.agent-presets` as its user root. oh-my-dsh therefore does not patch `cordis.patch.yml` or add a Cordis Include.

Each generated preset contains:

```text
<DSH_HOME>/.agent-presets/oh-my-dsh-<id>/
├── agent.cordis.yml
└── preset.yml
```

The adapter uses verified rows including `dsh-persona`, `dsh-agent-instructions`, `dsh-tool-fs`, `dsh-tool-fs-search`, the platform shell tool, and search-only `dsh-tool-web`. Unsupported semantic tools become explicit plan warnings.

Changing the default mutates only `agent-presets.default` in `settings.yaml`. Existing sessions are never rewritten.

## Generations

A generation contains its manifest, complete compiled preset set, and checksums. Publication stages data on the same filesystem, validates it, replaces only `oh-my-dsh-*` preset directories, updates settings under its lock contract, and writes the active marker last. The previous generation is retained for rollback. On a caught mutation failure, already-published files and settings are restored before the error returns.

Lifecycle operations hold an exclusive owner-token lock across generation creation, publication, settings, and marker updates. A later operation can recover a stale lock and republishes the last active immutable generation before cleaning interrupted namespaced stages or backups. Activation and rollback require exact equality between the generation manifest's files and its checksum inventory.

Saved, imported, and Git-sourced agents retain a local lock. Plan and activation verify the definition hash, declared asset checksums, adapter binding, capability closure, and source provenance before trusting an existing lock. Editing a locked agent therefore requires an explicit `agent save` or new fork rather than silently changing the next activation.

## Portability

`.omdsh-agent` is a canonical, newline-terminated JSON envelope rather than an executable package. It carries a strict setup, strict lock metadata, sorted portable files encoded as canonical base64, and per-file checksums. Container metadata and host bindings never affect the normalized setup hash.

Pinned Git input uses partial fetch followed by `git archive`; it never checks out a worktree. Git configuration is isolated, external filters and filesystem monitors are disabled, and the bounded tar stream is parsed as data. Materialization writes the already-validated captured bytes and revalidates cached materializations against a fresh fetch.
