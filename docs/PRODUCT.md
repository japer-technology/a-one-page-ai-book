# The One-Page AI Book

**A generative, interactive reading machine where the reader is the director, the page turn is a
creative decision, and every choice is remembered forever.**

---

## 1. The Elevator Pitch

You write one sentence — a seed. The AI writes a book from it. But not a book you read: a book you
_direct_.

- It shows you **one page at a time**. Literally one page. No scrolling through a wall of text.
- At every step you have **one job**: decide whether this page is _the_ page, and then decide _what
  happens next_.
- Every title you see, every page you see, every version of every page — **all of it is
  remembered**, so you can step back in time and re-live, re-enter, and re-branch from any moment.

The book is never "finished" until you say it is. It's a tree, not a line. It's a collaboration, not
a generation.

---

## 2. The One-Sentence Thesis

> **A page turn should be a decision, not a gesture.**

A normal book turns the page for you. A normal AI book dumps 10,000 words at you and you hope it's
good. This book inverts that: the _turning of the page_ is the single most important creative moment
in the whole experience, because that's the moment where you — the reader — choose the direction,
the mood, the pace, and the ending.

Everything else in the product exists to serve that one moment.

---

## 3. The Core Loop

The entire product is one repeating cycle with a setup phase and an ending phase:

```
SEED
  │
  ▼
TITLE ──► pick a title (or regenerate, all remembered)
  │
  ▼
PAGE ───► generate page over and over until satisfied
  │
  ▼
PAGE TURN ──► choose parameters for the next page
  │
  ▼
PAGE ───► (loop back)
  │
  ▼
THE END ──► when YOU decide the story closes
```

Concretely, a full session looks like this:

1. **Seed.** You type a sentence. _"A lighthouse keeper finds a letter addressed to someone who died
   a hundred years ago."_
2. **Titles.** The AI proposes, say, five titles. You pick one, or ask for five more. Every single
   title is saved.
3. **Page 1.** The AI writes page 1. You don't love it. You hit "again." It writes another. And
   another. The fourth one gives you chills. You keep it.
4. **The Turn.** The page ends mid-scene. The screen now asks: _What happens next?_ You say: more
   dread, shorter pages, and the letter should be from the keeper's own grandfather. You also toggle
   "don't reveal the letter yet."
5. **Page 2.** Generated with your directions. You iterate until satisfied. Keep it.
6. **The Turn again.** Now you say: longer, warmer, introduce a second character, start hinting at a
   storm.
7. ...and so on, until at some turn you say **"bring the story to a close."**
8. **The End.** The AI writes a closing page (iterated like any other), and the book is complete.
   You can read it front to back, or keep branching from any point.

---

## 4. The Seed

The seed is the creative spark, and it should be as frictionless as possible.

**What counts as a seed:**

- A single sentence ("A girl inherits a hotel that only appears in the fog.")
- A premise fragment ("cyberpunk whodunit in a space elevator")
- A genre + a twist ("gothic romance, but the house is also the villain")
- A vibe ("cozy, melancholic, small town, autumn")
- A character ("an immortal librarian who is allergic to books")
- An existing text (paste a paragraph; the AI continues it in its own voice)
- A question ("what if dogs could file taxes?")
- A mashup ("Jane Austen meets Blade Runner")
- Literally nothing — an "I'm feeling lucky" seed generator

**Design principle:** the seed should be _a spark, not a spec_. We don't want users writing a full
brief. One line. The AI does the heavy lifting. The heavy lifting of direction comes later, page by
page — not up front.

**Optional seed-level settings (kept light, with sensible defaults):**

- Genre (or "surprise me")
- Perspective (first/third/second person, or "decide for me")
- Tense (past/present)
- Tone baseline (warm / dark / funny / literary / pulpy)
- Target audience / content rating (kid-safe, teen, adult)
- Overall length hint ("short story," "novella," "let it run")

But critically: **none of these are locked in.** They are starting defaults, and every one of them
can be overridden at any page turn. The seed is the seed, not the contract.

---

## 5. The Title Phase

Before a single page exists, the book needs a name — because the title is also the **entry point**
you'll use to come back later.

**The title phase flow:**

1. AI generates N titles (3–7 is a good range; 5 feels right). Each with a one-line flavor note or
   tagline.
