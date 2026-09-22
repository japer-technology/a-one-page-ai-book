# New Features — the living backlog

Every feature this product could grow into, brainstormed against the vision in
[PRODUCT.md](PRODUCT.md), the engineering reality in [ARCHITECTURE.md](ARCHITECTURE.md), and the
single-file, local-first, zero-network promise.

**Legend**

| Mark | Meaning                                                                     |
| ---- | --------------------------------------------------------------------------- |
| ✅   | Ships today                                                                 |
| 🔜   | Recommended next (pure client, high feel-per-dollar)                        |
| 💡   | Candidate (pure client, needs design or model help)                         |
| 🧪   | Experimental (works only with capable local models, or quality varies)      |
| ⛔   | Excluded by the product's own constraints (server, cloud, external service) |
| 🎨   | Content feature — the model writes it; the app only presents it             |

Effort: **S** small (hours) · **M** medium (a day) · **L** large (days).

---

## 1. Crafting & page generation

| Feature                           | What it does                                                                                              | Status | Effort |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- | ------ | ------ |
| Paragraph-level crafting          | Rewrite / edit / insert / move / delete any paragraph; every change a remembered version                  | ✅     | —      |
| Word & span control               | Select any span and rewrite or edit exactly it                                                            | ✅     | —      |
| Parallel candidate pages          | Generate 2+ alternatives at once, keep your favorite                                                      | ✅     | —      |
| Precise page sizing               | Word / paragraph / character targets per turn                                                             | ✅     | —      |
| Pin versions                      | Favorites sort first and are never lost                                                                   | ✅     | —      |
| Undo (one step)                   | Step back to the previous version after any craft commit                                                  | ✅     | —      |
| Version diff                      | Word-level red/green between two drafts                                                                   | ✅     | —      |
| Diegetic document pages           | Letter, diary, newspaper, map notes, recipe — typeset as one                                              | ✅     | —      |
| Editable chapter headings         | Rename the AI's chapter titles in place                                                                   | ✅     | —      |
| Deep undo/redo history            | Full undo stack across versions and pages (versions are already the safety net; this is navigation sugar) | 💡     | M      |
| Nudge presets                     | One-tap micro-directions: "end on dialogue", "add sensory detail", "show, don't tell"                     | 🔜     | S      |
| Prose style dials                 | Sentence-length, adverb/passive reduction, dialogue-attribution style                                     | 💡     | M      |
| "More/less like this" on the page | Steering sliders without leaving the page                                                                 | 💡     | M      |
| Diff-merge tool                   | Splice the best sentences from two versions into one                                                      | 💡     | L      |
| Retry with variation              | Re-roll only the failing part, temperature bump per retry                                                 | 💡     | S      |
| Sentence shuffle                  | Reorder sentences within a paragraph for rhythm                                                           | 🎨     | M      |
| Translation pass                  | "Write this page again in <language>" for bilingual books                                                 | 🧪     | S      |
| Auto-trim pass                    | Post-generation polish: cut repetition, fix tense slips                                                   | 🧪     | M      |
| Scene headings                    | Screenplay-style "INT. LIGHTHOUSE — NIGHT" beats within pages                                             | 💡     | S      |
| Highlight-rewrite                 | Highlight text → rewrite ONLY the highlighted bit (already ships as span rewrite; this adds multi-span)   | 💡     | S      |
| Pin whole paragraphs              | Lock a paragraph so regenerations never touch it                                                          | 🔜     | S      |
| Page locking                      | Freeze a finished page against accidental edits                                                           | 💡     | S      |
| Negative prompt field             | Dedicated "avoid this" box at the turn (today it rides in free text / standing rules)                     | 💡     | S      |

## 2. The turn console & direction

