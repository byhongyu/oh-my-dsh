# oh-my-dsh

Curated agents for real work. Switch in seconds. Make them yours. Share them anywhere.

<p align="center">
  <a href="docs/assets/oh-my-dsh-demo.mp4">
    <img src="docs/assets/oh-my-dsh-demo.gif" width="960" alt="A 15-second terminal demo of listing oh-my-dsh setups, switching from Coding to Research, and forking Investing into a custom setup." />
  </a>
</p>

<p align="center"><sub>Discover → switch → fork. Click the demo for the full-quality MP4.</sub></p>

`oh-my-dsh` is an independent, opinionated Agent Setup layer for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It installs three deliberately different setups:

- **Coding** — inspect, change, test, and review a repository with bounded workspace authority.
- **Research** — source-grounded research with citations, evidence quality, and uncertainty.
- **Investing** — company and thesis analysis with scenarios, risks, and no trade execution.

It does not replace DSH, the oh-dsh Desktop shell, providers, sessions, or plugin marketplaces.

## Status

This repository targets DSH `0.1.0-rc.5/rc.6` through the `dsh-rc5` adapter. DSH is a developer preview and may make compatibility-breaking changes.

The adapter emits only capabilities verified in the stock target releases. Stock DSH supports web search but not arbitrary URL fetch, browser automation, PDF extraction, spreadsheets, or market-data readers. Research and Investing plans report those semantic capabilities as unavailable until separately audited host plugins are present; they never silently claim those tools are enforced.

## Development

Requirements: Node.js 24+ and pnpm 11.

```bash
pnpm install
pnpm build
pnpm test
pnpm test:coverage
```

Run the workspace CLI:

```bash
node packages/cli/dist/bin.cjs list
node packages/cli/dist/bin.cjs plan coding
```

## CLI surface

```text
oh-my-dsh init
oh-my-dsh list [--json]
oh-my-dsh use research --default
oh-my-dsh plan [setup] [--json]
oh-my-dsh apply
oh-my-dsh update [--apply]
oh-my-dsh rollback
oh-my-dsh doctor [--json]

oh-my-dsh agent fork investing --as my-investing
oh-my-dsh agent save my-investing
oh-my-dsh agent export my-investing [--output file.omdsh-agent]
oh-my-dsh agent import file.omdsh-agent --yes
oh-my-dsh agent add github:owner/repo/path --rev <full-commit-sha>
```

Use `--dsh-home <path>` to target an isolated home during testing. Production otherwise uses `$DSH_HOME`, then `~/.dsh`.

## Trust boundary

- Plans, imports, and Git-source inspection parse data without loading third-party plugin modules.
- User presets are still DSH compositions and ultimately have the authority of their loaded plugins. DSH's `user` trust marker is descriptive, not a sandbox.
- oh-my-dsh emits no telemetry and does not handle provider credentials.
- A setup selects exposed tools and workflows; it does not create OS/process isolation.
- Existing sessions keep the setup generation with which they started.

See [Architecture](docs/architecture.md) and [Threat model](docs/threat-model.md).

## Independence and naming

This project is independent and is not affiliated with or endorsed by DeepSeek AI, oh-my-zsh, or Oh-DSH-Desktop contributors. It uses no upstream logos or trade dress. Public release remains subject to a separate name/trademark clearance review.

## License

MIT. Interoperation does not redistribute DSH or oh-dsh source. See [LICENSE](LICENSE).
