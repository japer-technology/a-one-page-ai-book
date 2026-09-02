# 📖 Page Turn — The One-Page AI Book

**A generative, interactive reading machine where the reader is the director, the page turn is a
creative decision, and every choice is remembered forever.**

You write one sentence — a seed. A **local LLM** (LM Studio, Ollama, llama.cpp, and friends) writes
the book with you, **one page at a time**. You direct every page turn. Every title, every page,
every version, every decision is remembered as a **branchable tree** — and the whole app ships as
**one self-contained HTML file** that runs straight from `file://`, reads and writes real local
files, and never talks to a cloud.

> The full product vision: [docs/PRODUCT.md](docs/PRODUCT.md) · The engineering deep-dive:
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

[![CI](https://github.com/thefederation/a-one-page-ai-book/actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## What it does

- **🔍 Finds your local LLM.** One click probes the well-known local inference ports (LM Studio,
  Ollama, llama.cpp, KoboldCpp, text-generation-webui, GPT4All, vLLM, LocalAI, Jan, AnythingLLM,
  Msty) and reports _reachable with models_, _CORS-blocked_, or _not found_ — with actionable
  guidance.
- **✍️ The core loop.** Seed → 5 proposed titles → page 1 → _the page turn_ → next page → … until
  you say _The End_. Titles and endings iterate like pages.
- **🎛️ The page turn is the product.** Direction, page length, tone dials (calibrated into
  structural instructions, not adjectives), and "bring the story to a close" — or just _Continue
  naturally_: zero inputs is still a decision.
- **🌳 Everything is remembered.** Immutable-ish tree: every discarded version, every fork, every
  turn decision. Regenerating an old page forks a new branch; the old path is untouched.
- **💾 Real local files.** The library lives in IndexedDB and is mirrored to an OPFS workspace file;
  portable `.ptlibrary.json` / `.ptbook.json` import-export via the File System Access API (with
  download/upload fallbacks); compiled books export as `.txt` or `.md`.
- **📕 The library.** A bookshelf of spines; re-enter any book at its frontier, read the compiled
  path, duplicate, search, delete.

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

| Command          | What it does                                                   |
| ---------------- | -------------------------------------------------------------- |
| `pnpm dev`       | Dev server with watch rebuild (real ESM modules, sourcemaps)   |
| `pnpm build`     | Bundle + inline → `dist/page-turn.html` (+ `index.html`)       |
| `pnpm preview`   | Static server for the built single file                        |
| `pnpm test`      | Unit tests (vitest) over the pure domain layer                 |
| `pnpm typecheck` | `tsc --noEmit` in strict mode (`noUncheckedIndexedAccess`)     |
| `pnpm lint`      | ESLint (typescript-eslint)                                     |
| `pnpm fmt`       | Prettier                                                       |
| `pnpm check`     | typecheck + lint + format check + tests + build — what CI runs |

## How it works, briefly

```
src/core     pure domain: the story tree, prompt assembly, compile/export, schema
src/llm      endpoint catalog, port probing/discovery, chat client (OpenAI-compat + Ollama)
src/store    IndexedDB database, File System Access + OPFS + download fallbacks
src/ui       hyperscript DOM layer, shell, and one module per view
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
├── docs/             PRODUCT.md (vision) · ARCHITECTURE.md (engineering)
├── dist/             build output (gitignored; CI publishes the artifact)
└── .github/          CI workflow + issue templates
```

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for conventions (conventional
commits, tests required, `pnpm check` green before merge). Bugs and feature ideas go in
[GitHub issues](../../issues).

## License

[MIT](LICENSE)