| Feature                                                 | What it does                                                                      | Status | Effort |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- | ------ | ------ |
| Free-text direction + suggested beats (step back/forth) | —                                                                                 | ✅     | —      |
| Emotion dials, calibrated                               | 10 dials, magnitude ladder, structural language                                   | ✅     | —      |
| Standing rules vs one-shot                              | —                                                                                 | ✅     | —      |
| Chapter break / close / end / endings gallery           | —                                                                                 | ✅     | —      |
| Write-it-myself pages                                   | —                                                                                 | ✅     | —      |
| Turn templates                                          | Save & reuse console setups                                                       | ✅     | —      |
| Precise size targets                                    | —                                                                                 | ✅     | —      |
| Page format (diegetic)                                  | —                                                                                 | ✅     | —      |
| Valence + arousal dials                                 | The affect-circumplex pair: overall positive↔negative, calm↔intense               | 💡     | S      |
| "Sudden shift" toggle                                   | Jump-cut the tone instead of tilting (jump-scare mode)                            | 💡     | S      |
| Pace dial                                               | Slow/meditative ↔ propulsive as a first-class control                             | 🔜     | S      |
| Cliffhanger ↔ resting-point toggle                      | End the page on a hook or a breath                                                | 🔜     | S      |
| Time-jump control                                       | Skip hours/days/years; AI keeps continuity                                        | 💡     | S      |
| Parallel-scene control                                  | "Cut to what's happening elsewhere"                                               | 💡     | S      |
| Introduce / remove / focus character pickers            | Dropdowns from the cast instead of free text                                      | 🔜     | M      |
| Reveal / conceal dial                                   | Information control as a slider                                                   | 💡     | S      |
| 🎲 Surprise me                                          | Fills the console with a bold random combination                                  | 💡     | S      |
| Story-arc planner                                       | Sketch a 3–5 act map; the turn console shows where you are in the arc             | 💡     | L      |
| Beat preview                                            | Before generating, the model previews the next beat in one line; approve or steer | 🧪     | M      |
| Chapter-title gallery                                   | Propose 3 chapter titles when starting a chapter (like book titles)               | 🔜     | S      |
| Auto chapter breaks                                     | "Break into chapters every ~N pages"                                              | 💡     | S      |
| Kids mode                                               | Emoji mood buttons + picture prompts instead of sliders                           | 💡     | L      |
| Voice-directed turns                                    | Speak the direction aloud (Web Speech API)                                        | 💡     | M      |

## 3. Cast, world & continuity

| Feature                                                        | What it does                                                                | Status | Effort |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- | ------ | ------ |
| Living cast (people · places · things · threads), auto-updated | —                                                                           | ✅     | —      |
| Cast CRUD: add / rename / annotate / delete                    | —                                                                           | ✅     | —      |
| Character sheets (details field)                               | —                                                                           | ✅     | —      |
| Cast injected into every generation (renames stick)            | —                                                                           | ✅     | —      |
| Relationship graph                                             | Who knows/loves/hates whom — visual map, consulted by the model             | 🔜     | L      |
| Timeline of events                                             | "What happened when" ledger per branch                                      | 💡     | M      |
| Faction & place hierarchy                                      | Nested places, groups, families, organizations                              | 💡     | M      |
| Cast aliases                                                   | "Also known as" — track renames across branches so old text still maps      | 💡     | S      |
| Cast merge                                                     | Dedupe near-duplicate entries the model invents                             | 💡     | S      |
| Conflict detector                                              | "This direction contradicts page 7" heads-up at the turn                    | 🧪     | M      |
| Consistency check button                                       | Ask the model to flag name/fact/tone contradictions in the chosen path      | 🧪     | M      |
| Cast import/export                                             | Reuse a world bible across books (JSON)                                     | 🔜     | S      |
| Per-character voice                                            | Assign a TTS voice per cast member; read-aloud switches narrators           | 🧪     | M      |
| Character appearance notes                                     | Structured sheet fields (age, look, want, secret) with prompts to fill them | 💡     | M      |
| Thread resolution tracker                                      | Mark threads resolved with page numbers; "open debts" count in About        | 💡     | S      |
| World-bible briefing                                           | Auto-distill the whole cast into the pre-writing brief for a new book       | 💡     | S      |

## 4. Memory, tree & the archive

| Feature                            | What it does                                                                              | Status | Effort |
| ---------------------------------- | ----------------------------------------------------------------------------------------- | ------ | ------ |
| Append-only tree, fork by re-entry | —                                                                                         | ✅     | —      |
| Story spine + page walk            | —                                                                                         | ✅     | —      |
| Visual tree graph                  | —                                                                                         | ✅     | —      |
| Branch comparison side-by-side     | —                                                                                         | ✅     | —      |
| Time-lapse replay                  | —                                                                                         | ✅     | —      |
| About-this-book ledger             | —                                                                                         | ✅     | —      |
| Rolling story summary              | The real §12.1 summarizer: chapter-so-far summaries so long books stay coherent and cheap | 🔜     | L      |
| Branch merge                       | Graft the best parts of two branches into one                                             | 💡     | L      |
| Prune / collapse old branches      | Ghost ancient threads to keep the map clean                                               | 💡     | M      |
| Branch labels                      | Name a branch ("the letter burned"), shown on the map                                     | 🔜     | S      |
| Re-enter from any title            | All 40 remembered titles become entry points (§5)                                         | 💡     | M      |
| Bookmarks / dog-ears               | Mark pages, jump between them                                                             | 🔜     | S      |
| Marginalia                         | Private notes attached to any page or node, searchable                                    | 💡     | M      |
| Highlights                         | Highlight passages in the reader; export highlights                                       | 💡     | M      |
| Branch summaries                   | "What happened in this branch?" one-tap model summary                                     | 🧪     | S      |
| Version gallery view               | The road-not-taken as a browsable gallery of full drafts (§8.4)                           | 💡     | M      |
| Compare three ways                 | Extend side-by-side to three panes                                                        | 💡     | S      |
| Graph zoom & pan                   | Smooth zoom for huge trees                                                                | 💡     | M      |

