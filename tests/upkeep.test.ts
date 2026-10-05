/**
 * tests/upkeep.test.ts — the background upkeep contract (the living cast and
 * the rolling story summary).
 *
 * The symptom these protect: writing page 1 of a brand-new book used to fire
 * TWO model requests in the same tick (the cast refresh and the memory
 * refresh). A local server with a single generation slot — LM Studio's default,
 * llama.cpp with `-np 1` — rejects the second one instead of queueing it, so
 * the reader was shown red "LLM server responded …" notices about calls they
 * never made, on a book that had only a first page.
 */
import { describe, expect, it, vi } from 'vitest';
import { maybeUpdateSummary, updateSummary } from '../src/ui/story';
import { maybeUpdateBible, updateBible } from '../src/ui/cast';
import { defaultLibrary, defaultSettings } from '../src/core/schema';
import {
  CHAT_EXCHANGES_SENT,
  chatMessages,
  luckySeedMessages,
  trimChatHistory,
} from '../src/core/prompt';
import type { ChatMessage } from '../src/core/types';
import { addNode, makeBook, makePageNode, makeSeedNode, makeTitleNode } from '../src/core/tree';
import { DEFAULT_TURN } from '../src/core/types';
import type { Book, Library, StoryNode } from '../src/core/types';
import type { AppApi } from '../src/ui/ctx';

/** seed → title → page 1. */
function onePageBook(settings: Partial<Library['settings']> = {}): {
  lib: Library;
  nodes: Record<string, StoryNode>;
  book: Book;
} {
  const seed = makeSeedNode('A keeper finds a letter.', {} as never);
  const title = makeTitleNode(seed.id, { title: 'The Dead Letter', tagline: '' });
  const page = makePageNode(title.id, { ...DEFAULT_TURN, emotions: {} }, 'm', 'A page.');
  const nodes = addNode(addNode(addNode({}, seed), title), page);
  const base = makeBook(seed.id, title.id, 'm');
  const book: Book = { ...base, frontierId: page.id };
  const lib = defaultLibrary();
  return {
    lib: {
      ...lib,
      settings: {
        ...lib.settings,
        // Both updaters bail out when no model is selected.
        endpoint: { ...lib.settings.endpoint, model: 'm' },
        ...settings,
      },
      books: [book],
      nodes,
    },
    nodes,
    book,
  };
}

interface Call {
  kind: 'text' | 'json';
  opts: Record<string, unknown>;
}

function fakeApi(state: ReturnType<typeof onePageBook>, calls: Call[]): AppApi {
  return {
    get lib() {
      return state.lib;
    },
    get nodes() {
      return state.nodes;
    },
    get book() {
      return state.book;
    },
    view: 'page',
    params: {},
    navigate: vi.fn(),
    openBook: vi.fn(),
    refresh: vi.fn(),
    toast: vi.fn(),
    update: vi.fn(),
    setBook: vi.fn(),
    generateText: (async (_messages: unknown, opts?: Record<string, unknown>) => {
      calls.push({ kind: 'text', opts: opts ?? {} });
      return 'A summary.';
    }) as unknown as AppApi['generateText'],
    generateJSON: (async (_messages: unknown, opts?: Record<string, unknown>) => {
      calls.push({ kind: 'json', opts: opts ?? {} });
      return {
        people: [{ name: 'Elin', note: 'keeper' }],
        places: [],
        things: [],
        threads: [],
        relations: [],
        summary: 'Elin keeps the light and has the letter.',
      };
    }) as unknown as AppApi['generateJSON'],
    beginGen: () => 1,
    staleGen: () => false,
    abortGeneration: vi.fn(),
    genError: (err) => (err instanceof Error ? err.message : String(err)),
    genActive: () => 0,
    newSeed: vi.fn() as never,
    appendTitles: vi.fn(),
    pickTitle: vi.fn() as never,
    attachPage: vi.fn() as never,
    appendVersion: vi.fn(),
    chooseVersion: vi.fn(),
    attachTurn: vi.fn() as never,
    finishBook: vi.fn(),
    unfinishBook: vi.fn(),
    removeBook: vi.fn(),
    duplicateBook: vi.fn() as never,
    openPageAt: vi.fn(),
    saveBible: vi.fn(),
    saveSummary: vi.fn(),
    ensureTitleNode: vi.fn() as never,
    openBranch: vi.fn(),
    setRules: vi.fn(),
    renameTitle: vi.fn(),
    togglePin: vi.fn(),
    seedFromBook: vi.fn(),
    applyAppearance: vi.fn(),
    setReadingPosition: vi.fn(),
    setTags: vi.fn(),
    markExported: vi.fn(),
    importDropped: vi.fn() as never,
    writePrologue: vi.fn(),
    setIronMode: vi.fn(),
    savePortrait: vi.fn(),
  };
}

