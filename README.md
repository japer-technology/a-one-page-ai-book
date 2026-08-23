# The One-Page AI Book

**A generative, interactive reading machine where the reader is the director, the page turn is a creative decision, and every choice is remembered forever.**

---

## 1. The Elevator Pitch

You write one sentence — a seed. The AI writes a book from it. But not a book you read: a book you *direct*.

- It shows you **one page at a time**. Literally one page. No scrolling through a wall of text.
- At every step you have **one job**: decide whether this page is *the* page, and then decide *what happens next*.
- Every title you see, every page you see, every version of every page — **all of it is remembered**, so you can step back in time and re-live, re-enter, and re-branch from any moment.

The book is never "finished" until you say it is. It's a tree, not a line. It's a collaboration, not a generation.

---

## 2. The One-Sentence Thesis

> **A page turn should be a decision, not a gesture.**

A normal book turns the page for you. A normal AI book dumps 10,000 words at you and you hope it's good. This book inverts that: the *turning of the page* is the single most important creative moment in the whole experience, because that's the moment where you — the reader — choose the direction, the mood, the pace, and the ending.

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

1. **Seed.** You type a sentence. *"A lighthouse keeper finds a letter addressed to someone who died a hundred years ago."*
2. **Titles.** The AI proposes, say, five titles. You pick one, or ask for five more. Every single title is saved.
3. **Page 1.** The AI writes page 1. You don't love it. You hit "again." It writes another. And another. The fourth one gives you chills. You keep it.
4. **The Turn.** The page ends mid-scene. The screen now asks: *What happens next?* You say: more dread, shorter pages, and the letter should be from the keeper's own grandfather. You also toggle "don't reveal the letter yet."
5. **Page 2.** Generated with your directions. You iterate until satisfied. Keep it.
6. **The Turn again.** Now you say: longer, warmer, introduce a second character, start hinting at a storm.
7. ...and so on, until at some turn you say **"bring the story to a close."**
8. **The End.** The AI writes a closing page (iterated like any other), and the book is complete. You can read it front to back, or keep branching from any point.

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

**Design principle:** the seed should be *a spark, not a spec*. We don't want users writing a full brief. One line. The AI does the heavy lifting. The heavy lifting of direction comes later, page by page — not up front.

**Optional seed-level settings (kept light, with sensible defaults):**
- Genre (or "surprise me")
- Perspective (first/third/second person, or "decide for me")
- Tense (past/present)
- Tone baseline (warm / dark / funny / literary / pulpy)
- Target audience / content rating (kid-safe, teen, adult)
- Overall length hint ("short story," "novella," "let it run")

But critically: **none of these are locked in.** They are starting defaults, and every one of them can be overridden at any page turn. The seed is the seed, not the contract.

---

## 5. The Title Phase

Before a single page exists, the book needs a name — because the title is also the **entry point** you'll use to come back later.

**The title phase flow:**

1. AI generates N titles (3–7 is a good range; 5 feels right). Each with a one-line flavor note or tagline.
2. The user either:
   - **Picks one** → the book is named, page 1 begins.
   - **Regenerates** → N more titles, *all previous ones remembered*.
   - **Mixes/edits** → maybe the user likes "The Letter at Low Tide" but wants it to be "The Letter at Low Tide: A Story of Salt and Secrets."
   - **Asks for a style** → "titles like old gothic novels," "one-word titles," "titles that sound like a Netflix miniseries."

**Why titles matter more than you'd think:**

- The title is the **save file name**. It's what you'll click on to re-enter.
- A great title *retroactively recontextualizes the story* — picking "The Lighthouse Keeper's Grandson" versus "The Dead Letter" changes how the AI should write page 1. The title becomes a hidden steering signal.
- Titles are cheap to generate and fun to browse. It's a low-stakes warm-up for the bigger decisions to come, and it establishes the rhythm of "generate → choose → keep."

