# NEXT — the 10 next features, ranked

The ranked implementation plan for the remaining pure-client features. Criteria: coherence impact on
the core promise (long books must not drift), directability at the page turn, the
single-file/no-cloud constraint, and value-per-cost given the patterns already in the code
(`TurnInput` fields → `core/prompt.ts` calibration tables → `ui/views/turn.ts` controls, all
unit-tested).

The one architectural fact that reorders everything: `buildContext` has a hard
`CONTEXT_WORD_BUDGET = 2600` words of recent chosen pages (`src/core/prompt.ts`). The cast bible is
a structured name-list, not story memory — so a 500-page book's model only sees the last ~10 pages
plus a cast list. Everything else is decoration until that is fixed, and several features (arc
planner, merge, conflict detection) all need the same compact story-state machinery, so they get
dramatically cheaper once it exists.

---

## 1. Rolling story summary + re-enter from any title — ✅ DONE

The real §12.1 summarizer.

- **Summary storage:** a per-branch `summary` on page nodes (`page.data.summary`), exactly like the
  bible (`page.data.bible`) — each branch owns its own memory; `summaryUpTo` reads "the summary as
  of this page" like `bibleUpTo`.
- **Updater:** a background updater mirroring the bible updater in `ui/cast.ts` (runs outside the
  staleness token so it can never invalidate in-flight page work).
  `summaryMessages(ctx, previousSummary)` folds previous summary + the story-so-far pages into one
  plain-prose summary (~300 words: central conflict & plot state, where each key character is,
  current situation, mood trajectory, most critical open threads). Plain text — no parsing needed.
- **Budget redesign:** fixed blocks first, recent pages fill the remainder.
  `seed + title + brief + summary + cast + rules` are sized first; the verbatim recent pages get the
  rest of the word budget (with a floor so page 1–n always has room). The summary replaces the
  _oldest_ pages, never the recent ones — two-tier memory: summary of everything + verbatim recent
  pages.
- **Injection:** a `summaryText()` block in `pageMessages`, `paragraphMessages`,
  `insertParagraphMessages`, `rewriteSpanMessages`, `suggestionsMessages`, `endingsMessages`.
- **Re-entry from any title (§5):** every proposed title is already a node under the seed; the
  missing piece is entry UX. A titles browser (book view) lists all proposed titles with branch
  status (page count, frontier) and an Enter button — enter sets the frontier to that branch's tip
  (via a new `branchTip` tree helper) and navigates (page view for a page, turn view for a dangling
  turn, first-page flow for a bare title). Unchosen titles also become findable in library search. A
  dormant title-branch is coherent to re-enter _because_ it carries its own summary.

**Shipped:** `page.data.summary` + `attachSummary`/`summaryUpTo`/`branchTip` (`core/tree.ts`);
budget-first `buildContextTo` with `MIN_PAGE_WORDS` floor, `summaryText`, `SUMMARY_SYSTEM_PROMPT`
and `summaryMessages` injected into every page/paragraph/suggestion/ending prompt
(`core/prompt.ts`); background updater + 🧠 Story memory panel (`ui/story.ts`, wired through
`genpage.ts` and the page/turn/theend/reader views); `saveSummary`/`ensureTitleNode`/`openBranch`
(`main.ts`); settings toggle (`autoSummary`, schema v6); the story map's enterable title doorways
(`views/archive.ts`); proposed titles in library search (`views/library.ts`); unit tests for prompt,
tree and schema.

## 2. Story-arc planner — the 5-act map pages auto-follow

- `arc` on the seed (acts → beats; each beat: one-line target + default mood/pace), a planner view
  (pre-writing or distilled from chat, like `briefMessages`), and at every turn: "Act II · beat 3 of
  5 — The Storm" with progress. `pageMessages` injects "you are at beat X". Pace and cliffhanger
  become per-beat properties, auto-deriving each turn's defaults.

## 3. On-page steering: sliders + dials + nudge presets + 🎲 dice

One control-surface family (five audit items in one):

- On the page view: "more/less like this" chips that compile to the existing calibrated language and
  re-roll the page/paragraph.
