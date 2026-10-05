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
import {
  briefMessages,
  chatMessages,
  CHAT_EXCHANGES_SENT,
  luckySeedMessages,
  trimChatHistory,
} from '../../core/prompt';
import { parseStringList } from '../../core/parsers';
import type { ChatMessage, SeedOptions } from '../../core/types';

/**
 * The fallback seeds. These used to BE the feature — "I'm feeling lucky" could
 * only ever offer these twelve lines, because the one button whose entire point
 * is surprise was the one place the model was never asked. The model now
 * proposes the seeds; this list is what the button falls back to when there is
 * no endpoint configured, or the model is unreachable or answers with junk.
 */
const FALLBACK_SEEDS = [
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

function fallbackSeed(): string {
  const seed = FALLBACK_SEEDS[Math.floor(Math.random() * FALLBACK_SEEDS.length)];
  return seed ?? FALLBACK_SEEDS[0] ?? 'Something wonderful, and a little strange, begins.';
}

/**
 * The dice. One model request buys a batch of seeds; the button then walks
 * through the batch before asking again, so a second click is instant and does
 * not spend another request. Each batch is told what has already been offered,
 * so rolling repeatedly keeps producing genuinely new ideas.
 */
const lucky = {
  busy: false,
  pool: [] as string[],
  cursor: 0,
  /** Everything offered this session, so the model never repeats itself. */
  offered: [] as string[],
};

/** A seed the model proposed must actually look like one. */
function usableSeed(candidate: string): boolean {
  const text = candidate.trim();
  if (text.length < 12 || text.length > 240) return false;
  // A model that ignored the instruction may answer with a title, a label or a
  // numbering prefix; those would enter the seed box as-is.
  if (/^(?:\d+[.)]|[-*•]|seed\b|title\b|idea\b)/i.test(text)) return false;
  return text.split(/\s+/).length >= 3;
}

/** Put a seed in the box, and leave the caret there ready to edit it. */
function offerSeed(text: string): void {
  draft.seed = text;
  const box = document.querySelector<HTMLTextAreaElement>('.seed-input');
  if (box) {
    box.value = text;
    box.focus();
    box.setSelectionRange(text.length, text.length);
  }
}

// Session-scoped chat state: one pre-writing conversation at a time.
const chat = {
  messages: [] as ChatMessage[],
  busy: false,
  brief: '',
};

/**
 * Throw the conversation away. Called when a book is BORN (from here or from
 * "write a sequel") so the next new book starts a genuinely new conversation:
 * the draft, the brief and the transcript belonged to the story just started,
 * and a stale brief silently steering a different story is the worst failure
 * this view has. Also reachable from the reader's own "new conversation" button.
 */
export function resetSeedSession(): void {
  chat.messages = [];
  chat.brief = '';
  chat.busy = false;
  chatOpen = false;
  draft.seed = '';
  draft.genre = '';
  draft.perspective = '';
  draft.tense = '';
  draft.tone = '';
  draft.audience = '';
  draft.lengthHint = '';
  // The dice pool goes too: those ideas were offered for the story being
  // abandoned, and the "already offered" list must not leak across books.
  lucky.pool = [];
  lucky.cursor = 0;
  lucky.offered = [];
}

/** Clear just the conversation (the reader asked for a fresh one). */
function clearConversation(): void {
  chat.messages = [];
  chat.brief = '';
  chat.busy = false;
}

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
/** How many recent exchanges the BRIEF is distilled from (a longer window). */
const BRIEF_EXCHANGES_SENT = 20;

/**
 * A request the reader stopped (or that a newer one superseded) is not a
 * model failure: navigation aborts the in-flight call, and reporting that as
 * "the model didn't answer"/"could not roll an idea" filled the transcript and
 * the toast stack with a failure that never happened.
 */
