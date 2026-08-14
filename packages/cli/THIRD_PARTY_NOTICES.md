# Bundled dependency inventory

The `oh-my-dsh` executable bundles these runtime libraries:

- `yaml` 2.9.0 — ISC license
- `zod` 4.4.3 — MIT license

The remaining bundled modules are the MIT-licensed `@oh-my-dsh/*` workspace
packages in this repository. Node.js built-in modules are referenced from the
host runtime and are not bundled. `esbuild` is used only to produce the release
artifact and is not part of the executable.
