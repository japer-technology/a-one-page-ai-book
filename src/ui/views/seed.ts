/**
 * ui/views/seed.ts — the spark. One line (or a lucky one), a few optional
 * starting notes, and the book begins. None of these are locked in later.
 *
 * There is also a pre-writing chat: talk through what you want from the book
 * with the local model, then distill the conversation into a brief that
 * steers the titles and every page afterwards.
 */
import type { AppApi } from '../ctx';
import { button, field, h, spinner } from '../dom';
import { emptySeedOptions } from '../../core/schema';
import { briefMessages, chatMessages } from '../../core/prompt';
import type { ChatMessage, SeedOptions } from '../../core/types';

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

// Session-scoped chat state: one pre-writing conversation at a time.
const chat = {
  messages: [] as ChatMessage[],
  busy: false,
  brief: '',
};

/**
 * Session-scoped seed form state. The seed view re-renders on every chat
 * message and distill, and uncontrolled inputs would lose everything the
 * reader typed — the classic "chat wiped my seed" bug. The draft is the one
 * source of truth; the inputs just mirror it.
 */
const draft = {
  seed: '',
  genre: '',
  perspective: '',
  tense: '',
  tone: '',
  audience: '',
  lengthHint: '',
};
let chatOpen = false;

export function renderSeed(api: AppApi): HTMLElement {
  const textarea = h('textarea', {
    class: 'seed-input',
    rows: 4,
    value: draft.seed,
    placeholder:
      'A lighthouse keeper finds a letter addressed to someone who died a hundred years ago.',
    'aria-label': 'Your seed',
    oninput: (event: Event) => {
      draft.seed = (event.target as HTMLTextAreaElement).value;
    },
  });
  // Focus the seed box when the reader is working on the seed — but NEVER
  // when the chat is open: every chat send/distill re-renders the view, and
  // an eager focus() used to yank the caret out of the chat input mid-flow.
  if (!chatOpen) textarea.focus();

  const genre = h('input', {
    class: 'input',
    type: 'text',
    placeholder: 'surprise me',
    list: 'genres',
    value: draft.genre,
    oninput: (event: Event) => {
      draft.genre = (event.target as HTMLInputElement).value;
    },
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

  const perspective = select(
    draft.perspective,
    [
      ['', 'decide for me'],
      ['first', 'first person'],
      ['third', 'third person'],
      ['second', 'second person'],
    ],
    (value) => {
      draft.perspective = value;
    },
  );
  const tense = select(
    draft.tense,
    [
      ['', 'decide for me'],
      ['past', 'past tense'],
      ['present', 'present tense'],
    ],
    (value) => {
      draft.tense = value;
    },
  );
  const tone = select(
    draft.tone,
    [
      ['', 'decide for me'],
      ['warm', 'warm'],
      ['dark', 'dark'],
      ['funny', 'funny'],
      ['literary', 'literary'],
      ['pulpy', 'pulpy'],
    ],
    (value) => {
      draft.tone = value;
    },
  );
  const audience = select(
    draft.audience,
    [
      ['', 'decide for me'],
      ['kid-safe', 'kid-safe'],
      ['teen', 'teen'],
      ['adult', 'adult'],
    ],
    (value) => {
      draft.audience = value;
    },
  );
  const lengthHint = select(
    draft.lengthHint,
    [
      ['', 'decide for me'],
      ['short-story', 'short story'],
      ['novella', 'novella'],
      ['let-it-run', 'let it run'],
    ],
    (value) => {
      draft.lengthHint = value;
    },
  );

  const collect = (): SeedOptions => ({
    ...emptySeedOptions(),
    genre: draft.genre.trim(),
    perspective: draft.perspective as SeedOptions['perspective'],
    tense: draft.tense as SeedOptions['tense'],
    tone: draft.tone as SeedOptions['tone'],
    audience: draft.audience as SeedOptions['audience'],
    lengthHint: draft.lengthHint as SeedOptions['lengthHint'],
  });

  const begin = (options: SeedOptions) => {
    const brief = chat.brief.trim();
    const typed = draft.seed.trim();
    // The brief can BE the seed: a book distilled from a chat alone starts
    // here instead of refusing to begin.
    const text = typed.length > 0 ? typed : brief;
    if (text.length === 0) {
      api.toast('The seed can be anything — write one line, or roll the dice.', 'info');
      return;
    }
    const seedNode = api.newSeed(text, options, brief);
    if (typed.length === 0) {
      api.toast('Seeded from your brief — the brief still rides along into every page.', 'info');
    }
    // The book is born: clear the session drafts so the NEXT new book starts
    // fresh (a stale brief must never steer a different story).
    draft.seed = '';
    draft.genre = '';
    draft.perspective = '';
    draft.tense = '';
    draft.tone = '';
    draft.audience = '';
    draft.lengthHint = '';
    chat.messages = [];
    chat.brief = '';
    chatOpen = false;
    api.navigate('titles', { seed: seedNode.id });
  };

  // ---- The pre-writing chat ------------------------------------------------
  const chatBox = h('div', { class: 'chat-log' });
  for (const message of chat.messages) {
    chatBox.appendChild(
      h(
        'div',
        { class: `chat-bubble chat-${message.role}` },
        h('span', { class: 'chat-who', text: message.role === 'user' ? 'you' : 'writing partner' }),
        h('div', { class: 'chat-text', text: message.content }),
      ),
    );
  }
  if (chat.busy) {
    chatBox.appendChild(h('div', { class: 'chat-bubble chat-assistant' }, spinner(), ' thinking…'));
  }

  const chatInput = h('input', {
    class: 'input chat-input',
    type: 'text',
    placeholder: '“I want a quiet gothic mystery with a twist ending…”',
    onkeydown: (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void send(api, chatInput);
      }
    },
  });

  const send = async (api: AppApi, input: HTMLInputElement): Promise<void> => {
    const text = input.value.trim();
    if (!text || chat.busy) return;
    input.value = '';
    chat.messages.push({ role: 'user', content: text });
    chat.busy = true;
    chatOpen = true;
    api.refresh();
    // The re-render replaced the input — hand the caret back so the reader
    // can keep chatting without a mouse.
    document.querySelector<HTMLInputElement>('.chat-input')?.focus();
    try {
      const fast = api.lib.settings.fastModel || api.lib.settings.endpoint.model;
      const reply = await api.generateText(chatMessages([...chat.messages]), { model: fast });
      chat.messages.push({ role: 'assistant', content: reply.trim() });
    } catch (err) {
      chat.messages.push({
        role: 'assistant',
        content: `(The model didn't answer: ${api.genError(err)})`,
      });
    }
    chat.busy = false;
    api.refresh();
  };

  const distill = async (api: AppApi): Promise<void> => {
    if (chat.messages.length < 2 || chat.busy) return;
    chat.busy = true;
    api.refresh();
    try {
      const fast = api.lib.settings.fastModel || api.lib.settings.endpoint.model;
      const brief = await api.generateText(briefMessages([...chat.messages]), { model: fast });
      chat.brief = brief.trim();
      // The brief fills the seed: a book distilled from a chat alone must be
      // able to begin. Edit either field — they stay in sync only here.
      if (draft.seed.trim().length === 0) {
        draft.seed = chat.brief;
      }
      api.toast(
        'Brief distilled — it fills the seed below (and still rides along into every page). Edit either one.',
        'success',
      );
    } catch (err) {
      api.toast(api.genError(err), 'error');
    }
    chat.busy = false;
    api.refresh();
    // Land the caret in the brief so it can be trimmed right away.
    document.querySelector<HTMLTextAreaElement>('.brief-input')?.focus();
  };

  const briefArea = chat.brief
    ? h('textarea', {
        class: 'input brief-input',
        rows: 4,
        value: chat.brief,
        oninput: (event: Event) => {
          chat.brief = (event.target as HTMLTextAreaElement).value;
        },
      })
    : null;

  const chatSection = h(
    'details',
    {
      class: 'folds chat',
      open: chatOpen ? true : undefined,
      ontoggle: (event: Event) => {
        // Respect the reader's collapse/expand across re-renders (re-renders
        // used to force the chat back open whenever messages existed).
        chatOpen = (event.currentTarget as HTMLDetailsElement).open;
      },
    },
    h('summary', { text: '💬 Talk it through first (optional)' }),
    h(
      'p',
      { class: 'field-hint' },
      'Chat about the book you want — protagonist, setting, mood, what you don’t want. Then distill the conversation into a brief that rides along into every page.',
    ),
    chatBox,
    h(
      'div',
      { class: 'row gap' },
      chatInput,
      button('Send', () => void send(api, chatInput), 'primary', { disabled: chat.busy }),
    ),
    h(
      'div',
      { class: 'row gap' },
      button('✨ Distill into a brief', () => void distill(api), 'ghost', {
        disabled: chat.messages.length < 2 || chat.busy,
        title: 'Condense this conversation into a story brief the model will follow',
      }),
      chat.brief
        ? h('span', { class: 'field-hint', text: 'brief ready — it also fills the seed above' })
        : null,
    ),
    briefArea,
  );

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
        draft.seed = luckySeed();
        textarea.value = draft.seed;
        textarea.focus();
      }),
    ),
    chatSection,
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

function select(
  value: string,
  options: Array<[string, string]>,
  onchange: (value: string) => void,
): HTMLSelectElement {
  return h(
    'select',
    {
      class: 'input',
      onchange: (event: Event) => onchange((event.target as HTMLSelectElement).value),
    },
    ...options.map(([v, label]) =>
      h('option', { value: v, selected: v === value ? true : undefined, text: label }),
    ),
  );
}
