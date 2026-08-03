# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — this repo is single-context, so there is no `CONTEXT-MAP.md`.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo (this repo):

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-dbside-companies-list-via-app-owned-canonical-columns.md
│   ├── 0002-virtual-column-enrichment-filtering.md
│   └── 0003-emailbison-two-push-actions.md
└── app/, lib/, components/, ...
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md` — e.g. **canonical value**, **canonical column**, **facet**, **enrichment field**, **virtual column**, **filterable type**, **push action**, **companies-table push**. Don't drift to synonyms the glossary explicitly avoids (e.g. "custom field" for enrichment field, "computed/derived column" for virtual column).

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0003 (EmailBison two push actions) — but worth reopening because…_
