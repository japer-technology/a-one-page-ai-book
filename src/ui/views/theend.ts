/**
 * ui/views/theend.ts — the book is complete. The tree remains: re-read the
 * compiled path, export it, or keep branching from the last page.
 */
import type { AppApi } from '../ctx';
import type { Book } from '../../core/types';
import { button, fmtNumber, h } from '../dom';
import { compileBook } from '../../core/compile';
import { pathToRoot, statsOf, titleNodeOf } from '../../core/tree';
import { exportCompiled } from '../export';
import { renderCast } from '../cast';
import { renderStoryMemory } from '../story';
import { buildContext, portraitMessages, prologueMessages } from '../../core/prompt';
import { genStates, renderGenPanel } from '../genpage';
import { scoreNotes } from '../../core/midi';
import { playScore } from '../sound';

export function renderTheEnd(api: AppApi): HTMLElement {
  const book = api.book;
  if (!book) {
    return h(
      'div',
      { class: 'view' },
      h('p', { text: 'No book open.' }),
      button('← Library', () => api.navigate('library')),
    );
  }

  const compiled = compileBook(api.nodes, book);
  const stats = statsOf(api.nodes, book);
  const titleNode = titleNodeOf(api.nodes, book);
  const title = titleNode.data.kind === 'title' ? titleNode.data.title : 'Untitled';

  const path = pathToRoot(api.nodes, book.frontierId);
  const ending = path.find((n) => n.kind === 'ending');
  const portrait = ending && ending.data.kind === 'ending' ? ending.data.portrait : undefined;
  const hasPrologue = compiled.pages[0]?.kind === 'prologue';
  const prologueKey = `prologue:${book.id}`;
  const portraitKey = `portrait:${book.id}`;
  const lastPage = [...path].reverse().find((n) => n.kind === 'page');
  const lastText =
    lastPage && lastPage.data.kind === 'page'
      ? lastPage.data.versions[lastPage.data.chosenVersion - 1]?.text
      : '';

  return h(
    'div',
    { class: 'view view-theend' },
    h(
      'header',
      { class: 'view-head theend-head' },
      h('p', { class: 'theend-kicker', text: 'T H E   E N D' }),
      h('h1', { class: 'title-hero', text: title }),
      h('p', {
        class: 'book-meta',
        text: `${compiled.pages.length} pages · ${fmtNumber(compiled.words)} words kept`,
      }),
      h('p', {
        class: 'book-meta',
        text: `The tree remembers: ${stats.versions} versions, ${stats.branches} branches, ${stats.nodes} moments. The compiled book is one path through it.`,
      }),
    ),
    lastText ? h('div', { class: 'page-text', text: lastText }) : null,
    ending && ending.data.kind === 'ending' && ending.data.note
      ? h('p', { class: 'book-meta', text: `Ending note: “${ending.data.note}”` })
      : null,
    portrait
      ? h(
          'div',
          { class: 'portrait' },
          h('h2', { class: 'portrait-title', text: '🪞 The Director’s Portrait' }),
          h('p', { class: 'portrait-text', text: portrait }),
        )
      : genStates.get(portraitKey)
        ? renderGenPanel(api, portraitKey, () => void writePortrait(api, book, portraitKey))
        : null,
    hasPrologue && compiled.pages[0]
      ? h(
          'div',
          { class: 'prologue' },
          h('h2', { class: 'portrait-title', text: '🌱 The Prologue That Knew' }),
          h('div', { class: 'page-text', text: compiled.pages[0].text }),
        )
      : null,
    genStates.get(prologueKey)
      ? renderGenPanel(api, prologueKey, () => void writePrologue(api, book, prologueKey))
      : null,
    h(
      'div',
      { class: 'actions' },
      button('📖 Read the book', () => api.navigate('reader', { book: book.id }), 'primary'),
      button('📊 About this book', () => api.navigate('about', { book: book.id }), 'ghost', {
        title: 'The full ledger: words, versions, decisions, models',
      }),
      button('🗺️ Story map', () => api.navigate('archive', { book: book.id }), 'ghost', {
        title: 'See every path, version and road not taken',
      }),
      button('➡️ Write a sequel', () => api.seedFromBook(book.id), 'ghost', {
        title: 'Seed a new book that inherits this cast and threads',
      }),
      button(
        hasPrologue ? '↻ Rewrite the prologue' : '🌱 Write the prologue',
        () => void writePrologue(api, book, prologueKey),
        'ghost',
        { title: 'Page zero that plants the ending’s seeds' },
      ),
      button(
        '🪞 The Director’s Portrait',
        () => void writePortrait(api, book, portraitKey),
        'ghost',
        {
          title: 'A playful reading of your directing style',
        },
      ),
      button('⇓ .epub', () => void exportCompiled(api, compiled, 'epub'), 'ghost', {
        title: 'Export the book as a real EPUB e-book',
      }),
      button('⇓ .txt', () => void exportCompiled(api, compiled, 'txt')),
      button('⇓ .md', () => void exportCompiled(api, compiled, 'md')),
      button(
        '📝 Director’s cut (.md)',
        () => void exportCompiled(api, compiled, 'directorcut'),
        'ghost',
        {
          title: 'The commentary edition: every page with the decisions that made it',
        },
      ),
      button('⇓ .mid', () => void exportCompiled(api, compiled, 'midi'), 'ghost', {
        title: 'The score of your book as a MIDI file',
      }),
      button('▶ Play the score', () => playScore(scoreNotes(compiled)), 'ghost', {
        title: 'Hear the mood map performed',
      }),
      button(
        '🌿 Keep branching',
        () => {
          api.unfinishBook(book);
          api.navigate('page');
        },
        'ghost',
        { title: 'Un-end the book and grow a new branch from the last page' },
      ),
      button('← Library', () => api.navigate('library')),
    ),
    renderCast(api, book),
    renderStoryMemory(api, book),
  );
}

