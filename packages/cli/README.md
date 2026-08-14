# oh-my-dsh CLI

Curated Coding, Research, and Investing Agent Setups for DeepSeek Harness.

Try the v0.1.0 GitHub release without installing it:

```bash
npx --yes --package \
  https://github.com/byhongyu/oh-my-dsh/releases/download/v0.1.0/oh-my-dsh-0.1.0.tgz \
  oh-my-dsh list
```

Install and initialize:

```bash
npm install --global \
  https://github.com/byhongyu/oh-my-dsh/releases/download/v0.1.0/oh-my-dsh-0.1.0.tgz

oh-my-dsh init
oh-my-dsh list
oh-my-dsh plan coding
oh-my-dsh use research --default
oh-my-dsh doctor
```

Fork and share a setup:

```bash
oh-my-dsh agent fork investing --as my-investing
oh-my-dsh agent save my-investing
oh-my-dsh agent export my-investing
oh-my-dsh agent import my-investing-0.1.0.omdsh-agent --yes
oh-my-dsh apply
```

Use `--dsh-home <path>` to override `$DSH_HOME`/`~/.dsh`, and `--json` for deterministic machine-readable output. Run `oh-my-dsh --help` for the full command list.

This independent project is not affiliated with or endorsed by DeepSeek AI, oh-my-zsh, or Oh-DSH-Desktop contributors. Agent presets select DSH plugins; they do not sandbox plugin code or provide operating-system isolation.
