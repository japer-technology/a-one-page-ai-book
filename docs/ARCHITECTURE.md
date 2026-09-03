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
│   │   ├── cast.ts         the living cast panel + background bible updater
│   │   ├── story.ts        the rolling summary panel + background memory updater
│   │   ├── shell.ts        header, nav, toast stack
│   │   └── views/          one module per view (library, seed, titles, page,
│   │                       turn, settings, reader, theend, archive)
│   └── styles/           tokens.css · base.css · views.css
├── tests/                vitest: tree, prompt, compile, parsers, schema, endpoints, probe
├── scripts/e2e/          optional browser harness: mock LLM + CDP driver (pnpm test:e2e)
├── docs/                 PRODUCT.md (vision) · ARCHITECTURE.md (this file)
└── .github/              CI (pnpm check + artifact), issue templates
```

**Dependency rule:** `core` depends on nothing but itself; `llm` and `store` depend on `core`; `ui`
depends on all three; `main.ts` wires them. Nothing in `core/llm/store` touches the DOM. This
layering is what makes the 137 unit tests meaningful — the whole domain can be tested without a
browser.

## 3. The domain model: a tree, append-only

Everything the reader ever does is a `StoryNode`:

```
seed ── title A ── page 1 ── turn ── page 2 ── turn ── page 3 (frontier)
   │                                 └──── page 2b  (the road not taken)
   └── title B (proposed, never chosen — remembered)