2. The user either:
   - **Picks one** → the book is named, page 1 begins.
   - **Regenerates** → N more titles, _all previous ones remembered_.
   - **Mixes/edits** → maybe the user likes "The Letter at Low Tide" but wants it to be "The Letter
     at Low Tide: A Story of Salt and Secrets."
   - **Asks for a style** → "titles like old gothic novels," "one-word titles," "titles that sound
     like a Netflix miniseries."

**Why titles matter more than you'd think:**

- The title is the **save file name**. It's what you'll click on to re-enter.
- A great title _retroactively recontextualizes the story_ — picking "The Lighthouse Keeper's
  Grandson" versus "The Dead Letter" changes how the AI should write page 1. The title becomes a
  hidden steering signal.
- Titles are cheap to generate and fun to browse. It's a low-stakes warm-up for the bigger decisions
  to come, and it establishes the rhythm of "generate → choose → keep."

**Every title is remembered.** If you generate 40 titles and pick #37, all 40 live in the book's
archive. You can re-enter from _any_ of them later — which effectively means you can have 40
parallel versions of the same seed, each branching from a different title.

---

## 6. The Page Phase

This is the "generate until it's good" loop.

**The rules of a page:**

- A page is **short**. Real, physical-page length: roughly 150–400 words. Enough to feel
  substantial, not enough to lose yourself.
- A page is **self-contained-ish** but hooks forward. It should feel like turning an actual page in
  a real book — it ends at a natural (or deliberately unnatural) beat.
- A page is **one beat** of story. Maybe one scene fragment, one exchange, one reveal, one image.
  Not a chapter. A _page_.
- Every page has a **page number** in the final book. The medium is the message: we are _not_ a chat
  window. We are a book.

**The iteration controls on a page:**

- **Keep this page.** The core action. Lock it in.
- **Regenerate.** Same direction, new attempt. Keep or discard.
- **Regenerate with a tweak** (inline, one-line instruction): _"make the keeper's hands shake,"
  "more fog," "end on the letter, not the door."_
- **Regenerate more/less like this** — steering sliders without leaving the page.
- **Roll back to a previous version.** All versions of _this_ page are stored, and you can flip
  between them like flipping through drafts.
- **Edit the page yourself.** Maybe the AI got it 90% right and you just want to change one
  sentence. The user's edit becomes a new "version" of the page (with attribution: "edited by you").

**A subtle but important point:** regenerating a page should _not_ force a full re-roll of
everything. We want **targeted regeneration** — keep the parts you like, re-roll the parts you
don't. ("Keep the first paragraph, rewrite the ending.") This is the difference between a slot
machine and an instrument.

---

## 7. THE PAGE TURN — The Heart of the Whole Thing

This is the feature the entire product is built around. When you lock in a page, the screen doesn't
just advance. It _asks you a question_.

> **"The page is written. What happens next?"**

The page turn is a **director's console** for the next page. It's where the reader becomes the
author without ever having to write prose.

### 7.1 Why this is the "important part"

- In every other AI writing tool, steering happens either _before_ (a big prompt) or _after_
  (editing/regenerating the output). Here, steering happens **at the natural seams of the story** —
  at page turns — which is exactly when a human reader is already imagining "what I hope happens
  next."
- It makes the experience **rhythmic**: read → decide → read → decide. A heartbeat.
- It keeps the user **emotionally invested**: the next page _belongs_ to them a little bit, because
  they set its direction.
- It produces **better stories**: an AI writing a whole novel drifts; an AI writing _one page_ in
  response to _one focused direction_ stays sharp.
- It solves the blank-page problem: the user never has to write "continue the story with more
  tension but also..." — they get a menu, sliders, and chips instead of a cursor.

### 7.2 The parameter catalog

