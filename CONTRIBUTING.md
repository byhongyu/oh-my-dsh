# Contributing to oh-my-dsh

Thanks for helping improve `oh-my-dsh`. Small, focused changes with tests are easiest to review.

## Before you start

- Search existing issues and pull requests for related work.
- Open an issue before a large behavioral or architectural change.
- Report security vulnerabilities privately through [the security policy](SECURITY.md).
- Keep the project independent from upstream branding, logos, and trade dress.

## Development setup

Requirements:

- Node.js 24 or newer
- pnpm 11
- Git

```bash
git clone https://github.com/byhongyu/oh-my-dsh.git
cd oh-my-dsh
pnpm install --frozen-lockfile
pnpm build
```

Run the complete local verification suite before opening a pull request:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:coverage
pnpm build
```

## Change guidelines

- Add or update tests before changing behavior when practical.
- Preserve the trust boundaries documented in [`docs/threat-model.md`](docs/threat-model.md).
- Treat imported setups, archives, Git sources, paths, and plugin metadata as untrusted data.
- Keep CLI output deterministic and support `--json` where the surrounding command does.
- Update user-facing documentation when commands, compatibility, or behavior changes.
- Do not commit generated build output, credentials, local DSH state, or provider data.

## Pull requests

Create a short-lived branch from `main`, use a conventional commit, and open a pull request. Examples:

```text
feat(cli): add setup inspection
fix(core): reject duplicate archive paths
docs: clarify DSH compatibility
```

Pull requests must pass the required `verify` check. Keep each pull request focused, explain the motivation and security impact, and identify the commands used for validation.

By contributing, you agree that your contribution is licensed under the repository's [MIT License](LICENSE).
