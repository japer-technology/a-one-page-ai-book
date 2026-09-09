# 📖 Page Turn — The One-Page AI Book

**A generative, interactive reading machine where the reader is the director, the page turn is a
creative decision, and every choice is remembered forever.**

You write one sentence — a seed. A **local LLM** (LM Studio, Ollama, llama.cpp, and friends) writes
the book with you, **one page at a time**. You direct every page turn. Every title, every page,
every version, every decision is remembered as a **branchable tree** — and the whole app ships as
**one self-contained HTML file** that runs straight from `file://`, reads and writes real local
files, and never talks to a cloud.

> The full product vision: [docs/PRODUCT.md](docs/PRODUCT.md) · The engineering deep-dive:
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · The author's guide (every control, every best
> practice): [docs/AUTHORING.md](docs/AUTHORING.md)

[![CI](https://github.com/thefederation/a-one-page-ai-book/actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## What it does

- **🔍 Finds your local LLM.** One click probes the well-known local inference ports (LM Studio,
  Ollama, llama.cpp, KoboldCpp, text-generation-webui, GPT4All, vLLM, Jan, AnythingLLM, Msty) and
  reports _reachable with models_, _CORS-blocked_, or _not found_ — with actionable guidance.
- **🌐 Scans the local network.** Probes every address in your subnet (`192.168.1.1–254`) on the
  standard LLM ports, identifies what answers (with model lists), and adopts a nearby machine's
  server in one click. Auto-detects your subnet where the browser allows it; manual entry +
  common-subnet chips otherwise.
- **⌨️ Manual entry is first-class.** Any base URL and port (e.g. `http://192.168.1.50:1234`),
  either protocol (OpenAI-compatible or Ollama native), any model name, optional **API key** (sent
  as a bearer token only to that endpoint), a one-off "Probe this URL", and preset port hints.
- **💬 Talk it through first.** Before the seed, chat with the model about the book you want
  (protagonist, setting, mood, don'ts), then distill the conversation into a **brief** that steers
  the titles and every page afterwards.
- **✍️ The core loop.** Seed → 5 proposed titles → page 1 → _the page turn_ → next page → … until
  you say _The End_. Titles and endings iterate like pages.
- **🎛️ The page turn is the product.** Direction, page length — presets **or a precise target in
  words, paragraphs, or characters** — tone dials, ten **emotion dials** (calibrated into structural
  instructions, not adjectives), chapter breaks, **standing rules** ("don't touch" constraints that
  persist until removed), AI-proposed next beats you can step through back and forth, a
  **proposed-endings gallery**, saved **turn templates**, and **"✍️ I'll write it myself"** for full
  control — or just _Continue naturally_: zero inputs is still a decision.
- **🔧 Every page is a workshop.** Hover any paragraph to **rewrite it with the model** (streaming
  into place), edit it **word by word**, insert, move, or delete paragraphs — every change becomes a
  remembered version, and you flip back and forth through versions (and pages) with a key press.
- **📇 The living cast.** A people · places · things panel that follows the story — quietly updated
  by the model after every page (or on demand), stored per branch, viewable at the page, the turn,
  in the reader and on the story map.
- **🌳 Everything is remembered.** Immutable-ish tree: every discarded version, every fork, every
  turn decision. Regenerating an old page forks a new branch; the old path is untouched.
- **🗺️ The story map.** The whole tree as a timeline: the chosen spine, every version of every page,
  every road not taken — ghosted but clickable, to re-enter and fork from any moment.
- **🔊 Read-aloud.** The reader reads one page at a time, aloud, with the browser's on-device voice
  — the one-page rhythm becomes a bedtime story.
- **💾 Real local files.** The library lives in IndexedDB and is mirrored to an OPFS workspace file;
  portable `.ptlibrary.json` / `.ptbook.json` import-export via the File System Access API (with
  download/upload fallbacks); compiled books export as **real EPUB e-books** (plus `.txt` / `.md`,
  cast appendix and mood map included).
- **📊 About this book.** The full creative ledger: words kept vs. generated vs. written by hand,
  versions, branch points, the decision log, models used, and the mood map.
- **▶ Time-lapse replay.** Watch the story map relive the chosen path, page by page.
- **➡️ Sequels.** A finished book seeds its sequel with the cast and open threads riding along as
  the brief.
- **🎨 Reading themes.** Dark candlelight, sepia, or light — plus a text-size scale — from Settings.
  A **fast model** can be assigned to the cheap phases (titles, chat, cast, beats) while the main
  model writes the pages.
- **📕 The library.** A bookshelf of spines; re-enter any book at its frontier, read the compiled
  path, open the story map, duplicate, search, delete — and a friendly three-step tour greets the
  empty shelf.

## Quick start

```bash
# prerequisites: Node ≥ 20 and pnpm (corepack enable)

pnpm install        # install dev tooling (esbuild, typescript, vitest, eslint, prettier)
pnpm dev            # hot-reloading dev server → http://localhost:4173
pnpm build          # merge everything into ONE file → dist/page-turn.html
pnpm preview        # serve the built single file at http://localhost:4174
```

Then open `dist/page-turn.html` directly from disk — no server, no network, no build step needed at
runtime. Open **Settings → Scan for local LLMs**, pick a model, and write your seed.

### Scripts

| Command          | What it does                                                              |
| ---------------- | ------------------------------------------------------------------------- |
| `pnpm dev`       | Dev server with watch rebuild (real ESM modules, sourcemaps)              |
| `pnpm build`     | Bundle + inline → `dist/page-turn.html` (+ `index.html`)                  |
| `pnpm preview`   | Static server for the built single file                                   |
| `pnpm test`      | Unit tests (vitest) over the pure domain layer                            |
| `pnpm test:e2e`  | Browser end-to-end check (needs `chromium`): scan → use → save → generate |
| `pnpm typecheck` | `tsc --noEmit` in strict mode (`noUncheckedIndexedAccess`)                |
| `pnpm lint`      | ESLint (typescript-eslint)                                                |
| `pnpm fmt`       | Prettier                                                                  |
| `pnpm check`     | typecheck + lint + format check + tests + build — what CI runs            |

## How it works, briefly

```
src/core     pure domain: the story tree, prompt assembly, compile/export, schema
src/llm      endpoint catalog, port probing/discovery, chat client (OpenAI-compat + Ollama)
src/store    IndexedDB database, File System Access + OPFS + download fallbacks
src/ui       hyperscript DOM layer, shell, living cast, and one module per view
build/       the inliner: esbuild bundles JS+CSS → one HTML file (no runtime deps)
tests/       vitest over everything that doesn't need a browser
```

The build (`build/build.mjs`) compiles the whole TypeScript tree to a single IIFE and the whole
stylesheet tree to one CSS blob, inlines both into `build/template.html`, and **refuses to emit** if
anything would break the single-file guarantee (e.g. a stray `</script>`). The shipped file makes
zero external requests.

## Data ownership

Your books are yours. Everything lives on your disk (browser profile: IndexedDB + OPFS file), can be
exported as JSON at any time, and the only place your words ever travel is the local LLM endpoint
**you** configure. No telemetry, no cloud, no account. See [SECURITY.md](SECURITY.md).

## Repository layout

```
.
├── build/            build pipeline (esbuild inliner + dev server)
├── src/              application source (core / llm / store / ui / styles)
├── tests/            unit tests
├── docs/             PRODUCT.md (vision) · ARCHITECTURE.md (engineering) · AUTHORING.md (the author's guide)
├── dist/             build output (gitignored; CI publishes the artifact)
└── .github/          CI workflow + issue templates
```

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for conventions (conventional
commits, tests required, `pnpm check` green before merge). Bugs and feature ideas go in
[GitHub issues](../../issues).

## License

[MIT](LICENSE)