**Every title is remembered.** If you generate 40 titles and pick #37, all 40 live in the book's archive. You can re-enter from *any* of them later — which effectively means you can have 40 parallel versions of the same seed, each branching from a different title.

---

## 6. The Page Phase

This is the "generate until it's good" loop.

**The rules of a page:**

- A page is **short**. Real, physical-page length: roughly 150–400 words. Enough to feel substantial, not enough to lose yourself.
- A page is **self-contained-ish** but hooks forward. It should feel like turning an actual page in a real book — it ends at a natural (or deliberately unnatural) beat.
- A page is **one beat** of story. Maybe one scene fragment, one exchange, one reveal, one image. Not a chapter. A *page*.
- Every page has a **page number** in the final book. The medium is the message: we are *not* a chat window. We are a book.

**The iteration controls on a page:**

- **Keep this page.** The core action. Lock it in.
- **Regenerate.** Same direction, new attempt. Keep or discard.
- **Regenerate with a tweak** (inline, one-line instruction): *"make the keeper's hands shake," "more fog," "end on the letter, not the door."*
- **Regenerate more/less like this** — steering sliders without leaving the page.
- **Roll back to a previous version.** All versions of *this* page are stored, and you can flip between them like flipping through drafts.
- **Edit the page yourself.** Maybe the AI got it 90% right and you just want to change one sentence. The user's edit becomes a new "version" of the page (with attribution: "edited by you").

**A subtle but important point:** regenerating a page should *not* force a full re-roll of everything. We want **targeted regeneration** — keep the parts you like, re-roll the parts you don't. ("Keep the first paragraph, rewrite the ending.") This is the difference between a slot machine and an instrument.

---

## 7. THE PAGE TURN — The Heart of the Whole Thing

This is the feature the entire product is built around. When you lock in a page, the screen doesn't just advance. It *asks you a question*.

> **"The page is written. What happens next?"**

The page turn is a **director's console** for the next page. It's where the reader becomes the author without ever having to write prose.

### 7.1 Why this is the "important part"

- In every other AI writing tool, steering happens either *before* (a big prompt) or *after* (editing/regenerating the output). Here, steering happens **at the natural seams of the story** — at page turns — which is exactly when a human reader is already imagining "what I hope happens next."
- It makes the experience **rhythmic**: read → decide → read → decide. A heartbeat.
- It keeps the user **emotionally invested**: the next page *belongs* to them a little bit, because they set its direction.
- It produces **better stories**: an AI writing a whole novel drifts; an AI writing *one page* in response to *one focused direction* stays sharp.
- It solves the blank-page problem: the user never has to write "continue the story with more tension but also..." — they get a menu, sliders, and chips instead of a cursor.

### 7.2 The parameter catalog

