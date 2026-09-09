# The Art of the Page Turn

**How to author with Page Turn — the one-page AI book. The complete guide to the craft: every
control, every option, and the practices that separate a generated story from a book you directed.**

> Companion reading: [PRODUCT.md](PRODUCT.md) (the vision) · [ARCHITECTURE.md](ARCHITECTURE.md) (the
> engineering) · [NEW-FEATURES.md](NEW-FEATURES.md) (the living backlog). Everything described here
> **ships today** — roadmap ideas are labeled and pointed at [NEXT.md](NEXT.md).

---

## 1. What it is to author here

Page Turn is not "an AI that writes books." It is a book that you and a local language model write
together, **one page at a time, one decision at a time, forever**. You hold two roles:

- **The model is the prose engine.** It writes exactly one page per request — one beat of story,
  roughly 90–600 words, self-contained but hooked forward. It never dumps a novel on you.
- **You are the director.** You never face a blank page. You face a question: _"The page is written.
  What happens next?"_ — and everything you answer is a creative decision the book remembers.

Three facts shape every practice in this guide:

1. **The page turn is the product.** Steering happens at the natural seams of the story — exactly
   when a reader is already thinking "I hope X happens next." That thought, here, changes the story.
2. **Everything is remembered.** Every title proposed, every page version discarded, every turn
   decision, every branch. The book is a **tree**, not a line; the finished book is just one
   compiled path through it. Nothing you do can destroy earlier work.
3. **Everything is local.** Your words travel only to the LLM endpoint _you_ configure — a local
   server, a machine on your network, or a key-protected API. No account, no cloud, no telemetry.
   The whole app is one HTML file that reads and writes real files on your disk.

---

## 2. The journey, at a glance

Every book walks the same loop. You can leave and re-enter at any step, from any branch.

1. **Setup** — Settings → scan for local LLMs (or type a URL), pick a model, optionally assign a
   fast model for the cheap phases.
2. **The chat (optional)** — talk the book into existence with the writing partner, then distill the
   conversation into a **brief** that rides into every page.
3. **The seed** — one line. A spark, not a spec. Optional starting notes, nothing locked in.
4. **Titles** — five at a time; browse, regenerate, edit, pick. Every one is remembered.
5. **Page one's turn** — the same director's console as every later turn: how does page one begin?
6. **The page workshop** — generate until it's good: regenerate, tweak, rewrite paragraphs, edit
   word by word, flip versions, pin, diff.
7. **The page turn** — the heartbeat: read → decide → read → decide. Zero inputs is a decision.
8. **The cast and memory** — quietly maintained after every page; curated by you whenever you like.
9. **The End** — when _you_ decide. Iterated like any page, worth the most iterations.
10. **After the book** — read it, export it, write the prologue that knew, take the Director's
    Portrait, seed the sequel, or keep branching.

---

## 3. Before the first page

### 3.1 The seed — a spark, not a spec

The seed is one line. The design principle is deliberate: the AI does the heavy lifting up front;
the heavy lifting of _direction_ comes later, page by page, where it belongs. All of these count:

- A sentence: _"A lighthouse keeper finds a letter addressed to someone who died a hundred years
  ago."_
- A premise fragment: _"cyberpunk whodunit in a space elevator."_
- A genre plus a twist: _"gothic romance, but the house is also the villain."_
- A vibe: _"cozy, melancholic, small town, autumn."_
- A character: _"an immortal librarian who is allergic to books."_
- Pasted text the model should continue in its own voice.
- A question: _"what if dogs could file taxes?"_ · A mashup: _"Jane Austen meets Blade Runner."_
- Nothing at all — 🎲 **I'm feeling lucky** rolls a seed from a built-in list of twelve.

The seed input even says it: **a sentence, a vibe, a mashup, a question — anything.**

### 3.2 Optional starting notes

A fold-out under the seed offers light defaults. **None of these are locked in** — every one can be
overridden at any page turn. The seed is the seed, not the contract.

| Note          | Options (exact values)                                                                                                                 | What it does                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Genre         | free text + suggestions (gothic romance, cozy mystery, space opera, literary fiction, noir, fairytale, slice of life, western, horror) | flavors titles and pages; "surprise me" is a valid choice  |
| Perspective   | decide for me · first person · third person · second person                                                                            | sets the narrator's seat; switchable later at any turn     |
| Tense         | decide for me · past · present                                                                                                         | sets the temporal frame                                    |
| Tone baseline | decide for me · warm · dark · funny · literary · pulpy                                                                                 | the starting temperature the tone control later tilts from |
| Audience      | adult · kid-safe · teen                                                                                                                | content-rating floor                                       |
| Length hint   | let it run · short story · novella                                                                                                     | a gentle pacing expectation for the model                  |

### 3.3 The pre-writing chat and the brief

Before the seed, you can **talk the book into existence**. The writing partner is warm, sharp, and
curious — it asks one good question at a time, offers concrete ideas (protagonist, setting,
conflict, genre, tone, ending vibe), never drafts prose for you, and keeps every reply under 70
words. This is where a book's personality gets decided before a single page exists.