## 5. Reading experience

| Feature                                          | What it does                                                          | Status | Effort |
| ------------------------------------------------ | --------------------------------------------------------------------- | ------ | ------ |
| One-page reader, title page, cast, mood map      | —                                                                     | ✅     | —      |
| Read-aloud with voice/speed/bedtime auto-advance | —                                                                     | ✅     | —      |
| Themes (dark/sepia/light) + font scale           | —                                                                     | ✅     | —      |
| Persistent reading position                      | —                                                                     | ✅     | —      |
| Distraction-free reading mode                    | Console hidden until hover                                            | 💡     | S      |
| Page-flip animation                              | A real page-curl micro-interaction                                    | 💡     | M      |
| Swipe gestures                                   | Turn pages on touch screens                                           | 🔜     | S      |
| Reading progress bar                             | Words read vs total, chapter position                                 | 💡     | S      |
| Estimated read time                              | Per page and per book                                                 | 💡     | S      |
| Font choices                                     | A few bundled serif/sans stacks (no downloads — the single-file rule) | 💡     | S      |
| Dyslexia-friendly option                         | Wider letter-spacing + alternative font stack                         | 💡     | S      |
| High-contrast mode                               | WCAG-ish contrast toggle                                              | 💡     | S      |
| Reduced-motion mode                              | Kill all animations                                                   | 💡     | S      |
| Full screen-reader pass                          | Landmarks, live regions for generation                                | 💡     | M      |
| Ambient lighting accent                          | Page background subtly tinted by the current mood                     | 💡     | S      |
| Keyboard cheat-sheet                             | `?` overlay listing every shortcut                                    | 🔜     | S      |
| Command palette                                  | Ctrl+K: jump to any view, book, or page                               | 💡     | M      |
| Immersive timer                                  | "Read for 20 minutes" focus sessions                                  | 💡     | S      |

## 6. Exports & artifacts

| Feature                                           | What it does                                                                               | Status | Effort |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------ | ------ |
| txt / md / EPUB / PDF export with cast + mood map | —                                                                                          | ✅     | —      |
| Quote cards                                       | Page → shareable PNG                                                                       | ✅     | —      |
| Standalone HTML e-book                            | The compiled book as one readable HTML file                                                | 🔜     | S      |
| Print stylesheet                                  | Browser print of the reader is already clean; formalize it                                 | 💡     | S      |
| Book cover generator                              | Procedural canvas cover (title typography + mood palette)                                  | 💡     | M      |
| Full-tree export with metadata                    | Already JSON; add a human-readable tree report                                             | 💡     | S      |
| Word-count goal tracking                          | NaNoWriMo-style progress toward a target length                                            | 🔜     | S      |
| Backup nudge                                      | "14 pages since your last export" reminder                                                 | 💡     | S      |
| Export the cast alone                             | `cast.json` / `cast.md`                                                                    | 💡     | S      |
| Audio export                                      | Export the TTS read-aloud as audio — impossible in-browser without encoding work; deferred | ⛔     | L      |
| Print-on-demand                                   | Real physical books — requires an external print service                                   | ⛔     | —      |
| Illustrations                                     | Per-page AI images — needs an image-capable local model                                    | 🧪     | L      |

## 7. Pre-writing, briefing & sequels

