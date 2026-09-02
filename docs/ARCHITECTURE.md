# Architecture — Page Turn

How a "hugely complex" application becomes **one self-contained HTML file** without ever being
written as one.

## 1. The single-file philosophy

The product constraint is hard: the app must be **one HTML file** — copyable, openable from
`file://`, shareable, with **zero external requests** (no CDN, no fonts, no fetches at boot) and
**zero runtime dependencies**. The engineering reality is the opposite: this is a stateful,
multi-view, multi-protocol application (graph model, LLM dialects, three storage mechanisms,
streaming UI) that would be unmaintainable as a single source file.

The resolution, and the central architectural idea:

> **Author in many small, strict, tested modules; ship as one file via a deterministic build.**

The build is not a convenience — it is a correctness mechanism. `build/build.mjs` **refuses to
emit** a file that violates the single-file contract (see §5).

## 2. Repository layout

```
.
├── build/
│   ├── template.html     the 40-line shell: {{__CSS__}} / {{__JS__}} placeholders
│   ├── dev.html          dev-mode shell (loads real ESM modules + sourcemaps)
│   ├── build.mjs         the inliner (esbuild JS+CSS → one dist/page-turn.html)
│   └── serve.mjs         dev server (watch/rebuild) and --preview static server
├── src/
│   ├── main.ts           orchestrator: state, routing, autosave, the AppApi
│   ├── app.css           stylesheet root (@imports inlined at build time)
│   ├── core/             pure domain — no DOM, no I/O, fully unit-tested
│   │   ├── types.ts        the domain model (nodes, books, library, settings)
│   │   ├── tree.ts         graph ops: paths, forks, versions, clone, stats
│   │   ├── prompt.ts       prompt assembly + calibrated tone/length language
│   │   ├── compile.ts      chosen path → linear book → txt/md export
│   │   ├── parsers.ts      tolerant JSON/string-list extraction from LLM output
│   │   └── schema.ts       defaults, validation, import normalization
│   ├── llm/              local-LLM layer
│   │   ├── endpoints.ts    catalog of known servers + model-list parsers
│   │   ├── probe.ts        discovery: CORS fetch → no-cors presence fallback
│   │   └── client.ts       chat: OpenAI-compatible + Ollama native, SSE streaming
│   ├── store/            local-file layer
│   │   ├── db.ts           IndexedDB: the whole library is ONE JSON document
│   │   └── files.ts        FS Access pickers, OPFS workspace, download/upload
│   ├── ui/               rendering layer
│   │   ├── dom.ts          hyperscript h() — no framework, text-safe by default
│   │   ├── ctx.ts          the AppApi contract every view programs against
│   │   ├── genpage.ts      the generation ritual: token → stream → attach
│   │   ├── shell.ts        header, nav, toast stack
│   │   └── views/          one module per view (library, seed, titles, page,
│   │                       turn, settings, reader, theend)
│   └── styles/           tokens.css · base.css · views.css
├── tests/                vitest: tree, prompt, compile, parsers, schema, endpoints, probe
├── scripts/e2e/          optional browser harness: mock LLM + CDP driver (pnpm test:e2e)
├── docs/                 PRODUCT.md (vision) · ARCHITECTURE.md (this file)
└── .github/              CI (pnpm check + artifact), issue templates
```

**Dependency rule:** `core` depends on nothing but itself; `llm` and `store` depend on `core`; `ui`
depends on all three; `main.ts` wires them. Nothing in `core/llm/store` touches the DOM. This
layering is what makes the 49 unit tests meaningful — the whole domain can be tested without a
browser.

## 3. The domain model: a tree, append-only

Everything the reader ever does is a `StoryNode`:

```
seed ── title A ── page 1 ── turn ── page 2 ── turn ── page 3 (frontier)
   │                                 └──── page 2b  (the road not taken)
   └── title B (proposed, never chosen — remembered)
```

