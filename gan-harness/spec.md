# oh-my-dsh v0.1 build specification

Source of truth: [`../oh-my-dsh-technical-design.md`](../oh-my-dsh-technical-design.md).

This file is a normalized build brief, not an additional product specification.

## Product outcome

Ship a packageable TypeScript/pnpm CLI that installs exactly three curated Agent Setups—Coding, Research, and Investing—into a supported DeepSeek Harness home. A user can select a setup for a future session without downloading plugins or restarting the host, fork a built-in as a minimal delta, and share it as a deterministic, inspectable archive or pinned Git source.

## Locked implementation boundaries

- Use Node 24+ and pnpm 11 with no required native dependency.
- Keep the canonical schema/resolver independent from DSH paths and plugin syntax.
- Support DSH `0.1.0-rc.5/rc.6` through one versioned adapter.
- Parse setup, import, and plan inputs as data without executing third-party code.
- Preserve native user configuration outside the oh-my-dsh-managed subtree.
- Use immutable generations, validate before publication, and retain rollback state.
- Emit no telemetry and perform no warm session-switch network access.
- Do not implement a new shell, UI, provider proxy, session store, marketplace, scheduler, theme system, or brokerage write path.

## Vertical slices

1. Strict schemas, Coding catalog data, deterministic resolver, DSH compiler, and read-only plan.
2. Safe init/list/use with an immutable first generation.
3. Research and Investing plus all five capability packs and restrictive policy composition.
4. Fork/save and semantic delta planning.
5. Deterministic export/import with resource and content safety checks.
6. Full-commit Git source add and source continuity locking.
7. Update/reconcile, doctor, rollback, and failure-injection recovery.
8. Setup scenarios, packed CLI verification, and cross-platform/no-color/JSON output.

## Critical acceptance journey

On an isolated DSH home: initialize once; list and select every built-in; prove their normalized tool and permission sets differ; fork Investing with one instruction; observe a one-field semantic delta; export and import it with the same normalized hash; reject a corrupted archive before activation; and recover the previous generation after every injected filesystem failure.