async function writePrologue(api: AppApi, book: Book, key: string): Promise<void> {
  const token = api.beginGen();
  genStates.set(key, {
    token,
    status: 'busy',
    label: 'Writing the prologue that knew…',
    stream: '',
    error: '',
  });
  api.refresh();
  try {
    const ctx = buildContext(api.nodes, book);
    const model = book.model || api.lib.settings.endpoint.model;
    const text = await api.generateText(prologueMessages(ctx), {
      model,
      onToken: (piece) => {
        const state = genStates.get(key);
        if (state) state.stream += piece;
      },
    });
    if (api.staleGen(token)) {
      genStates.delete(key);
      return;
    }
    const cleaned = text.trim();
    if (!cleaned) throw new Error('The model returned an empty prologue');
    genStates.delete(key);
    api.writePrologue(book, cleaned, model);
    api.toast('The prologue that knew — page zero is written', 'success');
  } catch (err) {
    genStates.delete(key);
    if (api.staleGen(token)) return;
    genStates.set(key, {
      token,
      status: 'error',
      label: 'Prologue failed',
      stream: '',
      error: api.genError(err),
    });
    api.refresh();
  }
}

async function writePortrait(api: AppApi, book: Book, key: string): Promise<void> {
  const token = api.beginGen();
  genStates.set(key, {
    token,
    status: 'busy',
    label: 'Sketching the Director’s Portrait…',
    stream: '',
    error: '',
  });
  api.refresh();
  try {
    const ctx = buildContext(api.nodes, book);
    const stats = statsOf(api.nodes, book);
    const model = book.model || api.lib.settings.endpoint.model;
    const text = await api.generateText(
      portraitMessages(ctx, {
        pages: stats.pages,
        versions: stats.versions,
        branches: stats.branches,
        wordsKept: stats.words,
      }),
      {
        model,
        onToken: (piece) => {
          const state = genStates.get(key);
          if (state) state.stream += piece;
        },
      },
    );
    if (api.staleGen(token)) {
      genStates.delete(key);
      return;
    }
    const cleaned = text.trim();
    if (!cleaned) throw new Error('The model returned an empty portrait');
    genStates.delete(key);
    api.savePortrait(book, cleaned);
    api.toast('Your portrait hangs in the book', 'success');
  } catch (err) {
    genStates.delete(key);
    if (api.staleGen(token)) return;
    genStates.set(key, {
      token,
      status: 'error',
      label: 'Portrait failed',
      stream: '',
      error: api.genError(err),
    });
    api.refresh();
  }
}