| Feature                            | What it does                                              | Status | Effort |
| ---------------------------------- | --------------------------------------------------------- | ------ | ------ |
| Pre-writing chat + distilled brief | —                                                         | ✅     | —      |
| Sequels that inherit the cast      | —                                                         | ✅     | —      |
| Questionnaire mode                 | The AI interviews you instead of free chat                | 💡     | M      |
| Reference documents                | Paste lore/notes; always injected                         | 🔜     | M      |
| Sample-page audition               | One test page in 3 voices; pick the voice                 | 🧪     | M      |
| Outline-to-pages                   | Chat produces an outline; each beat becomes a page target | 🧪     | L      |
| Brief editor after seeding         | View/edit the brief from the story map                    | 💡     | S      |
| Multi-book saga mode               | A shelf that chains sequels into a saga                   | 💡     | M      |
| Seed library                       | Browse/reuse past seeds, including lucky ones             | 💡     | S      |
| AI-generated seeds                 | "Surprise me" via the model, not just a fixed list        | 🧪     | S      |

## 8. Sound, voice & atmosphere

| Feature                         | What it does                                         | Status | Effort |
| ------------------------------- | ---------------------------------------------------- | ------ | ------ |
| Ambient mood soundscape         | Generated pad retuned per page mood                  | ✅     | —      |
| UI sound cues                   | Subtle ink/paper sounds on keep, fork, end           | 💡     | S      |
| Per-character read-aloud voices | Cast-aware narration                                 | 🧪     | M      |
| Voice input for directions      | Speak the turn                                       | 💡     | M      |
| Mood-crossfade                  | Smoother ambient transitions between pages           | 💡     | S      |
| Silence schedule                | "Calm after 10pm" — ambience off by default at night | 💡     | S      |
| Audio logo                      | A tiny Page Turn sound on boot                       | 💡     | S      |

## 9. Library & organization

| Feature                                          | What it does                                                       | Status | Effort |
| ------------------------------------------------ | ------------------------------------------------------------------ | ------ | ------ |
| Bookshelf with search (titles, seeds, page text) | —                                                                  | ✅     | —      |
| Sorting: recent / mood / length / branches       | —                                                                  | ✅     | —      |
| Onboarding tour                                  | —                                                                  | ✅     | —      |
| Visual spines                                    | Actual book-spine rendering of the shelf (§10)                     | 💡     | M      |
| Fuzzy search                                     | Typo-tolerant matching                                             | 💡     | S      |
| Filter by status                                 | Finished / in progress / most-forked                               | 💡     | S      |
| Tags & collections                               | User-defined shelves ("bedtime", "workshop")                       | 🔜     | S      |
| Book covers                                      | Generated cover thumbnails on the shelf                            | 💡     | M      |
| Duplicate detection                              | Warn when a seed matches an existing book                          | 💡     | S      |
| Drag-drop import                                 | Drop `.ptlibrary.json` / `.ptbook.json` onto the window            | 🔜     | S      |
| Library merge                                    | Import merges instead of replaces, with conflict view              | 💡     | L      |
| Multi-file backups                               | OPFS keeps last N library snapshots                                | 💡     | M      |
| Stats across the shelf                           | Total words directed, books finished, branches grown               | 💡     | S      |
| Streaks & local achievements                     | "First fork", "10 versions of one page" — on-device only, no cloud | 💡     | M      |

## 10. Model & infrastructure (local LLM)

| Feature                                                   | What it does                                                        | Status | Effort |
| --------------------------------------------------------- | ------------------------------------------------------------------- | ------ | ------ |
| Scan, LAN discovery, manual entry, API keys, two dialects | —                                                                   | ✅     | —      |
| Fast model per phase                                      | —                                                                   | ✅     | —      |
| Per-page model metadata + "models used" report            | —                                                                   | ✅     | —      |
| Fallback chain                                            | Page fails → smaller model retries → friendly error                 | 🔜     | M      |
| Endpoint rotation                                         | Alternate between two servers (load/heat)                           | 💡     | M      |
| Cost/latency dashboard                                    | Tokens & time per page/branch/book (no telemetry — local estimates) | 💡     | M      |
| Context meter                                             | Show how full the generation budget is as the book grows            | 🔜     | S      |
| Model comparison                                          | Same prompt to two models, side by side                             | 🧪     | M      |
| Preset parameter packs                                    | Temperature/prompt presets per genre                                | 💡     | S      |
| Streaming metrics                                         | Words-per-second in the busy panel                                  | 💡     | S      |
| Timeout tuning                                            | Per-phase timeouts (JSON phases shorter)                            | 💡     | S      |
| Model health check                                        | Periodic "OK?" probe with status in the header                      | 💡     | S      |

## 11. Sharing, collaboration & social

All of these need a server or an external service, which the product's single-file, no-cloud,
no-account promise forbids. Listed for completeness.