- In the turn console: valence & arousal dials (two more rows in `EMOTION_NAMES`/`EMOTION_META`),
  pace and cliffhanger/resting-point as new `TurnInput` fields with guidance tables, a sudden-shift
  toggle (skip the magnitude ladder), nudge presets as a chip row ("end on dialogue", "add sensory
  detail", "raise the stakes"), a 🎲 Surprise-me button that fills the console with a random bold
  combination, and style-imprint chips nearly free.

## 4. Reference documents — paste your lore, always injected

- `docs: {title, text}[]` on the book, editable anywhere; injected verbatim as canon into every
  generation prompt. Also becomes the serialization format for cast/world-bible import-export.
  Ranked above questionnaire mode: the pre-writing chat already asks one question at a time, so
  questionnaire mode is mostly a reskin, while ref docs fix a pain the chat cannot solve.

## 5. Relationship graph + world ledger

- Extend `StoryBible` with `relations: [{from, to, kind, note}]` and `events: [{page, what}]`;
  `bibleMessages` maintains them, `castText` injects them, and a world view renders the graph as SVG
  (the `archive.ts` pattern) plus a per-branch timeline.
- Conflict detector rides the same ledger: at turn time, one structured call — "does this direction
  contradict established events? `{conflict, note}`" — and an amber chip with reconcile/fork options
  (§13).
- Import/export = the same JSON block, two buttons.

## 6. Voice-directed turns

- Mic button on the turn console and page tweak box; Web Speech `SpeechRecognition` transcript drops
  into the direction box (v1: transcript-as-text; v2: map spoken phrases onto the calibrated dial
  language). Honest caveat: Chrome's recognizer is browser-vendor cloud-backed (opt-in, labeled;
  typing always works), Firefox lacks support.

## 7. Branch merge as a merge-brief + prune/archive

- Pick any two branch frontiers → the model drafts a combined summary (characters, threads, best
  beats of both) which becomes a turn input on either branch. Deliberately NOT surgical graph
  grafting — append-only is sacred (§3 of ARCHITECTURE), and prose-level merging is a research
  problem, not a feature.
- Prune/archive: `removeSubtree` moves dead threads into an archived-branches shelf with restore —
  nothing is ever destroyed.

## 8. Bookmarks / dog-ears

- `book.marks: [{nodeId, label, at}]`, a dog-ear button on the page view, a marks drawer in the book
  view, marks surfaced in library search. Jumping is the existing `openPageAt`.

## 9. Reader polish: focus mode + page-flip + swipe + a11y

- Distraction-free reading toggle, CSS 3D page-flip, touch swipe gestures, `prefers-reduced-motion`
  honored (page-flip must not ship without it), plus a screen-reader/high-contrast pass on the page
  and turn controls.

## 10. Illustrations hook — pluggable image provider with an always-works fallback

- Optional image model/endpoint in settings; images stored in OPFS keyed by node id (never base64
  inside the one-document library JSON). Until an image-capable model is configured, "illustration
  mode" renders a deterministic SVG mood-card per page from the emotion-dial data. EPUB export
  embeds whatever exists. The feature ships now and upgrades itself when local image models arrive.

---

## Deliberately deferred

- **Questionnaire mode** — the chat already asks one question at a time; a reskin, not a feature.
- **Sample-page audition** — good, but cheaper after #3 (reuses candidate machinery) and #4.
- **Cost/latency dashboard, model fallback chain** — real plumbing; neither moves the core promise.
- **Streaming polish pass (auto-trim repetition)** — grab whenever generation code is touched.
- **Shelf-as-spines, UI sound cues, export nudge** — pure quick wins; bundle with #9's a11y pass.
- **Audio drama (per-character voices)** — possible with `speechSynthesis` voice assignment;
  read-aloud already ships.
- **Living-book serial mode** — falls out of #1 + #2 almost free once memory works.
- **Print-on-demand, gallery, co-authoring, friends-vote** — excluded by the single-file/no-cloud
  promise.

## Batch order

1. **A — Memory:** #1 (summary + re-entry) → #2 (arc).
2. **B — World:** #5 (ledger + conflicts) → #4 (ref docs; tiny, slot in anytime).
3. **C — Steering:** #3 (dials/presets/dice) → #6 (voice reuses the calibrated language).
4. **D — Tree & navigation:** #8 → #7.
5. **E — Delight:** #9 → #10.

Every feature has a pure-`core` half that needs unit tests per the repo conventions, and all of them
respect the hard rules: new view = a function of `AppApi`, everything remembered, everything local.