When the conversation has covered enough, press **✨ Distill into a brief**: the model condenses the
whole chat into a story brief of at most 140 words — protagonist and their want, setting,
genre/tone, central conflict, and everything you explicitly want or don't want. You can **edit the
brief** before you begin, and it rides into:

- the title proposals,
- **every page generation**,
- every paragraph rewrite, insert, and span rewrite,
- next-beat suggestions, the endings gallery, the conflict checker,
- the cast and summary updaters.

> **Best practice — negative space lives in the brief.** The brief is the one input that persists
> untouched through the whole book. Anything you never want to re-state — "no love triangles", "the
> lighthouse is never explained", "keep the dog alive" — belongs in the brief, not in your per-page
> directions. Standing rules (§6.9) are for constraints that may change; the brief is for what the
> book _is_. Same mechanism, different half-life.

---

## 4. The title phase — the doorway

After the seed, the model proposes **five titles at a time**, each with a one-line tagline. You can:

- **pick one** (click a card, then _✔ Use this title →_),
- **edit any title** in place before using it — "The Letter at Low Tide" becomes "The Letter at Low
  Tide: A Story of Salt and Secrets",
- **🎲 Propose 5 more** — as often as you like. **Every title is remembered**, so forty proposals
  are forty potential books.

Titles matter more than decoration:

- The title is the **save-file name** — what you click to re-enter the book.
- The title **retroactively steers the story** — the title prompt tells the model to make each one
  "a distinct, evocative doorway," and page 1 is written under the title you chose. "The Dead
  Letter" and "The Keeper's Grandson" are different books.
- Every proposed title lives on the story map as a **doorway**: later, you can enter any unchosen
  title and write a parallel book from it, branch intact (§9.4).

> **Best practice — title toward the book you want.** Browse until one makes you feel something,
> don't just take the first batch. A great title is a promise; you will spend the whole book keeping
> it. Regenerating is cheap and everything stays remembered, so shop like it costs nothing — because
> it does.

Page one deserves a turn too: after the title, the full director's console opens and asks _"How does
page one begin?"_

## 5. The page workshop — generate until it's good

Every page is a workshop. The core loop: **keep / regenerate / regenerate with a tweak**.

- **Keep this page.** The core action — locks the page in and moves you to the turn.
- **Regenerate.** Same direction, a fresh attempt. All versions stay kept below.
- **Regenerate with a tweak.** One inline line — "make her hands shake", "more fog", "end on the
  letter, not the door" — and the model re-rolls the page under it.
- **🎲 Generate 2 more versions.** Parallel candidates: the model writes two alternatives at once;
  keep the one you love. For decisive moments (first pages, reveals, endings) this is the most
  economical way to buy options.

### 5.1 Versions — your drafts, alive forever

Every attempt at a page becomes a **version**, and versions are first-class citizens:

- Flip through versions with ◀ ▶ buttons, the all-versions picker, or **shift+← / shift+→**.
- **Pin** a version — favorites sort first and can never be lost in the shuffle. "Keep the third
  one" is always trivially possible.
- **Diff any two versions** — word-level red/green, so you can see exactly what a tweak changed.
- **Undo** sits under the page after every craft commit; one step back, no penalty.

Every version records who wrote it (ai / you), when, and which model — attribution follows the words
forever, into the About ledger and the statistics.

### 5.2 Paragraph and word crafting

Hover any paragraph for the toolbar:

- **↻ Rewrite** — the model rewrites that paragraph in place, streaming, with the full book context
  (brief, cast, summary, standing rules) so it sits seamlessly in its page.
- **✎ Edit** — change it word by word, by hand.
- **＋ Insert** — a new paragraph before or after, written by the model or typed by you.
- **↑ ↓ Move** · **✕ Delete** — restructure the page.

Select **any span of text** — a sentence, a clause, one word — and a floating toolbar offers ↻
rewrite / ✎ edit for exactly that span. This is targeted regeneration made real: keep the 90% you
love, re-roll the 10% you don't. Every change — model or hand — becomes a new remembered version.

Chapter headings are editable in place too: rename the AI's chapter titles whenever they don't sing.

### 5.3 The story linter

A no-model metrics pass over the compiled book, visible in **About this book**: repetition
(n-grams), adverb ratio, sentence-length variance, dialogue density, and cliffhanger cadence. It
smells what the eye skims — use it as an edit list, then fix pages with span rewrites.

### 5.4 The forking warning

If a page already has a path growing from it (you kept it long ago, then came back), the page view
tells you plainly: **keeping or tweaking here forks a new branch — the existing path stays intact**.
Nothing is ever destroyed; the old road remains on the story map (§9).

