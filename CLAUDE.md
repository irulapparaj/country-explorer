# CLAUDE.md — working rules for this repo

## Read this first, then ARCHITECTURE.md

**`ARCHITECTURE.md` is the project's context file.** It describes what Country Explorer is, the module
map, the runtime flows, the data/reliability contract, and a "where to change what" table.

**Before any task in this repo: read `ARCHITECTURE.md` and open only the files it points you to.**
Do not scan the tree, do not grep the whole codebase, do not re-derive the architecture. That file
exists precisely so that never has to happen again.

Supporting docs, read only when needed:
- `README.md` — product behaviour + the authoritative list of known limitations and data-source quirks.
  Check it before treating anything as a bug; most surprises there are documented, tested decisions.
- `WorldMapProjectPrompt.md` — the original spec.
- `_legacy/` — dead prototypes. Never read, never edit.

## Non-negotiables

1. **Zero build step.** Plain ES modules loaded by `index.html`. No bundler, no framework, no runtime
   npm dependency. `package.json` is for the test suite only.
2. **No hardcoded country facts.** Everything real comes from a live API. Exceptions are listed in
   `ARCHITECTURE.md` §7 — adding a new one needs an explicit reason recorded there.
3. **Never show a failed request as missing data.** Keep *failed* / *not available* / *no local file*
   distinct, and never cache a failed or partial result (`ARCHITECTURE.md` §6).
4. **Every network call goes through `lib/http.js`** (MediaWiki calls through `lib/mediaWikiApi.js`).
5. **Pure logic in its own module**, DOM/D3/network in the component — that is what keeps the unit
   suite meaningful. New decision logic must be pure and unit-tested.
6. Immutable state (`store.js`, `normalizeOptions`), `textContent` over `innerHTML`, semantic HTML,
   design tokens from `styles/variables.css`.

## Verification before calling work done

```sh
npm run test:unit        # must pass; no network
npm run test:e2e         # live APIs; --workers=2 avoids 429s. Re-run failures serially before believing them
```

## Keeping ARCHITECTURE.md current (required)

`ARCHITECTURE.md` is only useful while it is true. **In the same change that touches the code, update
it** — never as a follow-up task.

Update it when any of these happen:

| Change | Section to update |
|---|---|
| A file/module is added, removed, renamed, or changes responsibility | §2 Repo map, §4 if it is a map module |
| A new UI surface, view, or route | §2, §3 Runtime flows |
| The boot/selection/country-page/options flow changes | §3 |
| A data source, client, or merge shape changes | §5, and the data-source table in `README.md` |
| Caching, retry, timeout, deadline, or failure-handling behaviour changes | §6 |
| A new hardcoded value, override, or documented exception | §7 |
| Bundled data or a build script changes | §2 `data/`+`scripts/` table |
| Scripts, test commands, or ports change | §9 |
| A new known limitation | `README.md` limitations list (§10 only points there) |

Rules for editing it:
- Keep it **dense and current**, not a changelog. Replace stale statements; do not append history.
- Do not duplicate `README.md` — link to it. One fact, one home.
- Keep constants, file names, and script names exact; a wrong pointer is worse than no pointer.
- If a change makes a section wrong and you cannot fix it properly, say so in your reply rather than
  leaving a confident-but-stale description in place.

## Git

Git repository on branch `main`, remote `origin` → https://github.com/irulapparaj/country-explorer.
Use conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`). Do not commit or
push unless asked.
