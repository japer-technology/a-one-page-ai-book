# Contributing to Page Turn

Thanks for helping make the one-page AI book better. This document covers conventions, the workflow,
and the quality gates.

## Setup

```bash
corepack enable        # ensures the pinned pnpm version
pnpm install
pnpm dev               # http://localhost:4173
```

Node ≥ 20 required. Everything else is in `package.json` — there are **no runtime dependencies**;
all devDependencies are tooling (esbuild, typescript, vitest, eslint, prettier).

## Workflow

1. **Pick or open an issue.** Bug reports use the bug template; feature ideas the feature template.
   For anything non-trivial, describe your plan before writing code.
2. **Branch** from `main` with a short kebab-case name (`feat/emotion-dials`, `fix/ollama-cors`).
3. **Commit** using [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat: add emotion dials to the turn panel`
   - `fix: fall back to /v1 when Ollama 404s`
   - `test: cover version chooser edge cases`
   - `docs: document the OPFS mirror`
4. **Open a PR.** CI runs `pnpm check`; keep it green. Ask for review when unsure.

## Quality gates (all enforced by `pnpm check` and CI)

- **Typecheck** — TypeScript strict, `noUncheckedIndexedAccess` on. No `as any`.
- **Lint** — ESLint with typescript-eslint recommended. No unused code.
- **Format** — Prettier (config in `.prettierrc.json`). `pnpm fmt` before committing.
- **Tests** — pure domain changes require or update unit tests in `tests/`. Run `pnpm test`. Views
  (`src/ui/**`) are testable in the same suite: a test file starting with
  `// @vitest-environment happy-dom` can mount a REAL view via
  `mountView(new StubApp(lib, book), renderFoo)` from `tests/helpers/view-harness.ts` and assert on
  the rendered DOM plus the stub's recorded calls. `tests/views/*.test.ts` are the models. The stub
  repaints on `update()`/`refresh()` exactly like the shell, so re-render bugs (a control a
  re-render deletes, a stale panel, a form that stays open) are catchable — a view fix without such
  a test is only half a fix.
- **E2E (when touching discovery/settings/generation)** — `pnpm build && pnpm test:e2e` drives the
  real built file in headless Chromium (requires `chromium` in PATH) against a mock LLM server: boot
  → scan → use → save → test connection. Run it before merging anything in `src/llm`,
  `src/ui/views/settings.ts`, or `src/main.ts`.

  Focused browser checks live beside it in `scripts/e2e/`; each one exits non-zero on a failed
  assertion, so they work as regression tests:

  | script                | what it protects                                                                                                                                                                   |
  | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `single-slot.mjs`     | a book with only a first page against a ONE-generation-slot server (`PT_MOCK_SERIAL=1`): one generation + one upkeep call, no error toast, no busy-server failure                  |
  | `upkeep-failure.mjs`  | a failed background upkeep is quiet in the UI but still retryable (`PT_MOCK_BAD_JSON=1`)                                                                                           |
  | `seed-ideas.mjs`      | the dice ask the model, walk a batch, and fall back honestly; the pre-writing conversation is cleared on request and when a book is born                                           |
  | `session-measure.mjs` | a long session: the pre-writing chain stays windowed, the request log is bounded (`PT_MOCK_LOG=<path>`)                                                                            |
  | `lan-scan.mjs`        | a LAN sweep states its size, finds a responder, and a CANCELLED sweep is never reported as "No LLM servers found"                                                                  |
  | `detect-subnet.mjs`   | a browser that reveals its own address (stubbed WebRTC) is believed at once: no probe is fired at any other range, and the one-button scan sweeps the revealed network             |
  | `panel-state.mjs`     | an inline-edit draft stays with the selection it was typed for (a new selection never reopens it), and the story-memory panel keeps its expanded/collapsed state across re-renders |

| `seed-cancel.mjs` | a request the reader stopped by navigating away is not reported as a model
failure: no fake "didn't answer" chat turn, no fallback seed over the seed box, no failure toast |

`bash scripts/e2e/dev-up.sh` starts the mock LLM plus a throwaway-profile Chromium on the built
file; `bash scripts/e2e/dev-down.sh` stops both. Rebuild (`pnpm build`) BEFORE `dev-up.sh`, or the
browser will load the previous bundle.

- **Build** — the single-file build must succeed and pass its emit-time safety checks.

## Architecture rules (from [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md))

- `src/core`, `src/llm`, `src/store` never touch the DOM. `core` imports nothing from the others.
- Views are functions of the `AppApi` contract (`src/ui/ctx.ts`) and nothing else; all durable
  mutation goes through `api.update` or the tree mutators.
- LLM output enters the DOM only as text nodes (via `dom.ts`) — never as HTML.
- The single-file contract is load-bearing: `dist/` is generated by the build, committed so the
  single file is ready to open, and never hand-edited; if a change would break the inliner's safety
  checks, the build must fail.
- New structured LLM output goes through `core/parsers.ts` (tolerant parsing) and gets a test.

## Where to add things

| You want to…                          | Touch                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------ |
| Add a local LLM server to discovery   | `src/llm/endpoints.ts` (+ test)                                          |
| Change prompt language or calibration | `src/core/prompt.ts` (+ test)                                            |
| Add a view or screen                  | `src/ui/views/*.ts`, register in `main.ts`                               |
| Change the data model                 | `src/core/types.ts` + `schema.ts` + tests; migrate in `normalizeLibrary` |
| Change the look                       | `src/styles/*.css` (tokens first)                                        |
| Change the shipped-file contract      | `build/*` — update ARCHITECTURE.md §5 too                                |

## Report bugs well

Include: the browser + version, how you opened the app (`file://` or dev server), the LLM server +
model, and the console output. CORS and IndexedDB behavior differ meaningfully between `file://` and
`http://localhost`, so that bit matters.