> **Best practice — iteration discipline.** Regenerating blindly is a slot machine; directing is
> craft. The rhythm that works: read the page → name _one_ thing wrong with it → fix exactly that
> (tweak, span rewrite, paragraph rewrite) → keep. Full re-rolls are for when the page's whole
> premise missed; parallel candidates are for moments you can't afford to get wrong. Pin the keepers
> as you go so the good ones never drown in the shuffle.

---

## 6. The page turn — the director's console

After every kept page, the console asks: **"The page is written. What happens next?"** The last page
stays on screen, dimmed, above the panel. Every control below is real and shipped. The turn is
deliberately one screen: grouped, collapsible, with the big lever first.

### 6.1 Direction (free text) + quick nudges

**What happens next?** — a free-text box. A one-liner is plenty, or nothing at all. Eight one-tap
**nudge presets** append micro-directions:

| Nudge                             | Effect                                        |
| --------------------------------- | --------------------------------------------- |
| end on dialogue                   | the page's last beat is spoken, not narrated  |
| add sensory detail                | the scene gains texture — sound, light, smell |
| show, don't tell                  | dramatize; cut exposition                     |
| raise the stakes                  | what's at risk gets riskier                   |
| a moment of calm                  | a breath before what comes next               |
| reveal a secret                   | information the story has withheld surfaces   |
| let a character change their mind | an internal turn, not a plot turn             |
| cut to a new location             | the page opens somewhere else                 |

Nudges append to whatever direction you've typed, so "she finds the boat — add sensory detail" is
one click away.

### 6.2 ✨ Suggest directions — the model's own next beats

Press **✨ Suggest directions** and the model proposes **three concrete next beats**, each one short
sentence grounded in what's established, and deliberately different in kind. Step through them with
◀ ▶, or click any chip to fill the direction box. Each suggestion carries a **👻 ghost button**:

> **What-if ghost previews** — the model writes a full page for that direction _without committing
> anything_. Read it, then **🌿 Adopt as a branch** (it becomes a real turn + page on the tree) or
> **✕ Let it dissolve** (it vanishes without a trace). This is the cheapest way in the whole app to
> audition a risky direction. Settings can auto-suggest beats at every turn without being asked.

### 6.3 Page length — presets or a precise target

| Preset                 | What the model is told                          |
| ---------------------- | ----------------------------------------------- |
| ¶ one paragraph        | exactly 1 paragraph, one beat each              |
| ¶ two–three paragraphs | exactly 3 paragraphs                            |
| shorter                | 90–170 words — economy is the point             |
| standard               | 150–400 words — the physical-page default       |
| longer                 | 300–600 words — room to breathe, still one beat |

Or choose **custom…** and set an exact target in **words, paragraphs, or characters** (any number up
to 200,000). The prompt calibrates: a character target is translated to a rough word count; a word
target to a paragraph range. Precise sizing is how you pace a long book — 90-word staccato pages for
a chase, 500-word meditations for the aftermath.

### 6.4 Tone

Nine options, each compiling to structural instruction — not an adjective sprinkled on top:

| Tone         | What the model is told to do                                 |
| ------------ | ------------------------------------------------------------ |
| inherit      | keep the established tone exactly                            |
| darker       | withhold information, shorten sentences, let unease creep in |
| lighter      | more air, more hope, small human moments                     |
| warmer       | tenderness between characters, emotional generosity          |
| colder       | emotional distance, restraint, show less                     |
| funnier      | sharper dialogue, drier observations, comic timing           |
| more serious | weightier diction, higher stakes, prose that means it        |
| more poetic  | richer imagery, rhythm, figuration — never at clarity's cost |
| more plain   | shorter words, simpler sentences, transparent prose          |

### 6.5 The emotion dials — structural, not adjectival

Ten dials, each **−3 … +3**, where **0 = inherit the current mood**. This is the control that
deserves the deepest respect, because it's the most misunderstood. The dials are:

| Dial       | + means                                      | − means                                 |
| ---------- | -------------------------------------------- | --------------------------------------- |
| 🕯️ Tension | suspense: withhold, delay, taut images       | release: resolve, breathe, calmer beats |
| ✨ Wonder  | awe: beauty, scale, a wider world            | grounded, mundane, ordinary             |
| 🤍 Warmth  | tenderness: small kindnesses, softer details | distance, restraint, keep to themselves |
| 🕳️ Dread   | creeping unease, wrongness, implication      | defuse: safety and steadiness return    |
| 😏 Humor   | wit: sharper dialogue, drier observation     | play it straight, no comic relief       |
| 🌧️ Sadness | melancholy: loss, longing, quiet grief       | lift: lean on hope and forward motion   |
| 🖤 Romance | longing: glances, charged proximity          | keep romance out entirely               |
| ☀️ Joy     | delight: earned happiness, small victories   | sober, restrained, no celebration       |
| ❓ Mystery | curiosity: new questions, half-seen patterns | answer: clarify, close loops, explain   |
| ⚠️ Menace  | danger with teeth, stakes that bite          | defuse the threat; the peril recedes    |

