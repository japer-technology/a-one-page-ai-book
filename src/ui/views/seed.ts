/**
 * ui/views/seed.ts — the spark. One line (or a lucky one), a few optional
 * starting notes, and the book begins. None of these are locked in later.
 */
import type { AppApi } from '../ctx';
import { button, field, h } from '../dom';
import { emptySeedOptions } from '../../core/schema';
import type { SeedOptions } from '../../core/types';

const LUCKY_SEEDS = [
  'A lighthouse keeper finds a letter addressed to someone who died a hundred years ago.',
  'A girl inherits a hotel that only appears in the fog.',
  'An immortal librarian who is allergic to books.',
  'What if dogs could file taxes?',
  'A cyberpunk whodunit in a space elevator.',
  'Jane Austen meets Blade Runner.',
  'The last phone booth on Earth starts ringing, and only she can hear it.',
  'A baker discovers that her sourdough starter remembers everything.',
  'Every mirror in the city shows tomorrow, except one.',
  'A retired time traveler opens a café where the past is on the menu.',
  'The tide goes out and does not come back.',
  'A detective who can only solve crimes committed in dreams.',
];

function luckySeed(): string {
  const seed = LUCKY_SEEDS[Math.floor(Math.random() * LUCKY_SEEDS.length)];
  return seed ?? LUCKY_SEEDS[0] ?? 'Something wonderful, and a little strange, begins.';
}

export function renderSeed(api: AppApi): HTMLElement {
  const textarea = h('textarea', {
    class: 'seed-input',
    rows: 4,
    placeholder:
      'A lighthouse keeper finds a letter addressed to someone who died a hundred years ago.',
    'aria-label': 'Your seed',
  });
  textarea.focus();

  const genre = h('input', {
    class: 'input',
    type: 'text',
    placeholder: 'surprise me',
    list: 'genres',
  });
  const genres = h(
    'datalist',
    { id: 'genres' },
    ...[
      'gothic romance',
      'cozy mystery',
      'space opera',
      'literary fiction',
      'noir',
      'fairytale',
      'slice of life',
      'western',
      'horror',
    ].map((g) => h('option', { value: g })),
  );

  const perspective = select('', [
    ['', 'decide for me'],
    ['first', 'first person'],
    ['third', 'third person'],
    ['second', 'second person'],
  ]);
  const tense = select('', [
    ['', 'decide for me'],
    ['past', 'past tense'],
    ['present', 'present tense'],
  ]);
  const tone = select('', [
    ['', 'decide for me'],
    ['warm', 'warm'],
    ['dark', 'dark'],
    ['funny', 'funny'],
    ['literary', 'literary'],
    ['pulpy', 'pulpy'],
  ]);
  const audience = select('', [
    ['', 'adult'],
    ['kid-safe', 'kid-safe'],
    ['teen', 'teen'],
    ['adult', 'adult'],
  ]);
  const lengthHint = select('', [
    ['', 'let it run'],
    ['short-story', 'short story'],
    ['novella', 'novella'],
    ['let-it-run', 'let it run'],
  ]);

  const begin = (options: SeedOptions) => {
    const text = textarea.value.trim();
    if (text.length === 0) {
      api.toast('The seed can be anything — write one line, or roll the dice.', 'info');
      return;
    }
    const seedNode = api.newSeed(text, options);
    api.navigate('titles', { seed: seedNode.id });
  };

  const collect = (): SeedOptions => ({
    ...emptySeedOptions(),
    genre: genre.value.trim(),
    perspective: perspective.value as SeedOptions['perspective'],
    tense: tense.value as SeedOptions['tense'],
    tone: tone.value as SeedOptions['tone'],
    audience: audience.value as SeedOptions['audience'],
    lengthHint: lengthHint.value as SeedOptions['lengthHint'],
  });

  return h(
    'div',
    { class: 'view view-seed' },
    h(
      'header',
      { class: 'view-head' },
      h('h1', { text: 'The Seed' }),
      h('p', {
        class: 'lede',
        text: 'One line is enough. The AI does the heavy lifting — you take the wheel page by page.',
      }),
    ),
    field('Your seed', textarea, 'A sentence, a vibe, a mashup, a question — anything.'),
    h(
      'div',
      { class: 'row gap' },
      button('🎲 I’m feeling lucky', () => {
        textarea.value = luckySeed();
        textarea.focus();
      }),
    ),
    h(
      'details',
      { class: 'folds' },
      h('summary', { text: 'Optional starting notes (nothing is locked in)' }),
      h(
        'div',
        { class: 'grid-2' },
        field('Genre', genre),
        field('Perspective', perspective),
        field('Tense', tense),
        field('Tone baseline', tone),
        field('Audience', audience),
        field('Length hint', lengthHint),
      ),
    ),
    h(
      'div',
      { class: 'row gap' },
      button('Begin → propose titles', () => begin(collect()), 'primary'),
    ),
    genres,
  );
}

function select(value: string, options: Array<[string, string]>): HTMLSelectElement {
  return h(
    'select',
    { class: 'input' },
    ...options.map(([v, label]) =>
      h('option', { value: v, selected: v === value ? true : undefined, text: label }),
    ),
  );
}