describe('the two upkeep calls after a page', () => {
  it('does NOT fire the standalone memory call while the cast call already keeps the summary', () => {
    const state = onePageBook({ autoBible: true, autoSummary: true });
    const calls: Call[] = [];
    const api = fakeApi(state, calls);
    const pageId = state.book.frontierId;

    maybeUpdateBible(api, state.book, pageId);
    maybeUpdateSummary(api, state.book, pageId);

    // Exactly ONE request: the cast call, which writes page.data.summary too.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe('json');
    expect(calls[0]?.opts.background).toBe(true);
  });

  it('DOES fire the memory call when the cast updater is off', () => {
    const state = onePageBook({ autoBible: false, autoSummary: true });
    const calls: Call[] = [];
    const api = fakeApi(state, calls);
    const pageId = state.book.frontierId;

    maybeUpdateBible(api, state.book, pageId);
    maybeUpdateSummary(api, state.book, pageId);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe('text');
    expect(calls[0]?.opts.background).toBe(true);
  });

  it('fires nothing at all when both updaters are off', () => {
    const state = onePageBook({ autoBible: false, autoSummary: false });
    const calls: Call[] = [];
    const api = fakeApi(state, calls);

    maybeUpdateBible(api, state.book, state.book.frontierId);
    maybeUpdateSummary(api, state.book, state.book.frontierId);

    expect(calls).toHaveLength(0);
  });
});

describe('how an upkeep failure is reported', () => {
  it('keeps the automatic upkeep quiet, and the reader\u2019s own click loud', async () => {
    const state = onePageBook({ autoBible: true, autoSummary: true });
    const calls: Call[] = [];
    const api = fakeApi(state, calls);
    const pageId = state.book.frontierId;

    await updateBible(api, state.book, pageId);
    // Automatic upkeep: the panel reports it, the reader is not interrupted.
    expect(calls[0]?.opts.quiet).toBe(true);
    expect(calls[0]?.opts.background).toBe(true);

    calls.length = 0;
    await updateBible(api, state.book, pageId, { manual: true });
    expect(calls[0]?.opts.quiet).toBe(false);
  });

  it('reports a manual memory refresh normally', async () => {
    const state = onePageBook({ autoBible: false, autoSummary: true });
    const calls: Call[] = [];
    const api = fakeApi(state, calls);

    await updateSummary(api, state.book, state.book.frontierId, { manual: true });
    expect(calls[0]?.opts.quiet).toBe(false);
  });
});

describe('the cast call owns the rolling summary while it is enabled', () => {
  it('saves the summary the cast JSON carried onto the same page node', async () => {
    const state = onePageBook({ autoBible: true, autoSummary: true });
    const api = fakeApi(state, []);
    await updateBible(api, state.book, state.book.frontierId);

    expect(api.saveBible).toHaveBeenCalledTimes(1);
    expect(api.saveSummary).toHaveBeenCalledWith(
      state.book.frontierId,
      'Elin keeps the light and has the letter.',
    );
  });

  it('leaves the memory alone when the reader turned summaries off', async () => {
    const state = onePageBook({ autoBible: true, autoSummary: false });
    const api = fakeApi(state, []);
    await updateBible(api, state.book, state.book.frontierId);

    expect(api.saveBible).toHaveBeenCalledTimes(1);
    expect(api.saveSummary).not.toHaveBeenCalled();
  });
});