The **magnitude ladder** is everything: ±1 = _slightly_, ±2 = _clearly_, ±3 = _strongly_. The dial
compiles to instruction language about **narrative choices** — sentence length, withheld
information, imagery, what the page ends on — never to "make it scarier" adjectives. **Reset dials**
returns everything to inherit; the summary line shows how many dials you've touched. The dials are
visible forever after, as **mood chips** in the reader, the mood-map line in About, the mood line in
exports — and as the signal that retunes the ambient soundscape per page (§12.4).

> **Best practice — dials are tilts, not jumps.** There is no sudden-shift toggle (it's on the
> roadmap): +3 dread tilts the next page strongly darker — it does not jump-cut to a monster. Mood,
> like music, is built in gradients. If you want a jump, say it in words: "the storm hits _this_
> page." And because 0 = inherit, a book's emotional state carries forward automatically; touch
> dials only where the story should bend.

### 6.6 Chapter structure

| Intent                          | What happens                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| no chapter break                | the page continues the current chapter                                                            |
| ⧉ start a new chapter           | the page opens with a chapter heading on its own line ("Chapter Three — A Short Evocative Title") |
| ↘ bring this chapter to a close | the page lands the current thread on a chapter-ending beat                                        |

Chapter headings stay editable in the page view (§5.2).

### 6.7 Page format — the document wardrobe

Six diegetic formats; the page _is_ the document:

| Format                  | The page is written as                                             |
| ----------------------- | ------------------------------------------------------------------ |
| 📄 story page           | normal prose — the default                                         |
| ✉️ a letter             | salutation ("Dearest Mara,"), body in the writer's voice, sign-off |
| 📓 a diary entry        | date line, first-person reflection, intimate and unpolished        |
| 📰 a newspaper clipping | headline in capitals, byline, short factual paragraphs             |
| 🗺️ map marginalia       | terse field notes tied to places, fragments, arrows of thought     |
| 🍲 a recipe             | title, ingredients, numbered steps, a personal note at the end     |

Each format has its own typography — the **document wardrobe** in Settings assigns a font per format
(or "auto" to inherit the reading font). The lighthouse letter _is_ the page.

### 6.8 Pace and page ending

- **Pace** — inherit · 🐌 slow & meditative (linger on detail and interiority, longer sentences) ·
  ⚡ propulsive (short sentences, forward motion, cut to the chase).
- **Page ending** — inherit · ⛰ cliffhanger (a hook that demands the next page) · 🌙 resting point
  (a completed beat, a breath).

Together with page length they set the book's metronome: long + slow + resting for meditation,
short + propulsive + cliffhanger for a thriller's pull.

### 6.9 Standing rules — "don't touch"

Just as important as what to do: **what NOT to do**. Rules persist for the rest of the book until
you remove them, and the prompt warns the model to _never silently drop them_. Eight presets seed
the list: don't reveal the letter yet · don't introduce a love interest · don't kill anyone · don't
leave the island · keep the story in the past tense · don't change the point-of-view character ·
don't resolve the mystery too fast · don't reveal the stranger's name. Add your own, remove any with
✕.

