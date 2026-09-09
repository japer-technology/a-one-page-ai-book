/**
 * ui/views/help.ts — the built-in manual. Everything the app can do, in one
 * scannable page, with a section for every surface. Reachable from the "?"
 * button in the header, the ? key anywhere, and small ? links in the views.
 */
import type { AppApi } from '../ctx';
import { button, h } from '../dom';

interface HelpSection {
  id: string;
  icon: string;
  title: string;
  body: Array<string | HTMLElement>;
}

export function renderHelp(api: AppApi): HTMLElement {
  const section = api.params.section ?? '';

  const kbd = (keys: string): HTMLElement => h('span', { class: 'kbd', text: keys });

  const sections: HelpSection[] = [
    {
      id: 'loop',
      icon: '🔄',
      title: 'The loop',
      body: [
        'Seed → titles → page → the turn → page → … → The End. One page at a time; every version, every decision, every branch is remembered forever.',
        h(
          'div',
          {},
          'The page turn is the product: after you keep a page, the console asks "what happens next?" — and zero inputs is still a decision (Continue naturally).',
        ),
      ],
    },
    {
      id: 'turn',
      icon: '🎛️',
      title: 'The turn console',
      body: [
        'Direction (free text) + one-tap nudge presets · suggested beats you can step through, each with a 👻 what-if ghost preview · page length (presets or an exact word/paragraph/character target) · tone · ten emotion dials · pace · cliffhanger/resting ending · chapter break/close · page format (letter, diary, newspaper, map notes, recipe) · standing "don’t touch" rules · 🔍 Check this direction · templates · ✍️ write it yourself.',
        'Page one is a turn too: after the title, the same console asks how page one begins.',
      ],
    },
    {
      id: 'craft',
      icon: '🔧',
      title: 'Crafting pages',
      body: [
        'Hover any paragraph: ↻ rewrite with the model (streams in place), ✎ edit word by word, ＋ insert, ↑↓ move, ✕ delete. Select any span of text for a floating ↻/✎ toolbar. Every change is a new version — flip through them with the version picker, diff any two, and pin the ones you love.',
        '"🎲 Generate 2 more versions" writes parallel alternatives. Undo sits under the page after every craft commit.',
        h(
          'div',
          {},
          kbd('←/→'),
          ' walk pages · ',
          kbd('shift+←/→'),
          ' flip versions · ',
          kbd('esc'),
          ' close editors',
        ),
      ],
    },
    {
      id: 'cast',
      icon: '📇',
      title: 'Cast & memory',
      body: [
        'The cast (people · places · things · open threads · relationships) updates in the background after each page — and you curate it: rename, annotate, add character sheets, record bonds, add threads. Your names are injected into every generation, so renames stick.',
        '🔧 Rename everywhere rewrites the whole chosen path. The rolling story summary keeps long books coherent. The story map shows the whole tree — every road not taken, clickable, with time-lapse replay and side-by-side comparison.',
      ],
    },
    {
      id: 'read',
      icon: '📖',
      title: 'Reading & listening',
      body: [
        'The reading room is only reading: ' +
          kbd('←/→') +
          ' turn pages, ' +
          kbd('esc') +
          ' stops the narrator, bedtime mode keeps turning and reading aloud. Themes (dark/sepia/light/system) and five reading fonts live in Settings → Appearance — changes preview live.',
        'Export the compiled book as PDF, EPUB, .txt, .md, the director’s-cut commentary edition, a MIDI score of the mood map, or a shareable quote card (all in the ⋯ menu).',
      ],
    },
    {
      id: 'iron',
      icon: '⚔',
      title: 'Iron Author',
      body: [
        'Per-book difficulty, from the library ⋯ menu: unlimited re-rolls, three strikes per page, or iron — no re-rolls, the page is final. Finishing an iron book earns the Iron Author badge.',
      ],
    },
    {
      id: 'practice',
      icon: '🖋️',
      title: 'Authoring best practices',
      body: [
        'Direct, don’t type: the model writes, you decide. Change one thing per turn — and an empty console is a decision too (Continue naturally).',
        'Iterate by name: read the page, name the one thing wrong, fix exactly that (tweak, span rewrite, nudge). Use 🎲 parallel candidates at decisive moments; pin the keepers and diff to see what changed.',
        'Dials are tilts, not jumps: ±1 slightly, ±2 clearly, ±3 strongly — build mood in gradients, put jump-cuts in words. Standing rules for don’ts you’ll lift later; the brief for what the book permanently is.',
        'Curate the cast early — renames stick, sheets are canon, threads are debts the model is told to pay. Keep pages tight (the context budget is 2,600 words) and leave the rolling summary on for long books.',
        'Branch fearlessly — nothing is ever destroyed. Regenerate old pages, enter unchosen titles, ghost-preview big swings. End deliberately (the last page deserves the most iterations) and export early — the backup nudge fires at 15 pages.',
        'The full guide lives in docs/AUTHORING.md in the repository.',
      ],
    },
    {
      id: 'files',
      icon: '💾',
      title: 'Files & safety',
      body: [
        'Everything lives on your device (IndexedDB + an OPFS file) and travels only to the local LLM endpoint you configure. Export the library as .json any time; drop a .ptlibrary.json or .ptbook.json onto the window to import. 🪶 Pass the quill: export a book, a friend grows a branch, drop it back and their pages merge as branches.',
        'A backup nudge reminds you after 15 unwritten-to-disk pages. Local streaks and badges live in the shelf stats.',
      ],
    },
    {
      id: 'trouble',
      icon: '🛠️',
      title: 'Troubleshooting',
      body: [
        'No model? Settings → 🔍 Scan for local LLMs. CORS-blocked means a server answered but refused this page’s origin — enable CORS for localhost, or run from a localhost URL (pnpm dev). API key required? Add it in Settings.',
        'Nothing happens when you generate? Local models can take minutes per page — watch the streaming panel; Cancel always works.',
        'Everything else is in Settings → Help, and window.__PAGE_TURN__ in the devtools console shows live state.',
      ],
    },
  ];

  const items = sections.map((s) =>
    h(
      'section',
      { class: 'card help-section', id: `help-${s.id}` },
      h('h2', { text: `${s.icon} ${s.title}` }),
      ...s.body.map((item) =>
        typeof item === 'string'
          ? h('p', { class: 'help-body', text: item })
          : h('div', { class: 'help-body' }, item),
      ),
    ),
  );

  if (section) {
    setTimeout(() => {
      document
        .getElementById(`help-${section}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  }

  return h(
    'div',
    { class: 'view view-help' },
    h(
      'header',
      { class: 'view-head' },
      h('h1', { text: '❓ Help — the whole manual' }),
      h('p', {
        class: 'lede',
        text: 'Press ? anywhere to come back here. Esc returns to what you were doing.',
      }),
    ),
    h(
      'div',
      { class: 'row gap' },
      ...sections.map((s) =>
        button(`${s.icon} ${s.title}`, () => api.navigate('help', { section: s.id }), 'chip'),
      ),
    ),
    h('div', { class: 'help-sections' }, ...items),
  );
}