describe('settings defaults', () => {
  it('ships the cast updater on, the memory call off-by-ownership and auto-suggest off', () => {
    const settings = defaultSettings();
    expect(settings.autoBible).toBe(true);
    expect(settings.autoSummary).toBe(true);
    expect(settings.autoSuggest).toBe(false);
  });
});

// ---- the pre-writing conversation ------------------------------------------

const exchange = (n: number): ChatMessage[] => [
  { role: 'user', content: `idea ${n}` },
  { role: 'assistant', content: `reply ${n}` },
];

describe('the pre-writing chat chain', () => {
  it('does not grow without bound: a long conversation is windowed', () => {
    // Symptom this protects: the WHOLE history was re-sent every turn, so each
    // request was bigger than the last (2 messages, then 4, then 6 …) with no
    // ceiling — a long brainstorm buried the newest idea under the oldest ones
    // and paid for all of them on every single turn.
    const history = Array.from({ length: 40 }, (_, i) => exchange(i + 1)).flat();
    const sent = trimChatHistory(history);
    expect(sent.length).toBe(CHAT_EXCHANGES_SENT * 2);
    expect(sent.length).toBeLessThan(history.length);
  });

  it('keeps the opening exchange and the newest ones', () => {
    const history = Array.from({ length: 40 }, (_, i) => exchange(i + 1)).flat();
    const sent = trimChatHistory(history);
    // The opening exchange is where the reader said what they wanted.
    expect(sent[0]?.content).toBe('idea 1');
    expect(sent[1]?.content).toBe('reply 1');
    expect(sent.at(-1)?.content).toBe('reply 40');
    // A contiguous window of the newest turns, in order.
    expect(sent.slice(2).map((m) => m.content)).toEqual(
      history.slice(-(CHAT_EXCHANGES_SENT * 2 - 2)).map((m) => m.content),
    );
  });

  it('leaves a short conversation completely alone', () => {
    const short = [...exchange(1), ...exchange(2)];
    expect(trimChatHistory(short)).toEqual(short);
  });

  it('never returns more than the window — even when the window is one exchange', () => {
    // `slice(-0)` is `slice(0)`: the whole array. With a one-exchange window
    // this returned the ENTIRE history (opening plus everything), growing the
    // very request the trim exists to bound. The newest turns win when there
    // is no room for both.
    const history = Array.from({ length: 20 }, (_, i) => exchange(i + 1)).flat();
    const sent = trimChatHistory(history, 1);
    expect(sent.length).toBe(2);
    expect(sent.at(-1)?.content).toBe('reply 20');
  });

  it('frames the chat with the partner system prompt, not the prose one', () => {
    const framed = chatMessages(trimChatHistory([...exchange(1)]));
    expect(framed[0]?.role).toBe('system');
    expect(framed[0]?.content).toContain('writing-partner');
    expect(framed).toHaveLength(3);
  });
});

describe('the dice', () => {
  it('asks the model for seeds instead of reusing the built-in list', () => {
    // Symptom this protects: "I’m feeling lucky" could only ever offer the
    // same twelve hard-wired lines — the one button whose point is surprise was
    // the only place the model was never asked.
    const messages = luckySeedMessages(5, {
      genre: 'gothic',
      perspective: 'first',
      tense: 'past',
      tone: 'dark',
      audience: '',
      lengthHint: 'novella',
    });
    expect(messages[0]?.role).toBe('system');
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    expect(user).toContain('JSON array of 5 strings');
    // The reader's starting notes steer the roll.
    expect(user).toContain('genre: gothic');
    expect(user).toContain('first person');
    expect(user).toContain('novella');
    expect(user).toContain('distinct IN KIND');
  });

  it('tells the model what has already been offered, so rolls do not repeat', () => {
    const messages = luckySeedMessages(3, undefined, ['A story about a lighthouse']);
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    expect(user).toContain('A story about a lighthouse');
    expect(user).toContain('Do NOT reuse');
  });

  it('needs no starting notes to work', () => {
    const user = luckySeedMessages(4).find((m) => m.role === 'user')?.content ?? '';
    expect(user).toContain('JSON array of 4 strings');
    expect(user).not.toContain('Keep every seed in this register');
  });
});