The turn offers a rich but *organized* set of controls. Not all at once (that's overwhelming) — grouped, with the most important first, and everything collapsible.

#### A. Story direction (the big lever)

- **What happens next** (free-text): the "story idea" box. *"The letter is from his grandfather."* *"The storm hits the island."* *"A stranger arrives by boat."*
- **Suggested directions**: the AI itself proposes 3–5 concrete "next beat" options based on the story so far ("The keeper opens the letter that night," "A fog rolls in and the light fails," "He discovers the letter is addressed to *him*"). The user picks one, or writes their own. This is the "choose your own adventure" moment, but instead of choosing a fixed path, you're choosing a *direction* that the AI will then write *fresh*.
- **Introduce a character** / **remove a character** / **focus on X**.
- **Reveal** something / **conceal** something (control over information).
- **Flashback / flash-forward** / **stay in the present**.
- **Change location** / **stay put**.

#### B. Structure and pacing

- **More words per page / fewer words per page** (a slider, or "short page / standard / long page").
- **Pace**: slow and meditative vs. propulsive.
- **Start a new chapter** (chapter break: the next page is the first page of a new chapter, with its own chapter heading and possibly a new title).
- **Bring this chapter to a close** (the AI knows it should wrap the current thread in the next page or two, landing on a chapter-ending beat).
- **Bring the story to a close** (the AI moves toward an ending — see Section 9).
- **Cliffhanger** (end the page on a hook) vs. **resting point** (end on a moment of calm).
- **Time jump** (next page skips forward hours/days/years).
- **Parallel scene** (cut to what's happening elsewhere).

#### C. Tone and voice

- **Overall tone**: warmer, colder, darker, lighter, funnier, more serious, more poetic, more plain.
- **Emotion dials** (this is the "more/less of each emotion" idea, and it deserves its own treatment — Section 7.3).
- **Voice**: more literary vs. more conversational; first-person internal monologue vs. cinematic third person; sparse vs. lush.
- **Dialogue vs. description** ratio.
- **Humor level, horror level, romance level, wonder level** — as independent axes, not a single "tone" knob.

#### D. Content and safety

- **Intensity caps**: violence, sex, profanity, horror — up/down (respecting the content rating set at seed time).
- **"Keep it kid-safe"** one-tap override.

#### E. "Don't touch" (negative space)

Just as important as what to do: **what NOT to do**.
- "Don't resolve the letter yet."
- "Don't introduce a love interest."
- "Don't kill anyone."
- "Don't leave the island."
- "Keep the story in the past tense."
- "Don't change the point-of-view character."

These are **standing constraints** (they persist until removed) vs. **one-shot directions** (apply to the next page only). This distinction is crucial: some instructions are for *this page*, some are for *the rest of the book*.

### 7.3 The Emotion Dials (a deeper look)

The user specifically imagined "more/less of each emotion." This is one of the most evocative controls in the product, so let's brainstorm it properly.

A panel of emotion sliders, each from −3 to +3 (or 0 to 10), where the default is "inherit / balanced":

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

And maybe a **valence** dial (overall positive↔negative) and an **arousal** dial (calm↔intense) — borrowing from psychology's affect circumplex to keep it elegant instead of an endless list.

**Design considerations:**

- Default is always "inherit the current mood" — the story's emotional state carries forward *unless* you touch a dial.
- Dial changes should be **gradual** by default: asking for "+dread" shouldn't jump-cut to a monster; it should *tilt* the next page slightly darker, letting dread build. (Optionally a "sudden shift" toggle for when you *do* want a jump-scare of tone.)
- The dials should be **visible in the final book** as a mood map — a little sparkline of emotional temperature over the pages. ("This is where it gets scary," literally visualized.)
- Micro-interactions: hovering a dial could show a one-word description ("current: bittersweet" / "next: ominous").

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

- **No blank cursor required.** You can hit "Generate next page" with *zero* inputs and it continues smoothly — but the controls are there, inviting you to steer.
- **Defaults are smart.** "Continue naturally" is always a one-tap option.
- **The turn is skippable but never hidden.** Even "continue naturally" is a choice you made.
- **Feedback is immediate.** The next page appears, and if it misses your direction, the page-phase iteration loop is right there to catch it.

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

Every node (seed, title, page, turn) is addressable and re-enterable. The tree is the product's **most valuable asset**: it's a complete record of the reader's creative journey, not just the final artifact.

### 8.3 Reentry

From the library screen, you can click **any title** and land back at that branch's current frontier — not the beginning, the *frontier* (wherever you last were, mid-story). But you can also:

- **Step back** to any earlier page and **fork**: choose a different direction at an old turn, and the new pages become a *new branch* while the old pages remain intact.
- **Re-roll an old page** without disturbing anything downstream — the new version becomes a new child branch automatically (because changing page 3 invalidates pages 4+, but those pages are *kept*, not destroyed).
- **Duplicate** a branch to experiment.
- **Compare** two branches side by side ("what if she opened the letter vs. what if she burned it?").

### 8.4 The Archive view

A dedicated view that shows the whole tree visually:

- A **timeline/graph** of pages and turns.
- Each node is a thumbnail of the page (or a title).
- Chosen paths are bright; unchosen paths are ghosted but still clickable.
- Page-turn decisions are annotated on the edges ("+dread, introduce a stranger").
- A **"read the road not taken"** feature — browse discarded versions as a gallery.

This is the feature that makes the product feel *alive* long after the first session: your book is a garden of possibilities, not a single path.

---

## 9. Ending the Story

Endings are a special case of the page turn, important enough to call out.

**Ways to end:**

- **"Bring the story to a close"** at a turn → the AI knows the next page (or next few pages) should move toward resolution, and it will signal when a natural ending is near.
- **"End it here"** → the current page is the last page; the AI optionally appends a short coda/epilogue.
- **"Write an ending"** → the AI proposes 3–5 *possible endings* (bittersweet, triumphant, ambiguous, twist, open-ended), the user picks or iterates — same rhythm as titles, but for the finale.
- **"This is the last chapter"** → the AI paces the remaining pages to land the ending by the chapter's end.

**The ending must be iterable like any page.** A bad ending ruins a good book, so the "generate until satisfied" loop applies with full force — endings are the pages worth the most iterations.

**After the end:**

- The book compiles into a **clean, linear, readable version** (the chosen path) — exportable as a nicely typeset page-by-page book (EPUB/PDF/plain text), complete with chapter headings, a title page, and the mood map.
- The **tree remains** — the compiled book is just *one* path through it; you can always return and fork.
- An **"About this book"** page: the seed, the title, the number of pages, the number of versions, the decisions made, the total words generated vs. kept (a fun stat: "you wrote 142 words and directed 11,283").

---

## 10. The Library (your bookshelf)

A home screen that feels like a bookshelf, not a file manager:

- Each **title** is a book spine on a shelf.
- Completed books look "bound"; in-progress books look "open" (or "dog-eared").
- Clicking a spine enters at the frontier; a small "..." menu offers: read the compiled version, open the archive/tree, fork, rename, export, delete.
- **Sorting**: recent, by mood, by length, by "most branched."
- **Search**: across seeds, titles, and even page text.

The emotional payoff: this shelf fills up with *your* books — books that literally could not exist without your decisions. That's a strong retention loop.

---

## 11. Sharing and Social (brainstormed, optional)

- **Share a page** as a beautiful quote card (typography-first).
- **Share a "choose the next direction" prompt** to friends — they vote on what happens next, you write the result. (A collaborative book.)
- **Publish the compiled book** to a public gallery with its decision history attached.
- **"Fork someone else's book"** — take a public seed (or even a public tree) and write your own version from any node.
- **Co-authoring**: two people at one page turn, both steering, alternating decisions.
- **Read-aloud mode** with a voice, so the "one page at a time" rhythm becomes a bedtime-story experience for kids.

---

## 12. Technical Architecture (sketch)

### 12.1 Core services

- **Generation engine**: a capable LLM, with a *strong* system prompt that enforces: one page, ~150–400 words, ends on a beat, respects the direction + standing rules + emotion dials. Context = the seed + title + all chosen pages so far + the current turn's parameters + standing constraints + the story's summary.
- **Story state / summarizer**: as the book grows, a rolling summary (plus character bible, plot threads, tone state) is maintained so the model always has compact context. The full chosen-path text is also included, up to the context limit.
- **Tree store**: a versioned graph database (or a document store with parent/child links and content-addressed nodes). Immutable nodes; branches are cheap pointers.
- **Metadata layer**: each node carries its generation parameters, timestamps, model version, and the user's decisions — this is what makes reentry and the archive possible.
- **Prompt assembly**: the turn parameters compile into a structured generation prompt (not just free text) — sliders map to calibrated instruction language ("dread: +2" → "slightly heightened dread, creeping unease, nothing overt").

### 12.2 Interesting technical challenges

- **Long-context memory**: a 50-page book is fine; a 500-page book needs summarization + retrieval. The character bible and "open threads" list are key.
- **Consistency**: names, facts, tone, and callbacks must hold across regenerations and branches. Each chosen page should update the story bible.
- **Targeted regeneration**: re-rolling "just the ending of this page" requires the model to treat prior paragraphs as fixed context.
- **Standing rules**: persistent constraints must be injected every generation and never silently dropped.
- **Emotion dials → prose**: mapping numeric dials to actual narrative choices (not just "make it scarier" adjectives, but *structural* choices: shorter sentences, withheld information, darker imagery).
- **Branch explosion**: the tree can get huge; the UI needs to collapse/ghost old branches and the store needs cheap fork semantics.
- **Cost/latency**: page generation should feel *fast* (streaming), and regeneration of many candidates can be parallelized.

### 12.3 Model-agnostic

The product should treat the model as a swappable engine (this matters as models improve). The tree, the parameters, the archive — none of that depends on any single model. A book started on model A can continue on model B (metadata records which model wrote each page).

---

## 13. Edge Cases & Design Questions (the hard parts, brainstormed honestly)

- **What if the user regenerates page 1 after 50 pages exist?** Answer: it becomes a new branch. Pages 2–50 are preserved on the original branch; nothing is destroyed. The UI must make this feel safe, not scary ("forking a new branch").
- **What if the user's direction contradicts the story so far?** ("Make her a doctor" when she's established as a lighthouse keeper.) The AI should either adapt gracefully (maybe a plot justification) or flag it ("heads up: this conflicts with page 7 — do you want to reconcile it or fork?").
- **What if a page is "too good" to lose but the user keeps regenerating?** Always keep the last N versions visible, with a "pin this version" option, so "keep the third one" is trivially possible.
- **How long is a page, really?** Physical-page metaphor suggests short; but some users want "a page = a scene." Make it a per-book setting.
- **Does the reader see the turn controls before or after reading the page?** After (you must read before you direct). But the page should *end* with a subtle hook that makes you want to direct.
- **What about illustrations?** Optional: an "illustrate this page" toggle (AI-generated image per page), making it a picture book / graphic novel hybrid. The illustration can also be regenerated like text. (This is a strong stretch feature.)
- **Offline/export**: the compiled book is always exportable, so the product never holds your story hostage.
- **Ownership**: who owns the tree? The user does. Full export of the raw tree (JSON) should be a first-class feature.
- **Accessibility**: the one-page-at-a-time format is naturally good for focus and for screen readers; read-aloud and high-contrast modes are natural fits.
- **Kids mode**: a simplified turn console (just emoji mood buttons + "what happens next" with picture options) turns this into a family co-storytelling toy.
- **Does "regenerate" feel like gambling?** Guardrails: keep all versions, always allow going back, and let the user *nudge* rather than re-roll blindly, so it feels like craft, not a slot machine.

---

## 14. Why People Will Love It (the psychology)

- **Agency without skill.** You feel like an author without facing the blank page. The AI writes; you *direct*. Directing is easier and more fun than writing.
- **Perfect attention span.** One page at a time = no overwhelming wall of text, no "I'll finish it later." It's snackable and focus-friendly at once.
- **Endless, but bounded.** Infinite possibilities, but always *one clear next action*. No paralysis.
- **Ownership.** Because you chose at every turn, the book is *yours* in a way a one-shot generated novel can never be.
- **Replayability.** The same seed is a different book every time — and the tree *shows* you that.
- **The joy of the seam.** The page-turn question mirrors the best moment of reading any book: closing the page and thinking, "I hope X happens." Here, that thought *changes the story*.

---

## 15. Monetization & Product Shape (brainstormed)

- **Free tier**: limited seeds/books, N regenerations per page, standard export.
- **Paid**: unlimited trees, all parameter controls, illustration mode, advanced export (EPUB/PDF/typeset), long books, priority models.
- **A la carte / credits**: per-page, per-branch, or per-illustration.
- **Gift**: buy someone a "custom book" — you write the seed, they direct the pages.
- **Merch-adjacent**: print-on-demand of the compiled book (a real physical artifact of a digital journey).
- **Model-agnostic subscription**: the product sells the *experience* (the tree, the turn console, the archive), not the tokens.

---

## 16. Stretch Ideas / Moonshots

- **Voice-directed page turns**: speak your direction aloud at each turn ("make it scarier, and he should hear footsteps").
- **Ambient soundtrack** per page, keyed to the emotion dials.
- **A "mood map" that's actually beautiful**: the compiled book includes a page-by-page emotional graph, printed in the margins.
- **Multimedia pages**: some pages could be letters, maps, diary entries, newspaper clippings, recipes — diegetic documents rendered as images. (The lighthouse letter *is* the page.)
- **Multi-book sagas**: a completed book becomes the seed for its sequel, inheriting the character bible.
- **"Living book" mode**: the book never ends; it keeps generating pages as a serial, like a never-ending soap opera you direct weekly.
- **Choose-what-they-chose**: a "read mode" where you watch the tree replay itself — a time-lapse of someone else's creative journey.
- **Style imprints**: "write like" a chosen authorial flavor (with appropriate care around living authors).

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

- *"The book you write by turning the page."*
- *"One page. Your call."*
- *"Write by deciding."*
- *"Every page turn is a plot twist."*
- *"You bring the spark. The story branches from there."*
- *"A book that remembers every version of itself."*

---

## 18. The MVP vs. The Dream

**MVP (the smallest thing that's still this idea):**

1. Seed input → 5 titles → pick one.
2. Page generator with "keep / regenerate / regenerate with a tweak."
3. A simple page-turn panel: free-text direction + "more/less words" + "darker/lighter" + "continue naturally."
4. Everything remembered: a flat history of every title and every page version, re-enterable from the title.
5. "Bring the story to a close" at the turn.
6. Export the chosen path as clean text.

**V2:**

- Emotion dials.
- Suggested directions (the AI proposing next beats).
- The tree/archive visual view, forking.
- Standing rules vs. one-shot directions.

**V3+:**

- Illustrations, mood map, read-aloud, sharing/forking, print-on-demand, multi-model support, collaborative books.

The MVP already contains the soul of the thing: **one page at a time, generate until it's good, and the page turn is where you take the wheel.**

---

## 19. Open Questions (to keep brainstorming)

- Should the reader be able to *change* a past page in place (editing history) or only ever fork? (Forking is safer and more poetic — "the past is preserved" — but editing is more convenient. Maybe both: edit-in-place with an automatic hidden fork.)
- How many candidate pages should regenerate at once — one, or three in parallel to pick from? (Parallel feels more abundant; one-at-a-time feels more deliberate. Offer both.)
- Should the turn be *before* or *after* showing a tiny "preview" of possible next beats? (After reading, before generating — the suggested-directions feature already does this.)
- Can a page ever be *longer* than one screen? (Design decision: "page" as a fixed short unit vs. "page" as a scrollable card. The fixed short unit is more true to the metaphor.)
- Is the book ever truly "done," or does the tree keep inviting you back? (The tree invites; the compiled book says "done." Both are true. Let the user choose which artifact matters to them.)
- What's the perfect number of controls to show at a turn without overwhelming a first-time user? (Start with three: direction, length, tone. Reveal the rest behind "more options.")

---

## 20. Closing Thought

The genius of this idea is that it takes the two weakest parts of AI writing — **long-term coherence** (the AI drifts over thousands of words) and **user steering** (prompts are hard, menus are easy) — and turns them into strengths by shrinking the unit of creation to a single page and moving the human's contribution to exactly the moment where a human is most engaged: the page turn.

It's not "an AI that writes books." It's *a book that you and the AI write together, one decision at a time, forever*.

The story was always going to be a tree. This is just the first tool that lets you walk it.