> **Best practice — know your two kinds of negative space.** Standing rules are for constraints with
> a shelf life ("don't reveal the letter _yet_" — you'll delete it the page after the reveal). The
> brief (§3.3) is for permanent ones. The free-text direction is one-shot: it applies to exactly the
> next page. Using each for its right half-life keeps the model from being handcuffed by stale
> instructions.

### 6.10 🔍 Check this direction

Before committing a risky turn, press **🔍 Check this direction**. The fast model reads the
established story and reports concrete contradictions — "She is established as the keeper's
daughter, not a stranger" — or gives a green _✓ No conflicts found_. It's a heads-up, not a judge:
you can proceed anyway, and sometimes the best stories come from contradictions the model catches
and you choose to keep.

### 6.11 Turn templates and sticky settings

- **💾 Save this setup** — the current console state (minus the one-shot direction) becomes a named
  **template** — a reusable mood recipe. Apply any template at any turn.
- **Sticky per book**: page size, tone, dials, pace, page ending, chapter, and format **persist
  across turns** until you change them. The free-text direction never sticks.
- **Continue naturally** is an explicit choice of defaults — it also **resets the sticky** settings.
  Zero inputs is still a decision, and it means "let the story carry itself for a page."

### 6.12 ✍️ I'll write it myself

Skip the model entirely: open a blank page and author the next beat by hand. The page enters the
tree like any other — with a turn node recording your console settings — and its words are
attributed to you in every version, export, and statistic. Some of the best books on this shelf are
hybrids: the model drafts, the human writes the pages that matter most.

---

## 7. How your decisions reach the model

Understanding the plumbing makes you a better director, because you'll know exactly what the model
can see when it writes.

Every page generation assembles, in order:

1. A **system prompt** with hard rules: exactly one page per request (one beat, never a chapter);
   output only the page text; end on a deliberate beat; respect every direction as structural, not
   cosmetic; stay ruthlessly consistent with names, facts, tone, tense, and POV; never recap or
   moralize.
2. **The fixed blocks** — book title, seed, the brief (if any), the cast (if any), the rolling
   summary (if any).
3. **The story so far** — verbatim recent chosen pages, oldest first.
4. **The page number**, then the **direction block**: everything you set at the turn, compiled to
   calibrated instruction language, then the standing rules.

Paragraph rewrites, inserts, span rewrites, suggestions, the endings gallery, and the conflict
checker all receive the same fixed blocks plus their own scoped instructions — so a one-word edit in
page 30 still knows the whole book.

### 7.1 The context budget — and why it shapes your craft

The generation context has a hard budget of **2,600 words**. It is spent in this order:

- the fixed blocks are **sized first** (seed + title + brief + cast + summary + the last direction),
- whatever remains buys **verbatim recent pages**, with a floor of 500 words guaranteed for them,
- the **rolling summary replaces the oldest pages**, never the recent ones.

So a long book's model sees: everything that matters (condensed) + the last several pages (verbatim)
— two-tier memory. The cast bible update reads up to 2,200 words of recent pages; the summary folds
~300 words of everything; the cast is capped at 12 people, 8 places, 10 things, 12 open threads, 14
relationships.

**What this means for authoring:**

- **Keep pages tight.** Every bloated page crowds out an older verbatim page. The 150–400-word
  standard isn't just aesthetics; it's memory economics.
- **The summary is the book's long-term memory.** Keep "rolling story summary" on in Settings for
  any book that will outgrow ~15 pages; check the 🧠 Story memory panel now and then — it shows the
  exact memory the next page will inherit and lets you refresh it by hand.
- **The cast is the book's fact-checker.** Curated names are injected as canon with instruction to
  use exactly those spellings. A minute spent curating saves pages of drift.

---

## 8. Cast, memory & the world

Books die of drift. Page Turn's answer is two quiet workers that run in the background after every
page, plus the curation tools that keep them honest.

### 8.1 The living cast

A **people · places · things** panel follows the story on every view (page, turn, reader, story
map). After each page, the model quietly updates it: who's present, where we are, which objects and
letters and heirlooms the plot turns on — capped and grounded ("never invent entries the story has
not established"). Settings toggle: **Keep the living cast up to date** (off = update by hand only).

You curate the cast, and your curation is **canon**:

- **Rename** anyone — the model is told to use exactly your spellings from then on.
- **Annotate** each entry with a one-line role or significance.
- **Character sheets** — a free-form details field per person, injected as canon into every
  generation. Age, look, want, secret: whatever you write, the model will honor.
- **Add and delete** entries by hand — prune the near-duplicates a model invents.
- **Open threads** — the questions and promises the story still owes the reader ("the letter's
  sender", "why the fog returns"). The prompt tells the model to advance or resolve them and _never
  drop them silently_; a thread disappears only when you delete it.
- **Relationships** — bonds between cast people ("Elin — sisters — Mara"), extracted, editable, and
  injected as canon.

### 8.2 Rename surgery

**🔧 Save + rename everywhere** does what it says: every chosen-path page that mentions the old name
is rewritten with the new one — pronouns and possessives included — each rewrite a new version,
nothing else changed, fork-safe. Renaming a character on page 60 is a button press, not an editing
session.

### 8.3 The rolling story summary

The **🧠 Story memory panel** shows the book's compact long-term memory: a plain-prose summary (~300
words: central conflict and its state, where each key character is and what they want, the current
situation, the mood trajectory, the most critical open threads). It is folded after each page in the
background, stamped with the page it's current to, refreshable by hand, and it is what keeps a
500-page book coherent. Every branch owns its own copy — fork a road, and its memory forks with it.

> **Best practice — curate early, curate small.** The cast is the cheapest consistency insurance in
> the app: fix names and spellings the moment they settle (renames stick), give your protagonist a
> sheet with the facts that matter, and keep the threads list honest — add the promises you care
> about, delete the ones the story has paid off. Five minutes of curation now is worth fifty minutes
> of contradiction-hunting later.

---

## 9. The tree: branching, the story map & collaboration

The book is an append-only tree. Nothing is ever edited in place — nothing can be. This is the
feature, not the limitation.

### 9.1 Forking semantics

- **Regenerate an old page** (page 3 of a 50-page book) → the new version becomes a new child
  branch. Pages 4–50 remain intact on the original branch.
- **Re-enter any old turn** and choose differently → a new branch grows; the old road stays.
- **Keep/tweak a page that already has children** → the page view warns you, then forks.
- **Duplicate a book** for experiments that should never touch the original.

The only cost of a fork is shelf space, and the map makes that space navigable.

### 9.2 The story map

The whole tree as a timeline: the chosen spine bright, every version of every page and every road
not taken **ghosted but clickable**. Click any ghost to re-enter and fork from that moment. Turn
decisions are annotated on the edges. Two more instruments live here:

- **Side-by-side comparison** — pick any two pages and read them pane to pane ("what if she opened
  the letter vs. what if she burned it?").
- **▶ Replay the journey** — a time-lapse of the chosen path, page by page.

### 9.3 Ghost pages

The 👻 what-if previews from the turn (§6.2) are the softest fork there is: written, read, then
adopted as a real branch or dissolved without a trace. Use them to audition; use the map to commit.

### 9.4 Title doorways

Every title ever proposed for a seed is a doorway on the map: **Enter** any of them and write — or
continue — a parallel book under that title. Forty proposals are forty potential books, each with
its own branch, its own cast, its own memory.

### 9.5 Pass the Quill — co-writing by file

The single-file, no-cloud promise rules out live co-authoring — and the app answers with file
passing: export a book as a `.ptbook.json` file, send it to a friend, they grow a branch on their
machine, and when the file comes back, **their pages land as new branches with the authors
recorded**. One quill, two hands, zero servers.

---

## 10. Endings & what comes after

### 10.1 Ending the story

At any turn: tick **Bring the story to a close with this page** — the direction block compiles to
"resolve the central thread, land the final image, let the last sentence be the last sentence of the
book. No new threads, no cliffhanger." Or press **✨ Propose endings** and browse a gallery of three
— one **bittersweet**, one **triumphant**, one **ambiguous or twist** — each a title plus a one-line
premise; click one and it fills the direction.

The ending is a page like any other, and it deserves the most iterations. A bad ending ruins a good
book; the generate-until-it's-good loop applies with full force at the finish.

### 10.2 The End view

When the book closes: read it front to back, open **About this book** (the full ledger: pages, words
kept vs. generated vs. written by hand, words directed, versions, branch points, moments remembered,
the decision log with mood icons, most-iterated pages, models used, the mood map), or export it in
seven formats (§13). And then:

- **🌱 Write the prologue** — page zero, 150–300 words, written after the fact: the model re-reads
  the finished book and plants the ending's seeds so a re-reader gasps. Rewrite it like any page.
- **🪞 The Director's Portrait** — a warm, witty, second-person reading of your directing style:
  tendencies, obsessions, what you kept coming back to.
- **➡️ Write a sequel** — a new seed that inherits the cast and the open threads as its brief. The
  lighthouse keeps burning.
- **🌿 Keep branching** — un-end the book and grow a new road from the last page. The End is a door,
  not a wall.

---

## 11. Iron Author mode

Per-book difficulty, from the library's ⋯ menu: **unlimited** re-rolls, **three strikes** per page,
or **iron** — no re-rolls at all; the page is final, mistakes become story, and finishing an iron
book earns the badge. It's a discipline tool: for forcing momentum on a book that keeps polishing
its first page forever, or for playing the game on hard when you trust your turns. Streaks and local
achievements (first fork, ten versions of one page…) live in the shelf stats — on-device only, never
shared.

---

## 12. Reading, listening & atmosphere

The book you directed deserves to be read like a book.

### 12.1 The reader

One page at a time, only reading: ←/→ turn pages, and your **reading position persists** per book —
re-open a book and land where you left off.

### 12.2 Read-aloud & bedtime mode

The browser's on-device voice narrates each page: pick a **voice**, set the **speed**, and switch on
**keep turning pages (bedtime mode)** — the book turns itself and keeps reading. Esc stops the
narrator. The one-page rhythm becomes a bedtime story, exactly as promised.

### 12.3 Themes, fonts & the wardrobe

Settings → Appearance: **dark candlelight, sepia, light, or follow-the-OS** themes; **five reading
fonts** (Georgia, Palatino, Charter, serif, sans); a **text-size scale**; and the per-format
**document wardrobe** (§6.7) so letters look like letters and clippings like clippings. All preview
live.

### 12.4 The mood, audible and visible

Every kept page carries its dominant emotion dial as a **mood chip** in the reader. The ambient
**soundscape** — a WebAudio pad, generated locally — retunes itself (pitch, filter, brightness) to
each page's mood, so the room itself tells you where the story is. And the whole mood map exports as
a **playable MIDI score**: press ▶ Play the score and hear the book's emotional arc performed. The
mood map is also printed as a line in text/markdown exports and chips in the reader.

### 12.5 Director's commentary

Toggle **💬 Commentary** in the reader: your turn decisions appear as margin notes beside the pages
they produced — the director's cut, read in place. Exports include the same commentary edition
(§13).

---

## 13. Exports & artifacts

The app never holds your story hostage. From the reader's ⋯ menu, The End view, and the library:

| Export                      | What you get                                                         |
| --------------------------- | -------------------------------------------------------------------- |
| ⇓ EPUB                      | a real EPUB e-book, cover and chapter structure intact               |
| ⇓ PDF                       | print-ready: minimal PDF 1.4, Helvetica, 6×9-inch pages              |
| ⇓ .txt / .md                | the compiled path, clean and linear, with cast appendix and mood map |
| 📝 Director's cut (.md)     | every page with the decisions that made it                           |
| ⇓ .mid                      | the mood map as a MIDI score                                         |
| 🖼️ Quote card               | any page rendered as a typographic PNG (2× resolution)               |
| 💾 Book file (.ptbook.json) | the whole tree — import it anywhere, pass it to a friend             |
| ⇓ Export library (.json)    | everything: all books, nodes, settings (.ptlibrary.json)             |

A **backup nudge** reminds you after 15 pages created since your last export. Books live in
IndexedDB and are mirrored to an OPFS file on disk; import-export uses the File System Access API
with download/upload fallbacks, and dragging a `.ptlibrary.json` / `.ptbook.json` onto the window
imports it.

---

## 14. The library — your shelf

The shelf fills with books that literally could not exist without your decisions. It works like a
shelf, not a file manager:

- **Search** across titles, seeds, taglines, page text, and even the unchosen proposed titles —
  typo-tolerant.
- **Sort** by recent · mood · length · branches ("most branched" surfaces your bushiest gardens).
- **Tags** — your own collections (bedtime, gothic, workshop).
- **Procedural covers** painted per book; in-progress books look different from finished ones.
- The ⋯ menu per spine: continue/fork, rename, Iron Author, Pass the Quill, tags, story map, about,
  read, exports, sequel, **duplicate**, delete.
- A friendly three-step tour greets the empty shelf; streaks and badges live in the stats.

---

## 15. Best practices — the digest

Everything above, distilled into the habits of a great Page Turn director.

**Directing, not writing**

1. **A spark, not a spec.** One line in; the direction happens at the turns, where it belongs.
2. **One decision per turn.** The best turns change one thing: a direction, a dial, a rule. Empty is
   a decision too — Continue naturally says "the story knows where it's going."
3. **Iterate by name.** Read the page, name the one thing wrong, fix exactly that (tweak, span
   rewrite, nudge). Blind re-rolls are a slot machine; naming is craft.
4. **Buy options at decisive moments.** Parallel candidates for first pages, reveals, endings; ghost
   previews for risky directions; pin the keepers; diff to see what changed.
5. **Write the pages that matter most yourself.** ✍️ I'll write it myself makes you the prose engine
   whenever the moment deserves your voice — hybrids are usually the best books.

**The console**

6. **Dials are tilts, not jumps.** ±1 slightly, ±2 clearly, ±3 strongly — build mood in gradients;
   put the jump-cuts in words.
7. **Negative space has two half-lives.** Standing rules for constraints you'll lift; the brief for
   what the book permanently is and isn't.
8. **Templates for signature moods.** Save the console setups you keep rebuilding — "midnight
   chapter", "chase sequence" — and apply them in one click.
9. **Check the risky turns.** 🔍 Check this direction costs one fast-model call and catches
   contradictions before they become canon — unless keeping the contradiction is the point.

**Memory & world**

10. **Curate the cast early.** Fix names the moment they settle; sheets are canon; prune the
    near-duplicates; keep the threads list honest.
11. **Keep pages tight for memory's sake.** The 2,600-word budget means every bloated page crowds
    out an older one; the summary — keep it on — is what remembers the rest.
12. **Refresh the memory when it matters.** The 🧠 Story memory panel shows exactly what the next
    page will inherit; a manual ↻ Update before a big reveal is cheap insurance.

**The tree**

13. **Branch fearlessly.** Nothing is ever destroyed — regret is impossible by construction. Re-roll
    old pages, re-enter old turns, enter unchosen titles. The roads not taken are the archive, and
    the archive is the point.
14. **Use the map as a thinking tool.** Compare two roads side by side; replay the journey to see
    the book's shape; adopt or dissolve ghosts deliberately.

**Rhythm & completion**

15. **End deliberately.** The last page deserves the most iterations — the endings gallery proposes
    bittersweet/triumphant/twist, and you iterate from there.
16. **Export early, export often.** The backup nudge fires at 15 unwritten pages; the .ptbook file
    is a one-click full backup of the whole tree.
17. **Read aloud to proof.** The ear catches what the eye skips — and bedtime mode turns
    proofreading into a ritual.

**Model craft**

18. **Two models, one voice.** Assign a fast model to the cheap phases (titles, chat, cast, beats,
    suggestions) and let the strong model write pages. Keep the page model consistent within a book
    so the prose voice doesn't drift mid-chapter.

---

## 16. Troubleshooting & failure modes

- **No model found.** Settings → 🔍 Scan for local LLMs. The scanner probes the standard local
  inference ports (LM Studio, Ollama, llama.cpp, KoboldCpp, text-generation-webui, GPT4All, vLLM,
  Jan, AnythingLLM, Msty) and reports reachable / CORS-blocked / not found, with fixes.
- **CORS-blocked** means a server answered but refused this page's origin: enable CORS for localhost
  in the server, or run the app from a localhost URL (`pnpm dev`) instead of `file://`.
- **Slow pages.** Local models can take minutes per page — the streaming panel shows every token,
  and **Cancel always works**. A smaller/faster model for the cheap phases (Settings) makes
  everything feel snappier.
- **Model drift or contradictions.** The conflict checker catches turn-level conflicts; the story
  linter flags prose-level tics; the cast and summary are your continuity ledger; and "write it
  myself" is the escape hatch when the model keeps missing the note.
- **A structured phase came back empty.** Titles, suggestions, and cast updates parse tolerantly and
  fall back gracefully — retry, or regenerate with a tweak.
- **Iron Author regret.** Fork from an earlier page: the tree makes every "mistake" a branch point.
- **Debugging.** `window.__PAGE_TURN__` in the devtools console shows the live state — books, nodes,
  settings — at any moment.
- **Data safety.** Everything lives in IndexedDB + an OPFS file, exports as JSON any time, and
  travels only to the endpoint you configure. No telemetry, no cloud, no account.

---

## 17. Keyboard shortcuts & quick reference

| Keys              | Where               | What                                                      |
| ----------------- | ------------------- | --------------------------------------------------------- |
| ← / →             | page & reader views | previous / next page (on the last page, → opens the turn) |
| shift+← / shift+→ | page view           | flip versions of the current page                         |
| Esc               | page view           | close editors, clear the span selection                   |
| Esc               | reader              | stop the narrator                                         |
| ?                 | anywhere            | open the built-in manual; Esc returns                     |

The whole product in one line: **seed → titles → page → turn → page → … → The End**, with every
version, decision, and branch remembered forever.

---

## 18. The complete option catalog (reference)

**Seed notes:** genre (free text + suggestions) · perspective: decide / first / third / second ·
tense: decide / past / present · tone: decide / warm / dark / funny / literary / pulpy · audience:
adult / kid-safe / teen · length: let it run / short story / novella.

**Titles:** 5 at a time, each with a tagline · regenerate · edit in place · all remembered · each a
re-enterable doorway.

**Page length:** ¶ 1 paragraph · ¶ 3 paragraphs · shorter (90–170 words) · standard (150–400) ·
longer (300–600) · custom exact target in words / paragraphs / characters (1–200,000).

**Tone:** inherit · darker · lighter · warmer · colder · funnier · more serious · more poetic · more
plain.

**Emotion dials (±3, 0 = inherit):** tension 🕯️ · wonder ✨ · warmth 🤍 · dread 🕳️ · humor 😏 ·
sadness 🌧️ · romance 🖤 · joy ☀️ · mystery ❓ · menace ⚠️.

**Chapter:** none · start a new chapter · bring this chapter to a close.

**Page format:** story · letter · diary · newspaper clipping · map marginalia · recipe — each with a
wardrobe font.

**Pace:** inherit · slow & meditative · propulsive. **Page ending:** inherit · cliffhanger · resting
point.

**Ending:** bring-to-a-close checkbox · proposed-endings gallery (bittersweet / triumphant / twist)
· ending note.

**Rules & safety:** standing rules (persist until removed, 8 presets) · one-shot direction ·
conflict checker · content-rating hints at seed time.

**Templates:** save / apply named console setups (direction never saved).

**Iron Author:** unlimited · three strikes · iron (no re-rolls).

**Models:** scan 10 local servers · LAN subnet scan · manual URL (both OpenAI-compatible and
Ollama-native dialects) · optional API key · fast model per phase · per-page model metadata.

**Exports:** EPUB · PDF (6×9) · .txt · .md · director's cut (.md) · MIDI score · quote card PNG ·
.ptbook.json · .ptlibrary.json.

**Reading:** themes dark / sepia / light / system · fonts Georgia / Palatino / Charter / serif /
sans · font scale · per-format wardrobe · read-aloud voice + speed + bedtime mode · persistent
position · ambient mood soundscape.

---

## 19. The roadmap — clearly labeled

Not shipped today (see [NEXT.md](NEXT.md) and [NEW-FEATURES.md](NEW-FEATURES.md) for the ranked
plan): story-arc planner (a 5-act map the turns auto-follow) · valence/arousal dials and a "sudden
shift" toggle · beat previews · reference documents · timeline ledger · branch merge & pruning ·
bookmarks · focus mode, page-flip animation, swipe gestures · voice-directed turns · illustrations
(a pluggable image provider with an always-works fallback). Excluded by the single-file, no-cloud
promise: live co-authoring, public galleries, print-on-demand.

---

## 20. Closing thought

The genius of this idea is that it takes the two weakest parts of AI writing — long-term coherence
and user steering — and turns them into strengths by shrinking the unit of creation to a single page
and moving your contribution to exactly the moment you're most engaged: the page turn.

So: write one line. Pick a title that makes you feel something. Keep the pages that give you chills.
Steer the turns like you mean them. Branch without fear, curate the world, and end on purpose.

The story was always going to be a tree. This is the first tool that lets you walk it — and now you
know every path it has.