- **Kinds:** `seed` (holds _every_ proposed title), `title`, `page` (holds _every_ version), `turn`
  (holds the reader's direction verbatim), `ending`.
- **Append-only:** regenerating adds a version or a sibling node — it never destroys. "Forking" is
  not a feature, it's emergent: a new child under an old node is a new branch; the old path remains
  addressable.
- **The chosen path** is just "walk parents from the frontier". `core/compile.ts` turns it into a
  linear book for reading and export; `core/tree.ts` computes stats over the whole subtree.
- **Every node is metadata-rich** (direction, model, timestamps, authorship) — the model-agnostic
  promise of the product spec falls out of the data model: the model is recorded per page, never
  assumed globally.

## 4. Storage: three mechanisms, one document

The entire library — books, nodes, settings — serializes to **one JSON document** (`core/schema.ts`
validates any shape on import). This one decision makes every storage mechanism trivial:

| Mechanism                                     | Role                                                                                         | When                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------- |
| **IndexedDB**                                 | The always-on home. Debounced autosave (300 ms) + flush on hide.                             | Every mutation, everywhere         |
| **OPFS** (`navigator.storage.getDirectory()`) | A real workspace file (`library.json`), no prompts                                           | Mirror of IndexedDB; boot fallback |
| **File System Access API**                    | True open/save dialogs for portable files (`.ptlibrary.json`, `.ptbook.json`, `.txt`, `.md`) | Import/export                      |
| **`<input type=file>` + `<a download>`**      | Graceful fallback where pickers don't exist                                                  | Import/export fallback             |

File formats: `.ptlibrary.json` (whole library), `.ptbook.json` (one book + its subtree,
`format: "page-turn-book"`), compiled `.txt`/`.md`. Import accepts all of them and validates hard —
a corrupt file is an error message, never a crash.

**Boot can never hang on storage.** IndexedDB/OPFS reads are raced against a 1.5 s grace period — if
a browser profile refuses storage (private browsing, quirky `file://` environments), the app still
boots with a fresh in-memory library. Persistence is best-effort by design; rendering is not.

## 5. The build: many files → one file

`build/build.mjs` is the single-file guarantee, in four steps:

1. **esbuild** bundles `src/main.ts` → one minified IIFE (all `import`/`export` erased) and
   `src/app.css` → one CSS blob (`@import`s inlined).
2. A build banner (`window.__BUILD__ = { version, commit, builtAt }`) is appended.
3. Both artifacts are inlined into `build/template.html` at the `{{__CSS__}}` / `{{__JS__}}`
   placeholders.
4. **Emit-time safety checks:** the inliner counts `</script>` occurrences (must be exactly the
   host's one — esbuild escapes the rest) and fails the build rather than ship a corrupt file.

Result: `dist/page-turn.html` — ~70 kB, works from `file://`, zero network calls at boot.
`dist/index.html` is a convenience copy.

**Dev mode** (`build/serve.mjs`) serves the same sources as real ESM with sourcemaps and
watch-rebuilds — so the developer's fast loop and the shipped artifact are literally the same code.
One caveat: the dev page runs on `http://localhost:4173`, which also happens to satisfy the CORS
allow-lists of most local LLM servers — useful when debugging a `file://` CORS refusal.

## 6. Finding the local LLM

Discovery (`llm/probe.ts`) works within a browser's hard CORS reality:

1. **CORS fetch** `GET {base}/v1/models` (and Ollama's native `GET /api/tags`) with a short timeout,
   per candidate in the catalog (`llm/endpoints.ts`). Candidates are probed with **bounded
   parallelism (4 workers)** so a full scan finishes in seconds, not a minute.
2. **A response that resolves is a clean signal** — any HTTP status proves the server is reachable
   AND CORS works (browsers throw `TypeError` for both connection failures and missing CORS
   headers). A 404 on the model list is reported as "reachable, server answered HTTP 404" — not
   misdiagnosed as a CORS problem.
3. Only after pure `TypeError`s does a **`no-cors` fetch** distinguish "nothing is listening" from
   "a server answered but refused this page's origin" — reported as `cors-blocked` with actionable
   fixes (enable CORS for localhost origins, or run from a localhost URL).
4. `reachable` endpoints contribute their model lists to the settings picker. **Manual entry is
   first-class**: any base URL (host + port + optional path prefix, `/v1` optional), either
   protocol, any model name, an optional **API key** (sent as `Authorization: Bearer …` only to that
   endpoint), a one-off **"Probe this URL"** for LAN addresses the catalog doesn't know
   (`http://192.168.1.50:1234`), and preset port hints from the catalog.
5. **LAN scanning** (`llm/lan.ts`): browsers can't enumerate a network (no raw sockets/ARP/ICMP), so
   "scanning" means probing the grid {subnet base} × {`.1`–`.254`} × {catalog ports} with a
   `no-cors` GET (any HTTP answer = a responder), then identifying responders with the standard CORS
   model-list probe. Per host the scan stops at the first responder; 16 parallel workers and a 600
   ms per-probe timeout keep a full /24 to seconds, with live progress and cancel. The subnet
   auto-detects via WebRTC ICE where the browser allows it (Chrome mDNS-obfuscates, so manual
   entry + common-subnet chips are the reliable path), and identified servers feed the same "Use"
   flow as localhost discoveries (vendor guessed by port: 11434 → Ollama).

Generation (`llm/client.ts`) speaks two dialects behind one interface — **OpenAI-compatible**
(`POST /v1/chat/completions`) and **Ollama native** (`POST /api/chat`, with automatic `/v1` fallback
on 404) — and streams both via server-sent events so pages write themselves onto the screen.
Streaming is detected by the response's `content-type`, so a server that ignores `stream: true`
degrades to a plain JSON read instead of failing. Every request carries a hard 120 s timeout; HTTP
401/403 errors explain themselves ("add the API key in Settings").

## 7. Prompt engineering: calibrated, not adjectival

`core/prompt.ts` is the product spec's §12.1 made code:

- **One stable system prompt** ("exactly ONE page… output ONLY the page text… end on a deliberate
  beat") shared by every phase.
- **A context budget** (~2,600 words): seed + title + as many recent chosen pages as fit. The
  full-text budget is the MVP stand-in for the rolling summary/character bible of the spec (see
  §10).
- **Calibrated direction language:** a tone dial maps to _structural_ instructions ("darker" →
  _withhold information, shorten sentences, imagery, nothing overt_), length maps to word budgets,
  and the ending flag injects an explicit closing-page directive. The mapping table is data
  (`TONE_GUIDANCE`, `LENGTH_GUIDANCE`) — tunable without touching logic.
- **Structured phases** (titles, suggested directions) ask for bare JSON; `core/parsers.ts`
  tolerates fences and surrounding prose. A model that returns garbage is a typed error with a retry
  button, never a stuck screen.

## 8. UI: views as pure functions over a contract

No framework — on purpose. The UI layer is:

- **`dom.ts`:** a ~70-line hyperscript `h()` builder. All content lands as text nodes, so LLM output
  can never inject markup.
- **`ctx.ts`:** the `AppApi` — the only surface a view may touch: live state getters,
  `navigate`/`refresh`/`toast`, the single `update(recipe)` mutation funnel (autosave + re-render in
  one place), generation primitives with **staleness tokens** (any `await` must re-check `staleGen`
  before touching state), and the tree mutators.
- **`views/*`:** one module per screen, each a function `(api) → HTMLElement`. Transient input state
  lives in session-scoped module maps (survives re-renders, dies with the tab); everything durable
  flows through `api.update`.
- **`genpage.ts`:** the generation ritual — begin token → busy panel → token stream painted into the
  page live → attach to tree → re-render — shared by the page and turn views.

This is deliberately "framework-shaped without a framework": one-way data flow (state → render), no
direct DOM writes outside a view's own elements, and a contract that keeps the 8 views honest.

Two hard-won rules keep this layer from biting itself:

- **Toasts never re-render.** A toast updates only the toast stack in place. A full re-render would
  detach live form inputs and scan-progress rows mid-interaction (a real bug this caught in the scan
  → "Use" → save flow).
- **Cancellation always marks staleness.** Cancel/navigation increments the generation token, so any
  in-flight `await` wakes up stale, cleans its busy state, and can never leave a stuck panel.

## 9. Testing & quality gates

- **Vitest** covers everything that doesn't need a browser: tree graph ops (paths, versions, forks,
  clones), prompt assembly (calibration tables, budgets, ending directives), compilation/export,
  tolerant parsers, schema validation, and the endpoint catalog — plus every diagnosis path of the
  probe (reachable, reachable-without-models, non-OK response, CORS-blocked, absent, parallel
  discovery) with a stubbed `fetch`.
- **Optional end-to-end harness** (`pnpm test:e2e`, requires `chromium` in PATH): a mock
  OpenAI-compatible server on :1234 plus the real built file in headless Chromium, driven over CDP —
  boot → `#/settings` → Scan → reachable row with models → Use → Save → Test connection → a real
  generation round-trip. This is the check that catches browser-only regressions (CORS, the datalist
  attribute crash, boot hangs).
- **TypeScript strict** with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`; **ESLint**
  (typescript-eslint recommended) + **Prettier**; **CI** runs `pnpm check` (typecheck → lint →
  format → test → build) on every push and PR, and publishes the built single file as an artifact.
- The contract nobody can see: `build.mjs`'s emit-time checks (single `</script>`, zero external
  refs by construction).

## 10. What's deliberately deferred (mapped to the spec)

The MVP implements the spec's soul — one page at a time, generate until it's good, the page turn
takes the wheel, everything remembered. Deliberately deferred, with their natural landing spots:

| Spec feature (§ in docs/PRODUCT.md)                     | Where it lands                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------- |
| Rolling story bible / character tracking (§12.1)        | `core/prompt.ts` — swap the fixed page window for a maintained summary node |
| Suggested directions already ship; emotion dials (§7.3) | extend `TONE_GUIDANCE`-style tables + a dials array on `TurnInput`          |
| Tree/archive visual view (§8.4)                         | a new `ui/views/archive.ts` over `collectSubtree`                           |
| Standing rules vs one-shot (§7.2E)                      | new node kind `rule`, injected by `pageMessages`                            |
| Streaming already ships; parallel candidates (§12.2)    | `genpage.ts` fan-out; picker UI                                             |
| Illustrations, read-aloud, sharing (§13, §11)           | new modules behind the same AppApi                                          |

## 11. Conventions

- Commits: [Conventional Commits](https://www.conventionalcommits.org/). See
  [CONTRIBUTING.md](../CONTRIBUTING.md).
- New pure logic ⇒ new test. New view ⇒ keep it a function of `AppApi` and nothing else.
- Any change that must appear in the shipped file goes through `pnpm build`; `dist/` is never edited
  by hand (and never committed — CI publishes it).
- The single-file contract is load-bearing: if a change breaks it, the build must fail, not silently
  ship.
