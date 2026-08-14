# Threat model

## Protected assets

- Existing DSH/user configuration outside namespaced managed paths.
- Credentials, environment values, prompts, sessions, and machine-specific paths.
- The last bootable setup generation.
- The integrity and provenance identity of imported setup data.

## Untrusted inputs

- YAML Agent Setup and fork definitions.
- `.omdsh-agent` files and every declared file within them.
- Git repositories, subpaths, and revisions.
- Existing filesystem entries at DSH-home mutation targets.

## Controls

- Strict schemas reject unknown fields and executable lifecycle concepts.
- YAML is parsed as data with alias limits and no custom JavaScript tags.
- Portable paths reject absolute paths, backslashes, dot segments, NULs, duplicates, Unicode/case-folded collisions, links, and undeclared external files.
- Archives and local manifests are opened without following links, confirmed to be regular files, and bounded before allocation. Archives additionally enforce entry count, per-file, and expanded-size limits. Checksums and normalized setup hashes bind the result.
- Export rejects credential-like values, absolute machine paths, session/history/cache/log material, nested archives, and executable/hook files. Environment-variable references remain data-only.
- Git sources require a full commit SHA. A partial fetch and bounded `git archive` run with isolated configuration, hooks, external filters, filesystem monitors, submodules, and terminal prompts disabled. No worktree checkout occurs. Links, executable files, nested archives, unsafe paths, and oversized inputs are rejected before materialization.
- Existing setup locks are verified before plan or activation, including definition hashes, exact asset checksums, resolved capabilities, adapter bindings, and pinned-source provenance.
- DSH settings symlinks and concurrent lock ownership are refused. A namespaced operation lock serializes publication; stale operations recover the last active generation. Managed writes use owner-only temporary files and same-filesystem rename.
- Import, plan, and source acquisition never import plugin modules or run package install scripts.

## Residual risk

DSH user presets are executable plugin compositions. Pinning, checksums, provenance, and preview improve accountability and reversibility but do not sandbox a malicious Node plugin. Once activated, a plugin can have the authority of the DSH process unless DSH or the operating system separately restricts it.

The stock rc.5/rc.6 adapter can select tools but cannot independently enforce a read-only operating-system filesystem or network sandbox. User-facing output must not imply otherwise.

The verified stock adapter does not provide document extraction, spreadsheets, market-data readers, arbitrary URL fetch, or browser automation. Research and Investing compilation reports these capabilities as unavailable; oh-my-dsh does not substitute unreviewed plugins or imply that those workflows are executable on an unextended stock host.