function isCancelled(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

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
  // Deferred: the view is still detached here (`dispatchView` returns it and
  // the shell mounts it afterwards), and focus() on a detached node does
  // nothing — so the app's "primary control" never actually got the caret.
  if (!chatOpen) setTimeout(() => textarea.focus(), 0);

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

  const rollLuckySeed = async (api2: AppApi): Promise<void> => {
    if (lucky.busy) return;
    // A batch the model already gave us costs nothing: walk it first.
    const next = lucky.pool[lucky.cursor];
    if (next !== undefined) {
      lucky.cursor++;
      offerSeed(next);
      api2.refresh();
      return;
    }
    if (!api2.lib.settings.endpoint.model) {
      // No endpoint yet: the built-in ideas still work, so the button is never
      // a dead end on a fresh install.
      const idea = fallbackSeed();
      lucky.offered.push(idea);
      offerSeed(idea);
      return;
    }
    lucky.busy = true;
    api2.refresh();
    try {
      const fast = api2.lib.settings.fastModel || api2.lib.settings.endpoint.model;
      const raw = await api2.generateText(luckySeedMessages(5, collect(), lucky.offered), {
        model: fast,
      });
      const ideas = parseStringList(raw).filter(usableSeed).slice(0, 5);
      if (ideas.length === 0) throw new Error('The model returned no usable seed');
      lucky.pool = ideas;
      lucky.cursor = 1;
      lucky.offered.push(...ideas);
      offerSeed(ideas[0] ?? '');
      api2.toast('Rolled by the model — click again for another', 'info');
    } catch (err) {
      if (!isCancelled(err)) {
        // Honest fallback: say what happened, then still fill the box.
        const idea = fallbackSeed();
        lucky.offered.push(idea);
        offerSeed(idea);
        api2.toast(
          `The model could not roll an idea (${api2.genError(err)}) — here is one of ours.`,
          'info',
        );
      }
    } finally {
      lucky.busy = false;
      api2.refresh();
      document.querySelector<HTMLTextAreaElement>('.seed-input')?.focus();
    }
  };

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
    // The book is born: clear the session so the NEXT new book starts fresh.
    resetSeedSession();
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
      const reply = await api.generateText(chatMessages(trimChatHistory(chat.messages)), {
        model: fast,
      });
      chat.messages.push({ role: 'assistant', content: reply.trim() });
    } catch (err) {
      // A cancel is not an answer: pushing the notice into the transcript put
      // a fake assistant turn — "(The model didn't answer: Generation
      // cancelled.)" — into a conversation the reader had simply left.
      if (!isCancelled(err)) {
        chat.messages.push({
          role: 'assistant',
          content: `(The model didn't answer: ${api.genError(err)})`,
        });
      }
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
      // The brief is meant to cover the whole conversation, so it gets a much
      // longer window than a chat turn — but still a window.
      const brief = await api.generateText(
        briefMessages(trimChatHistory(chat.messages, BRIEF_EXCHANGES_SENT)),
        { model: fast },
      );
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
      // A cancelled distill (the reader navigated in the meantime) is not a
      // failure to report: the toast outlives the view it came from.
      if (!isCancelled(err)) api.toast(api.genError(err), 'error');
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
      chat.messages.length > 0
        ? button(
            '↺ New conversation',
            () => {
              if (
                chat.messages.length >= 2 &&
                !window.confirm('Clear this conversation and start a fresh one?')
              )
                return;
              clearConversation();
              // Re-render: the toast is an overlay-only update, so without this
              // the transcript the reader just discarded stayed on screen.
              api.refresh();
              api.toast('Fresh conversation — the old one is gone.', 'info');
            },
            'ghost',
            { title: 'Start over: forget this conversation and the brief distilled from it' },
          )
        : null,
      chat.brief
        ? h('span', { class: 'field-hint', text: 'brief ready — it also fills the seed above' })
        : null,
    ),
    // Say what the model is actually shown. A conversation is trimmed so each
    // request does not grow forever, and a reader who cannot see that would
    // reasonably wonder why the partner forgot the middle of the discussion.
    chat.messages.length > CHAT_EXCHANGES_SENT * 2
      ? h('p', {
          class: 'field-hint',
          text: `Long conversation: the partner is shown your first exchange and the last ${CHAT_EXCHANGES_SENT} — distill into a brief to keep all of it.`,
        })
      : null,
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
    field(
      'Your seed',
      textarea,
      'A sentence, a vibe, a mashup, a question — anything. Or let the model roll one for you.',
    ),
    h(
      'div',
      { class: 'row gap' },
      button(
        lucky.busy ? '🎲 Asking the model for an idea…' : '🎲 I’m feeling lucky',
        () => void rollLuckySeed(api),
        'ghost',
        {
          disabled: lucky.busy,
          title:
            lucky.cursor < lucky.pool.length
              ? 'Next of the ideas the model already gave you'
              : api.lib.settings.endpoint.model
                ? 'Ask the model for a fresh story seed (uses your starting notes)'
                : 'No model selected — this rolls one of the built-in ideas',
        },
      ),
      lucky.pool.length > 1
        ? h('span', {
            class: 'field-hint',
            text: `${Math.max(0, lucky.pool.length - lucky.cursor)} more idea(s) from the model — click again`,
          })
        : null,
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