| Feature                              | Status                   |
| ------------------------------------ | ------------------------ |
| Share a page as a quote card         | ✅ (offline, file-based) |
| Share a whole book as `.ptbook.json` | ✅ (offline, file-based) |
| "Friends vote what happens next"     | ⛔                       |
| Public gallery of compiled books     | ⛔                       |
| Fork someone else's public tree      | ⛔                       |
| Co-authoring two people at one turn  | ⛔                       |
| Print-on-demand physical books       | ⛔                       |

## 12. Moonshots

| Feature                       | What it is                                                                                                                  | Status | Effort |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------ | ------ |
| Living-book serial mode       | The book never ends; you direct a new page whenever you return (§16)                                                        | 💡     | L      |
| Style imprints                | "Write like" authorial flavors (noir, fairytale, epistolary, braided)                                                       | 🧪     | M      |
| Choose-what-they-chose        | Watch another creator's tree replay (needs a shared file; already possible by importing their `.ptbook.json` and replaying) | 💡     | S      |
| Full audio drama              | Cast voices + ambience = a performed reading                                                                                | 🧪     | L      |
| Multimedia pages              | Telegraphs, wanted posters, radio transcripts, manifests, epitaphs, crosswords                                              | 🎨     | M      |
| Physical artifacts            | The tree printed as a poster, the cast as a family-tree chart (local PDF)                                                   | 💡     | M      |
| Saga shelf                    | Sequels chained, bible inherited automatically                                                                              | 💡     | M      |
| Kids' bedtime co-storytelling | Emoji console + picture prompts + read-aloud                                                                                | 💡     | L      |
| Accessibility champion        | Screen-reader perfect, keyboard-only playable                                                                               | 💡     | M      |
| Pocket edition                | A tiny-mode UI (⌘ small) for phones                                                                                         | 💡     | M      |

---

## Suggested next batches

1. **Coherence & craft** (biggest story-quality wins): rolling story summary · relationship graph ·
   nudge presets · pace & cliffhanger toggles · conflict detector.
2. **Living shelf** (retention): book covers · tags/collections · streaks · drag-drop import ·
   backup nudge · fuzzy search.
3. **Read-it-anywhere** (delight): page-flip animation · swipe gestures · standalone HTML e-book ·
   ambient lighting accent · keyboard cheat-sheet.
4. **Voice & sound** (atmosphere): voice-directed turns · per-character voices · UI sound cues.
5. **Model power-user** (local-LLM depth): fallback chain · context meter · cost dashboard · model
   comparison.
6. **Experiments** (needs capable models): illustrations · style imprints · sample-page auditions ·
   outline-to-pages.

## Maintenance notes

- Every pure-logic feature gets unit tests; every view stays a function of `AppApi`.
- The single-file contract is load-bearing: no external requests, no runtime dependencies,
  `pnpm check` green before merge.
- New node kinds and settings fields bump `LIBRARY_SCHEMA_VERSION` and must normalize old files.
- The docs trio (README, ARCHITECTURE, this file) must be updated with every shipped batch.

## 13. Round 5 — the book that knows you

| Feature                       | What it does                                                                                                                                   | Status | Effort |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------ |
| The Prologue That Knew        | After The End, the model re-reads the finished book and writes page zero — a prologue that plants the ending's seeds                           | ✅     | M      |
| Director's Commentary Edition | Turn decisions woven into the reading view as margin notes + a director's-cut export                                                           | ✅     | M      |
| What-If Ghost Pages           | Preview a different direction at any turn WITHOUT committing — adopt it as a branch or let it dissolve                                         | ✅     | M      |
| Iron Author Mode              | Per-book difficulty: 3 re-rolls per page, or none — mistakes become story; unlocks the Iron Author badge                                       | ✅     | S      |
| The Story Linter              | No-model metrics: repetition n-grams, adverb ratio, sentence-length variance, dialogue density, cliffhanger cadence                            | ✅     | M      |
| Pass the Quill                | Co-write by file: export the book, a friend grows a branch on their machine, drop it back — their pages land as new branches, authors recorded | ✅     | M      |
| The Score of Your Book        | The mood map exported as a playable MIDI file — and performed by the ambient engine                                                            | ✅     | M      |
| The Director's Portrait       | At The End, the model writes a playful reading of your directing style — tendencies, obsessions, growth                                        | ✅     | S      |
| The Document Wardrobe         | Per-format typography: letters, diaries, clippings and map notes each get their own font                                                       | ✅     | S      |
| Retroactive Rename Surgery    | Rename a person/place/thing EVERYWHERE on the chosen path — past pages rewritten as new versions, fork-safe                                    | ✅     | L      |