The turn offers a rich but _organized_ set of controls. Not all at once (that's overwhelming) —
grouped, with the most important first, and everything collapsible.

#### A. Story direction (the big lever)

- **What happens next** (free-text): the "story idea" box. _"The letter is from his grandfather."_
  _"The storm hits the island."_ _"A stranger arrives by boat."_
- **Suggested directions**: the AI itself proposes 3–5 concrete "next beat" options based on the
  story so far ("The keeper opens the letter that night," "A fog rolls in and the light fails," "He
  discovers the letter is addressed to _him_"). The user picks one, or writes their own. This is the
  "choose your own adventure" moment, but instead of choosing a fixed path, you're choosing a
  _direction_ that the AI will then write _fresh_.
- **Introduce a character** / **remove a character** / **focus on X**.
- **Reveal** something / **conceal** something (control over information).
- **Flashback / flash-forward** / **stay in the present**.
- **Change location** / **stay put**.

#### B. Structure and pacing

- **More words per page / fewer words per page** (a slider, or "short page / standard / long page").
- **Pace**: slow and meditative vs. propulsive.
- **Start a new chapter** (chapter break: the next page is the first page of a new chapter, with its
  own chapter heading and possibly a new title).
- **Bring this chapter to a close** (the AI knows it should wrap the current thread in the next page
  or two, landing on a chapter-ending beat).
- **Bring the story to a close** (the AI moves toward an ending — see Section 9).
- **Cliffhanger** (end the page on a hook) vs. **resting point** (end on a moment of calm).
- **Time jump** (next page skips forward hours/days/years).
- **Parallel scene** (cut to what's happening elsewhere).

#### C. Tone and voice

- **Overall tone**: warmer, colder, darker, lighter, funnier, more serious, more poetic, more plain.
- **Emotion dials** (this is the "more/less of each emotion" idea, and it deserves its own treatment
  — Section 7.3).
- **Voice**: more literary vs. more conversational; first-person internal monologue vs. cinematic
  third person; sparse vs. lush.
- **Dialogue vs. description** ratio.
- **Humor level, horror level, romance level, wonder level** — as independent axes, not a single
  "tone" knob.

#### D. Content and safety

- **Intensity caps**: violence, sex, profanity, horror — up/down (respecting the content rating set
  at seed time).
- **"Keep it kid-safe"** one-tap override.

#### E. "Don't touch" (negative space)

Just as important as what to do: **what NOT to do**.

- "Don't resolve the letter yet."
- "Don't introduce a love interest."
- "Don't kill anyone."
- "Don't leave the island."
- "Keep the story in the past tense."
- "Don't change the point-of-view character."

These are **standing constraints** (they persist until removed) vs. **one-shot directions** (apply
to the next page only). This distinction is crucial: some instructions are for _this page_, some are
for _the rest of the book_.

### 7.3 The Emotion Dials (a deeper look)

The user specifically imagined "more/less of each emotion." This is one of the most evocative
controls in the product, so let's brainstorm it properly.

A panel of emotion sliders, each from −3 to +3 (or 0 to 10), where the default is "inherit /
balanced":

- **Tension / suspense** 🕯️
- **Wonder / awe** ✨
- **Warmth / tenderness** 🤍
- **Dread / fear** 🕳️
- **Humor / wit** 😏
- **Sadness / melancholy** 🌧️
- **Romance / longing** 🖤
- **Joy / delight** ☀️
- **Mystery / curiosity** ❓
- **Menace / danger** ⚠️

And maybe a **valence** dial (overall positive↔negative) and an **arousal** dial (calm↔intense) —
borrowing from psychology's affect circumplex to keep it elegant instead of an endless list.

**Design considerations:**

- Default is always "inherit the current mood" — the story's emotional state carries forward
  _unless_ you touch a dial.
- Dial changes should be **gradual** by default: asking for "+dread" shouldn't jump-cut to a
  monster; it should _tilt_ the next page slightly darker, letting dread build. (Optionally a
  "sudden shift" toggle for when you _do_ want a jump-scare of tone.)
- The dials should be **visible in the final book** as a mood map — a little sparkline of emotional
  temperature over the pages. ("This is where it gets scary," literally visualized.)
- Micro-interactions: hovering a dial could show a one-word description ("current: bittersweet" /
  "next: ominous").

### 7.4 The turn UI — what it actually looks like

Imagine the page you just chose, still on screen, dimmed slightly. Below it, a panel slides up:

```
┌─────────────────────────────────────────────┐
│  "She turned the letter over. The wax was    │
│   still warm."                              │
│                                             │
│   Page 1 · kept ✓                           │
├─────────────────────────────────────────────┤
│  WHAT HAPPENS NEXT?                         │
│                                             │
│  Suggested directions:                      │
│   [🔒 The keeper opens the letter tonight]  │
│   [🌫️ A fog rolls in and the light fails]   │
│   [👤 A stranger arrives by boat]            │
│   [✍️ Write your own...]                     │
│                                             │
│  Tone:  [ —·—·—●—·— ]  darker             │
│  Emotion dials:  [dread +2] [wonder 0] ...  │
│  Length: [ short │ standard │ long ]        │
│                                             │
│  Standing rules: (none yet) [+ add]         │
│                                             │
│      [ Generate next page → ]               │
└─────────────────────────────────────────────┘
```

Key UX principles:

- **No blank cursor required.** You can hit "Generate next page" with _zero_ inputs and it continues
  smoothly — but the controls are there, inviting you to steer.
- **Defaults are smart.** "Continue naturally" is always a one-tap option.
- **The turn is skippable but never hidden.** Even "continue naturally" is a choice you made.
- **Feedback is immediate.** The next page appears, and if it misses your direction, the page-phase
  iteration loop is right there to catch it.

---

## 8. Memory, Reentry, and the Tree

This is the second pillar (after the page turn): **everything is remembered.**

### 8.1 What "remembered" means

- Every **seed** you've ever used.
- Every **title** generated (even the ones you didn't pick).
- Every **page version** (even the ones you discarded).
- Every **page-turn decision** (the parameters, the sliders, the free-text directions).
- Every **branch point** (the moment you chose path A over path B).
- Every **completed book** and every **abandoned thread**.

### 8.2 The data structure: a tree (actually, a graph)

The book is a tree:

```
                SEED
                 │
        ┌────────┼────────┬───────┐
      Title1   Title2   Title3  Title4 ...
        │
      Page 1  (versions: 1a, 1b, 1c ← chosen)
        │
   ┌────┼────────┬─────────┐
 Turn A    Turn B    Turn C   (different directions chosen at the turn)
   │         │         │
 Page 2a   Page 2b   Page 2c
   │
  ...
```

Every node (seed, title, page, turn) is addressable and re-enterable. The tree is the product's
**most valuable asset**: it's a complete record of the reader's creative journey, not just the final
artifact.

### 8.3 Reentry

From the library screen, you can click **any title** and land back at that branch's current frontier
— not the beginning, the _frontier_ (wherever you last were, mid-story). But you can also:

- **Step back** to any earlier page and **fork**: choose a different direction at an old turn, and
  the new pages become a _new branch_ while the old pages remain intact.
- **Re-roll an old page** without disturbing anything downstream — the new version becomes a new
  child branch automatically (because changing page 3 invalidates pages 4+, but those pages are
  _kept_, not destroyed).
- **Duplicate** a branch to experiment.
- **Compare** two branches side by side ("what if she opened the letter vs. what if she burned
  it?").

### 8.4 The Archive view

A dedicated view that shows the whole tree visually:

- A **timeline/graph** of pages and turns.
- Each node is a thumbnail of the page (or a title).
- Chosen paths are bright; unchosen paths are ghosted but still clickable.
- Page-turn decisions are annotated on the edges ("+dread, introduce a stranger").
- A **"read the road not taken"** feature — browse discarded versions as a gallery.

This is the feature that makes the product feel _alive_ long after the first session: your book is a
garden of possibilities, not a single path.

---

## 9. Ending the Story

Endings are a special case of the page turn, important enough to call out.

**Ways to end:**

- **"Bring the story to a close"** at a turn → the AI knows the next page (or next few pages) should
  move toward resolution, and it will signal when a natural ending is near.
- **"End it here"** → the current page is the last page; the AI optionally appends a short
  coda/epilogue.
- **"Write an ending"** → the AI proposes 3–5 _possible endings_ (bittersweet, triumphant,
  ambiguous, twist, open-ended), the user picks or iterates — same rhythm as titles, but for the
  finale.
- **"This is the last chapter"** → the AI paces the remaining pages to land the ending by the
  chapter's end.

**The ending must be iterable like any page.** A bad ending ruins a good book, so the "generate
until satisfied" loop applies with full force — endings are the pages worth the most iterations.

**After the end:**

- The book compiles into a **clean, linear, readable version** (the chosen path) — exportable as a
  nicely typeset page-by-page book (EPUB/PDF/plain text), complete with chapter headings, a title
  page, and the mood map.
- The **tree remains** — the compiled book is just _one_ path through it; you can always return and
  fork.
- An **"About this book"** page: the seed, the title, the number of pages, the number of versions,
  the decisions made, the total words generated vs. kept (a fun stat: "you wrote 142 words and
  directed 11,283").

---

## 10. The Library (your bookshelf)

A home screen that feels like a bookshelf, not a file manager:

- Each **title** is a book spine on a shelf.
- Completed books look "bound"; in-progress books look "open" (or "dog-eared").
- Clicking a spine enters at the frontier; a small "..." menu offers: read the compiled version,
  open the archive/tree, fork, rename, export, delete.
- **Sorting**: recent, by mood, by length, by "most branched."
- **Search**: across seeds, titles, and even page text.

The emotional payoff: this shelf fills up with _your_ books — books that literally could not exist
without your decisions. That's a strong retention loop.

---

## 11. Sharing and Social (brainstormed, optional)

- **Share a page** as a beautiful quote card (typography-first).
- **Share a "choose the next direction" prompt** to friends — they vote on what happens next, you
  write the result. (A collaborative book.)
- **Publish the compiled book** to a public gallery with its decision history attached.
- **"Fork someone else's book"** — take a public seed (or even a public tree) and write your own
  version from any node.
- **Co-authoring**: two people at one page turn, both steering, alternating decisions.
- **Read-aloud mode** with a voice, so the "one page at a time" rhythm becomes a bedtime-story
  experience for kids.

---

## 12. Technical Architecture (sketch)

### 12.1 Core services

- **Generation engine**: a capable LLM, with a _strong_ system prompt that enforces: one page,
  ~150–400 words, ends on a beat, respects the direction + standing rules + emotion dials. Context =
  the seed + title + all chosen pages so far + the current turn's parameters + standing
  constraints + the story's summary.
- **Story state / summarizer**: as the book grows, a rolling summary (plus character bible, plot
  threads, tone state) is maintained so the model always has compact context. The full chosen-path
  text is also included, up to the context limit.
- **Tree store**: a versioned graph database (or a document store with parent/child links and
  content-addressed nodes). Immutable nodes; branches are cheap pointers.
- **Metadata layer**: each node carries its generation parameters, timestamps, model version, and
  the user's decisions — this is what makes reentry and the archive possible.
- **Prompt assembly**: the turn parameters compile into a structured generation prompt (not just
  free text) — sliders map to calibrated instruction language ("dread: +2" → "slightly heightened
  dread, creeping unease, nothing overt").

### 12.2 Interesting technical challenges

- **Long-context memory**: a 50-page book is fine; a 500-page book needs summarization + retrieval.
  The character bible and "open threads" list are key.
- **Consistency**: names, facts, tone, and callbacks must hold across regenerations and branches.
  Each chosen page should update the story bible.
- **Targeted regeneration**: re-rolling "just the ending of this page" requires the model to treat
  prior paragraphs as fixed context.
- **Standing rules**: persistent constraints must be injected every generation and never silently
  dropped.
- **Emotion dials → prose**: mapping numeric dials to actual narrative choices (not just "make it
  scarier" adjectives, but _structural_ choices: shorter sentences, withheld information, darker
  imagery).
- **Branch explosion**: the tree can get huge; the UI needs to collapse/ghost old branches and the
  store needs cheap fork semantics.
- **Cost/latency**: page generation should feel _fast_ (streaming), and regeneration of many
  candidates can be parallelized.

### 12.3 Model-agnostic

The product should treat the model as a swappable engine (this matters as models improve). The tree,
the parameters, the archive — none of that depends on any single model. A book started on model A
can continue on model B (metadata records which model wrote each page).

---

## 13. Edge Cases & Design Questions (the hard parts, brainstormed honestly)

- **What if the user regenerates page 1 after 50 pages exist?** Answer: it becomes a new branch.
  Pages 2–50 are preserved on the original branch; nothing is destroyed. The UI must make this feel
  safe, not scary ("forking a new branch").
- **What if the user's direction contradicts the story so far?** ("Make her a doctor" when she's
  established as a lighthouse keeper.) The AI should either adapt gracefully (maybe a plot
  justification) or flag it ("heads up: this conflicts with page 7 — do you want to reconcile it or
  fork?").
- **What if a page is "too good" to lose but the user keeps regenerating?** Always keep the last N
  versions visible, with a "pin this version" option, so "keep the third one" is trivially possible.
- **How long is a page, really?** Physical-page metaphor suggests short; but some users want "a page
  = a scene." Make it a per-book setting.
- **Does the reader see the turn controls before or after reading the page?** After (you must read
  before you direct). But the page should _end_ with a subtle hook that makes you want to direct.
- **What about illustrations?** Optional: an "illustrate this page" toggle (AI-generated image per
  page), making it a picture book / graphic novel hybrid. The illustration can also be regenerated
  like text. (This is a strong stretch feature.)
- **Offline/export**: the compiled book is always exportable, so the product never holds your story
  hostage.
- **Ownership**: who owns the tree? The user does. Full export of the raw tree (JSON) should be a
  first-class feature.
- **Accessibility**: the one-page-at-a-time format is naturally good for focus and for screen
  readers; read-aloud and high-contrast modes are natural fits.
- **Kids mode**: a simplified turn console (just emoji mood buttons + "what happens next" with
  picture options) turns this into a family co-storytelling toy.
- **Does "regenerate" feel like gambling?** Guardrails: keep all versions, always allow going back,
  and let the user _nudge_ rather than re-roll blindly, so it feels like craft, not a slot machine.

---

## 14. Why People Will Love It (the psychology)

- **Agency without skill.** You feel like an author without facing the blank page. The AI writes;
  you _direct_. Directing is easier and more fun than writing.
- **Perfect attention span.** One page at a time = no overwhelming wall of text, no "I'll finish it
  later." It's snackable and focus-friendly at once.
- **Endless, but bounded.** Infinite possibilities, but always _one clear next action_. No
  paralysis.
- **Ownership.** Because you chose at every turn, the book is _yours_ in a way a one-shot generated
  novel can never be.
- **Replayability.** The same seed is a different book every time — and the tree _shows_ you that.
- **The joy of the seam.** The page-turn question mirrors the best moment of reading any book:
  closing the page and thinking, "I hope X happens." Here, that thought _changes the story_.

---

## 15. Monetization & Product Shape (brainstormed)

- **Free tier**: limited seeds/books, N regenerations per page, standard export.
- **Paid**: unlimited trees, all parameter controls, illustration mode, advanced export
  (EPUB/PDF/typeset), long books, priority models.
- **A la carte / credits**: per-page, per-branch, or per-illustration.
- **Gift**: buy someone a "custom book" — you write the seed, they direct the pages.
- **Merch-adjacent**: print-on-demand of the compiled book (a real physical artifact of a digital
  journey).
- **Model-agnostic subscription**: the product sells the _experience_ (the tree, the turn console,
  the archive), not the tokens.

---

## 16. Stretch Ideas / Moonshots

- **Voice-directed page turns**: speak your direction aloud at each turn ("make it scarier, and he
  should hear footsteps").
- **Ambient soundtrack** per page, keyed to the emotion dials.
- **A "mood map" that's actually beautiful**: the compiled book includes a page-by-page emotional
  graph, printed in the margins.
- **Multimedia pages**: some pages could be letters, maps, diary entries, newspaper clippings,
  recipes — diegetic documents rendered as images. (The lighthouse letter _is_ the page.)
- **Multi-book sagas**: a completed book becomes the seed for its sequel, inheriting the character
  bible.
- **"Living book" mode**: the book never ends; it keeps generating pages as a serial, like a
  never-ending soap opera you direct weekly.
- **Choose-what-they-chose**: a "read mode" where you watch the tree replay itself — a time-lapse of
  someone else's creative journey.
- **Style imprints**: "write like" a chosen authorial flavor (with appropriate care around living
  authors).

---

## 17. Naming Ideas (just for fun)

- **Page Turn** (the most on-the-nose and probably the best)
- **The Turn**
- **One Page**
- **Next Page**
- **Dogear** / **Dog-Ear**
- **The Margin**
- **Leaf** (as in a page/leaf of a book)
- **Bound** / **Unbound**
- **Spine**
- **Folio**
- **Loom** (weaving the story)
- **Graft** (as in branching)
- **Fork & Ink**
- **Seedsong**
- **Quill**
- **Marginalia**
- **The Second Page**
- **Turnleaf**
- **Elsewhere** (the road not taken)
- **Inkwire**

Taglines:

- _"The book you write by turning the page."_
- _"One page. Your call."_
- _"Write by deciding."_
- _"Every page turn is a plot twist."_
- _"You bring the spark. The story branches from there."_
- _"A book that remembers every version of itself."_

---

## 18. The MVP vs. The Dream

**MVP (the smallest thing that's still this idea):**

1. Seed input → 5 titles → pick one.
2. Page generator with "keep / regenerate / regenerate with a tweak."
3. A simple page-turn panel: free-text direction + "more/less words" + "darker/lighter" + "continue
   naturally."
4. Everything remembered: a flat history of every title and every page version, re-enterable from
   the title.
5. "Bring the story to a close" at the turn.
6. Export the chosen path as clean text.

**V2:**

- Emotion dials.
- Suggested directions (the AI proposing next beats).
- The tree/archive visual view, forking.
- Standing rules vs. one-shot directions.

**V3+:**

- Illustrations, mood map, read-aloud, sharing/forking, print-on-demand, multi-model support,
  collaborative books.

The MVP already contains the soul of the thing: **one page at a time, generate until it's good, and
the page turn is where you take the wheel.**

---

## 18b. Implementation status (what the app does today)

The code in this repository implements the MVP **and** most of V2, on top of the single-file
architecture in [ARCHITECTURE.md](ARCHITECTURE.md):

| Vision (§)                                   | Status |
| -------------------------------------------- | ------ |
| Seed + optional starting notes (§4)          | ✅ |
| **Pre-writing chat + distilled brief** (§4)  | ✅ chat before the seed; the brief steers titles & every page |
| Titles: 5 at a time, regenerate, edit, all remembered (§5) | ✅ |
| One-page generator: keep / regenerate / tweak (§6) | ✅ |
| **Paragraph & word crafting**: rewrite any paragraph, edit inline, insert, move, delete — each change a remembered version (§6 targeted regeneration) | ✅ |
| **Parallel candidate pages** — generate 2+ at once, pick (§19) | ✅ |
| Version flipping (◀▶, all-versions picker, keyboard) (§6) | ✅ |
| The page turn console: direction, length, tone, suggested beats (§7) | ✅ |
| **Precise page size: words / paragraphs / characters** (§7.2B) | ✅ |
| **Emotion dials** with calibrated structural language (§7.3) | ✅ |
| **Mood map** — per-page chips in the reader + a line in every export (§7.3, §16) | ✅ (printed margin sparkline ⏳) |
| **Standing rules vs. one-shot directions** (§7.2E) | ✅ |
| **"Write it myself"** — author the next page by hand (§7) | ✅ |
| **Turn templates** — save & reuse console setups (§7.4) | ✅ |
| **Proposed endings gallery** — bittersweet / triumphant / twist (§9) | ✅ |
| Chapter breaks / chapter closes (§7.2B) | ✅ |
| **Living cast — people · places · things · open threads**, auto-updated AND fully editable (rename, annotate, character sheets, delete) (§12.1) | ✅ |
| **Open-threads tracker** — promises the book owes the reader (§12.1) | ✅ |
| **Rolling story summary** — compact long-term memory, folded after each page in the background and injected into every prompt, so long books never drift (§12.1) | ✅ |
| **Re-enter from any title** — every proposed title is a doorway on the story map; enter any of them and write (§5) | ✅ |
| **Character sheets** — details per person, injected as canon (§12.1) | ✅ |
| Story spine: walk back/forth through pages, re-enter and fork any moment (§8.3) | ✅ |
| **Story map** — visual tree graph, roads not taken, side-by-side comparison (§8.4) | ✅ |
| **Rename the book anywhere** (§5, §10) | ✅ |
| Endings: bring to a close, iterate, keep branching after The End (§9) | ✅ |
| Compiled book export: **EPUB** + .txt/.md, cast appendix + mood map (§9) | ✅ |
| Library bookshelf: search, duplicate, rename, import/export (§10) | ✅ |
| **About-this-book ledger** — "you wrote 142 words and directed 11,283" (§9) | ✅ |
| **Pin versions** — favorites never lost (§13) | ✅ |
| **Selection rewriting** — rewrite/edit any chosen span, word by word (§6) | ✅ |
| **Time-lapse replay** of the tree (§16) | ✅ |
| **Sequels** — finished book seeds its sequel, inheriting the cast (§16) | ✅ |
| **Reading themes** (dark/sepia/light) + text size (§13) | ✅ |
| **Fast model per phase** (§12.3) | ✅ |
| Read-aloud — voice, speed, bedtime auto-advance (§11) | ✅ (browser voice) |
| **Diegetic document pages** — letters, diary entries, clippings, map notes, recipes (§16) | ✅ |
| **Version diff** — word-level red/green between drafts (§6) | ✅ |
| **Full-text search + shelf sorting** — recent/mood/length/branches (§10) | ✅ |
| **Persistent reading position** (§10) | ✅ |
| **Quote cards** — share a page as a beautiful image (§11) | ✅ |
| **Print-ready PDF** export (§9) | ✅ |
| **Ambient soundscape** keyed to the emotion dials (§16) | ✅ |
| **Editable chapter headings** (§7.2B) | ✅ |
| Illustrations, sharing, co-authoring, print-on-demand (§11, §13, §15) | ⏳ stretch |

-------------------------------------------- | ------ |
| Seed + optional starting notes (§4)          | ✅ |
| Titles: 5 at a time, regenerate, edit, all remembered (§5) | ✅ |
| One-page generator: keep / regenerate / tweak (§6) | ✅ |
| **Paragraph & word crafting**: rewrite any paragraph, edit inline, insert, move, delete — each change a remembered version (§6 targeted regeneration) | ✅ |
| Version flipping (◀▶, all-versions picker, keyboard) (§6) | ✅ |
| The page turn console: direction, length, tone, suggested beats (§7) | ✅ |
| **Emotion dials** with calibrated structural language (§7.3) | ✅ |
| **Standing rules vs. one-shot directions** (§7.2E) | ✅ |
| Chapter breaks / chapter closes (§7.2B) | ✅ |
| **Living cast — people · places · things** up to the current page, on every view (§12.1) | ✅ |
| **Rolling story summary** — the real §12.1 summarizer, maintained in the background and injected everywhere | ✅ |
| Story spine: walk back/forth through pages, re-enter and fork any moment (§8.3) | ✅ |
| **Story map** — the tree as a timeline with roads not taken (§8.4) | ✅ |
| Endings: bring to a close, iterate, keep branching after The End (§9) | ✅ |
| Compiled book export (.txt/.md, cast appendix) (§9) | ✅ |
| Library bookshelf: search, duplicate, import/export (§10) | ✅ |
| Read-aloud (§11) | ✅ (browser voice) |
| Parallel candidate pages (§12.2, §19) | ⏳ |
| Mood map printed in the compiled book (§7.3) | ⏳ (dial chips ship; sparkline deferred) |
| Illustrations, sharing, co-authoring, print-on-demand (§11, §13, §15) | ⏳ stretch |

Everything remembered, everything re-enterable, everything local — that part is not deferred; it is
the foundation the whole app stands on.

---

## 19. Open Questions (to keep brainstorming)

- Should the reader be able to _change_ a past page in place (editing history) or only ever fork?
  (Forking is safer and more poetic — "the past is preserved" — but editing is more convenient.
  Maybe both: edit-in-place with an automatic hidden fork.)
- How many candidate pages should regenerate at once — one, or three in parallel to pick from?
  (Parallel feels more abundant; one-at-a-time feels more deliberate. Offer both.)
- Should the turn be _before_ or _after_ showing a tiny "preview" of possible next beats? (After
  reading, before generating — the suggested-directions feature already does this.)
- Can a page ever be _longer_ than one screen? (Design decision: "page" as a fixed short unit vs.
  "page" as a scrollable card. The fixed short unit is more true to the metaphor.)
- Is the book ever truly "done," or does the tree keep inviting you back? (The tree invites; the
  compiled book says "done." Both are true. Let the user choose which artifact matters to them.)
- What's the perfect number of controls to show at a turn without overwhelming a first-time user?
  (Start with three: direction, length, tone. Reveal the rest behind "more options.")

---

## 20. Closing Thought

The genius of this idea is that it takes the two weakest parts of AI writing — **long-term
coherence** (the AI drifts over thousands of words) and **user steering** (prompts are hard, menus
are easy) — and turns them into strengths by shrinking the unit of creation to a single page and
moving the human's contribution to exactly the moment where a human is most engaged: the page turn.

It's not "an AI that writes books." It's _a book that you and the AI write together, one decision at
a time, forever_.

The story was always going to be a tree. This is just the first tool that lets you walk it.