```

- **Kinds:** `seed` (holds _every_ proposed title), `title`, `page` (holds _every_ version, plus its
  `direction`, an optional `bible` cast snapshot and an optional rolling `summary`), `turn` (holds
  the reader's direction verbatim — including emotion dials and chapter intent), `ending`.
- **Append-only:** regenerating adds a version or a sibling node — it never destroys. "Forking" is
  not a feature, it's emergent: a new child under an old node is a new branch; the old path remains
  addressable. `openPageAt` moves the frontier to any past page: the future stays intact, and the
  next keep grows a sibling branch.
- **The chosen path** is just "walk parents from the frontier". `core/compile.ts` turns it into a
  linear book for reading and export (with the cast as an appendix); `core/tree.ts` computes stats
  over the whole subtree and walks the cast (`bibleUpTo`) and the spine.
- **Standing rules** live on the `Book` — they persist across every branch until removed, and every
  generation prompt carries them verbatim.
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
on 404). Streaming is detected by the response's `content-type`: **SSE** (`text/event-stream`,
`data:`-prefixed lines — LM Studio, llama.cpp, vLLM) vs **NDJSON** (`application/x-ndjson`, bare
JSON per line — Ollama native) vs plain JSON when a server ignores `stream: true`. Both stream
readers drain partial lines across chunk boundaries and salvage a final line without a trailing
newline. Every request carries a hard 120 s timeout (per-request, never a shared slot); HTTP 401/403
errors explain themselves ("add the API key in Settings").

## 7. Prompt engineering: calibrated, not adjectival

`core/prompt.ts` is the product spec's §12.1 made code:

- **One stable system prompt** ("exactly ONE page… output ONLY the page text… end on a deliberate
  beat") shared by every phase.
- **Two-tier memory, budget-first** (~2,600 words): the fixed blocks — seed, title, brief, summary,
  cast, rules — are sized FIRST, and the verbatim recent chosen pages fill whatever remains (with a
  floor). The rolling summary (`page.data.summary`, maintained in the background by `ui/story.ts`
  and injected as `STORY SO FAR (SUMMARY)`) replaces the _oldest_ pages, never the recent ones — so
  a 500-page book's prompt always carries the whole story compactly plus the last pages verbatim.
- **Calibrated direction language:** a tone dial maps to _structural_ instructions ("darker" →
  _withhold information, shorten sentences, imagery, nothing overt_), length maps to word budgets,
  and the ending flag injects an explicit closing-page directive. The mapping tables are data
  (`TONE_GUIDANCE`, `LENGTH_GUIDANCE`, `EMOTION_META`) — tunable without touching logic.
- **Emotion dials (§7.3)** compile the same way: each of the ten dials has a `more`/`less` pair of
  structural instructions, with a magnitude ladder (slightly / clearly / strongly) so "+dread"
  tilts, never jump-cuts. Chapter break/close intents inject explicit structure directives. The
  dominant dial per page becomes the **mood map** (chips in the reader, a line in every export).
- **Precise page sizing** (`sizeTarget`: words / paragraphs / characters) overrides the length
  preset with a numeric target — `sizeTargetInstruction` calibrates it.
- **The pre-writing chat** (`CHAT_SYSTEM_PROMPT`, `chatMessages`) runs in the seed view; a
  distillation pass (`briefMessages`) produces the brief, stored on the seed node and injected as
  `THE BRIEF` into titles and every page/paragraph prompt.
- **Standing rules (§7.2E)** live on the `Book` (`book.rules`) and are injected verbatim into every
  page-generation prompt by `pageMessages` — they persist until removed, exactly as the spec asks.
- **Targeted regeneration (§6)** ships as `paragraphMessages` / `insertParagraphMessages`: one
  paragraph of a page can be rewritten or inserted by the model with the rest of the page as fixed
  context, under a dedicated system prompt that asks for ONLY the paragraph.
- **The living cast (§12.1)** is `bibleMessages`: a structured JSON extraction
  (`{"people":[…] "places":[…] "things":[…] "threads":[…]}`) over the story so far, carrying the
  previous cast forward so it accumulates instead of resets. The snapshot is stored ON the page node
  (`page.data.bible`), so every branch owns its own cast; `bibleUpTo` reads "the cast as of this
  page" (and reports the carrying node, so edits save back to it). Updates run in the background
  after each page — deliberately outside the staleness token, so they can never invalidate in-flight
  page work — and `ui/cast.ts` renders a **fully editable** panel (add / rename / annotate /
  character sheets / delete, plus the open-threads tracker) on the page, turn, reader and archive
  views. `castText` injects the curated names into every generation prompt, so renames stick.
- **Structured phases** (titles, suggested directions, endings) ask for bare JSON; `core/parsers.ts`
  tolerates fences and surrounding prose (`parseBible` is extra-tolerant: a wobbling model can never
  regress the cast to empty). A model that returns garbage is a typed error with a retry button,
  never a stuck screen.

## 8. UI: views as pure functions over a contract

No framework — on purpose. The UI layer is:

- **`dom.ts`:** a ~70-line hyperscript `h()` builder. All content lands as text nodes, so LLM output
  can never inject markup.
- **`ctx.ts`:** the `AppApi` — the only surface a view may touch: live state getters,
  `navigate`/`refresh`/`toast`, the single `update(recipe)` mutation funnel (autosave + re-render in
  one place), generation primitives with **staleness tokens** (any `await` must re-check `staleGen`
  before touching state), and the tree mutators (including `openPageAt` — re-enter any page of the
  past to fork, `saveBible`, `setRules`).
- **`views/*`:** one module per screen, each a function `(api) → HTMLElement`. Transient input state
  lives in session-scoped module maps (survives re-renders, dies with the tab); everything durable
  flows through `api.update`.
- **`genpage.ts`:** the generation ritual — begin token → busy panel → token stream painted into the
  page live → attach to tree → background cast update → re-render — shared by the page and turn
  views.
- **The page is a workshop.** Every paragraph of a kept page is a craftable unit: hover it to
  rewrite (model, streaming into place), edit word by word, insert after, move, or delete — each
  change becomes a new page version (`by: 'user' | 'ai'`), so the version picker and the story map
  remember every draft. Versions flip with ◀▶ (shift+←/→); the story spine walks pages (←/→) and the
  archive view (`views/archive.ts`) shows the whole tree as a **visual SVG graph** — every discarded
  version and every road not taken, clickable to re-enter and fork — plus **side-by-side
  comparison** of any two moments.
- **Parallel candidates** (`generateCandidates`) fan out N page requests at once; the arming logic
  keeps them alive via `parallel: true` and each stream lands in its own panel, attaching as a new
  version. **Write-it-myself** attaches a `by: 'user'` page straight from the turn console.
- **Turn templates** (saved mood recipes) live in settings and apply with one click; the turn also
  proposes **possible endings** (bittersweet / triumphant / twist) when closing the story.
- **EPUB export** (`core/epub.ts`) writes a real EPUB 3 (dependency-free store-only ZIP with CRC-32)
  — title page, one chapter per page, cast appendix, and the mood map.

This is deliberately "framework-shaped without a framework": one-way data flow (state → render), no
direct DOM writes outside a view's own elements, and a contract that keeps the 9 views honest.

Two hard-won rules keep this layer from biting itself:

- **Toasts never re-render.** A toast updates only the toast stack in place. A full re-render would
  detach live form inputs and scan-progress rows mid-interaction (a real bug this caught in the scan
  → "Use" → save flow).
- **Cancellation always marks staleness.** Cancel/navigation increments the generation token, so any
  in-flight `await` wakes up stale, cleans its busy state, and can never leave a stuck panel.
- **The open-book pointer is re-synced on every mutation.** Tree mutations replace the `Book` object
  inside `lib.books` (new frontier, status, …); `update()` re-derives the session's open book from
  the library, so no view ever renders against a stale frontier — the classic "it generated but the
  screen didn't change" bug.
- **`window.__PAGE_TURN__`** is a debug handle: live view/params/book/model, the generation counter,
  a render counter (asserted by the e2e to catch render loops), the generation state keys, and a
  rolling **audit trail** (`audit()` — navigations, begin/abort, page attach) for diagnosing exactly
  this kind of failure from the devtools console or the e2e driver.

## 9. Testing & quality gates

- **Vitest** covers everything that doesn't need a browser: tree graph ops (paths, versions, forks,
  clones), prompt assembly (calibration tables, budgets, ending directives), compilation/export,
  tolerant parsers, schema validation, and the endpoint catalog — plus every diagnosis path of the
  probe (reachable, reachable-without-models, non-OK response, CORS-blocked, absent, parallel
  discovery) with a stubbed `fetch`.
- **Optional end-to-end harness** (`pnpm test:e2e`, requires `chromium` in PATH): TWO mock servers
  (OpenAI-compatible SSE on :1234, Ollama-native NDJSON on :11434) plus the real built file in
  headless Chromium, driven over CDP — the full user journey: boot → `#/settings` → Scan → Use →
  Save → Test connection → New book → seed → titles → **page 1 streams via SSE** → keep → turn →
  switch endpoint to Ollama → **page 2 streams via NDJSON** → LAN scan finds the loopback server.
  This is the check that catches browser-only regressions (CORS, streaming dialects, the
  stale-frontier bug, boot hangs).
- **TypeScript strict** with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`; **ESLint**
  (typescript-eslint recommended) + **Prettier**; **CI** runs `pnpm check` (typecheck → lint →
  format → test → build) on every push and PR, and publishes the built single file as an artifact.
- The contract nobody can see: `build.mjs`'s emit-time checks (single `</script>`, zero external
  refs by construction).

## 10. What ships now vs. what's deliberately deferred (mapped to the spec)

The app implements the spec's soul — one page at a time, generate until it's good, the page turn
takes the wheel, everything remembered — plus the V2 layer: the living cast, emotion dials, standing
rules, targeted paragraph regeneration, the story map, and read-aloud. What remains deferred, with
its natural landing spot:

| Spec feature (§ in docs/PRODUCT.md)   | Status                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Living cast, curated (CRUD) + threads | ✅ `page.data.bible` + `bibleMessages` + editable `ui/cast.ts`                                                                       |
| Rolling story summary (§12.1)         | ✅ `page.data.summary` + background updater in `ui/story.ts` + `summaryText` injected into every prompt; budget = fixed blocks first |
| Re-enter from any title (§5)          | ✅ `branchTip` + `openBranch`: every proposed title is an enterable doorway (story map)                                              |
| Character sheets (§12.1)              | ✅ `details` on cast people, injected as canon                                                                                       |
| Emotion dials (§7.3)                  | ✅ `EMOTION_META` + `emotions` on `TurnInput` + dial UI                                                                              |
| Mood map (§7.3, §16)                  | ✅ reader chips + export line; ⏳ printed margin sparkline                                                                           |
| Precise page size (§7.2B)             | ✅ `sizeTarget` in words / paragraphs / characters                                                                                   |
| Story map / visual tree (§8.4)        | ✅ `ui/views/archive.ts`: SVG graph + timeline + compare                                                                             |
| Branch comparison (§8.3)              | ✅ pick any two moments, side by side                                                                                                |
| Standing rules vs one-shot (§7.2E)    | ✅ `book.rules`, injected by `pageMessages`                                                                                          |
| Targeted paragraph regeneration (§6)  | ✅ `paragraphMessages` + per-paragraph craft UI                                                                                      |
| Chapter break / chapter close (§7.2B) | ✅ `chapter` intent on `TurnInput`                                                                                                   |
| Pre-writing chat (§4)                 | ✅ seed-view chat + distilled brief, injected everywhere                                                                             |
| Write-it-myself pages (§7)            | ✅ `by: 'user'` pages straight from the turn                                                                                         |
| Parallel candidate pages (§12.2, §19) | ✅ `generateCandidates` fan-out, keep the one you love                                                                               |
| Proposed endings gallery (§9)         | ✅ bittersweet / triumphant / twist at the closing turn                                                                              |
| Turn templates (§7.4)                 | ✅ saved mood recipes in settings                                                                                                    |
| EPUB export (§9)                      | ✅ `core/epub.ts`, dependency-free EPUB 3                                                                                            |
| Read-aloud (§11)                      | ✅ reader view, browser speech synthesis                                                                                             |
| Illustrations, sharing, co-authoring  | ⏳ new modules behind the same AppApi                                                                                                |

## 11. Conventions

- Commits: [Conventional Commits](https://www.conventionalcommits.org/). See
  [CONTRIBUTING.md](../CONTRIBUTING.md).
- New pure logic ⇒ new test. New view ⇒ keep it a function of `AppApi` and nothing else.
- Any change that must appear in the shipped file goes through `pnpm build`; `dist/` is never edited
  by hand (and never committed — CI publishes it).
- The single-file contract is load-bearing: if a change breaks it, the build must fail, not silently
  ship.
