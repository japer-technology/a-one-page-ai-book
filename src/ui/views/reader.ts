/**
 * ui/views/reader.ts — the reading room. Just the book: one page, centered,
 * nothing to edit. A slim bar turns pages and reads aloud; everything else
 * (exports, quote cards, ambience) hides behind a discreet "⋯" menu. The
 * workshop tools (cast editing, story memory) live in the page and turn
 * views, never here.
 */
import type { AppApi } from '../ctx';
import { button, fmtNumber, h } from '../dom';
import { compileBook } from '../../core/compile';
import { titleNodeOf } from '../../core/tree';
import type { Book } from '../../core/types';
import { exportCompiled } from '../export';
import { quoteCardFor } from '../quote';
import { ambienceOn, setAmbienceMood, toggleAmbience } from '../sound';

// Session view state: reading position per book + read-aloud preferences.
const positions = new Map<string, number>();
let speaking = false;
let autoAdvance = false;
let speechRate = 0.95;
let voiceName = '';
const voicesReady: string[] = [];
let voicesWired = false;
let commentaryOn = false;
/** Bumped on every cancel so a stale utterance's onend can never resurrect speech. */
let speakSeq = 0;

let readerKeysAttached = false;

/** Cancel read-aloud wherever it was started — safe to call from any view. */
export function stopReaderSpeech(): void {
  speaking = false;
  speakSeq++;
  try {
    window.speechSynthesis?.cancel();
  } catch {
    // speech synthesis unavailable — nothing to cancel
  }
}

export function renderReader(api: AppApi): HTMLElement {
  const book = findBook(api);
  if (!book) {
    return h(
      'div',
      { class: 'view' },
      h('p', { text: 'No book to read.' }),
      button('← Library', () => api.navigate('library')),
    );
  }

  const toId = api.params.to ?? book.frontierId;
  const compiled = compileBook(api.nodes, book, toId);
  const max = compiled.pages.length;
  // The prologue occupies a slot but is not a numbered page: page labels and
  // totals must count real pages only, while `max` stays the slot clamp.
  const pageCount = compiled.pages.filter((p) => p.kind !== 'prologue').length;
  const saved = api.lib.settings.readingPositions[book.id];
  const pos = Math.min(Math.max(positions.get(book.id) ?? saved ?? 0, 0), max);
  positions.set(book.id, pos);

  installReaderKeys(api, book, compiled, pos, max);

  const stopSpeaking = () => {
    stopReaderSpeech();
  };

  const go = (delta: number) => {
    stopSpeaking();
    const next = Math.min(Math.max(pos + delta, 0), max);
    if (next === pos) return;
    positions.set(book.id, next);
    api.setReadingPosition(book.id, next);
    // A fresh page starts at the top — never mid-scroll from the last one.
    window.scrollTo({ top: 0 });
  };

  const jump = (slot: number) => {
    stopSpeaking();
    if (slot === positions.get(book.id)) return;
    positions.set(book.id, slot);
    api.setReadingPosition(book.id, slot);
    window.scrollTo({ top: 0 });
  };

  const speak = (text: string) => {
    if (speaking) {
      stopSpeaking();
      api.refresh();
      return;
    }
    try {
      if (!window.speechSynthesis) {
        api.toast('This browser has no speech synthesis.', 'error');
        return;
      }
      const utterance = new SpeechSynthesisUtterance(text);
      const seq = ++speakSeq;
      utterance.rate = speechRate;
      if (voiceName) {
        const voice = window.speechSynthesis.getVoices().find((v) => v.name === voiceName);
        if (voice) utterance.voice = voice;
      }
      utterance.onend = () => {
        // A cancel (navigation, Escape, Stop) bumps speakSeq: the stale
        // onend must not auto-advance and re-start speech behind our back.
        if (seq !== speakSeq) return;
        speaking = false;
        if (autoAdvance) {
          const current = positions.get(book.id) ?? 0;
          const next = Math.min(current + 1, max);
          if (next !== current && next <= max) {
            positions.set(book.id, next);
            api.setReadingPosition(book.id, next);
            const following = compiled.pages[next - 1];
            if (following && next > 0) speak(following.text);
            return;
          }
        }
        api.refresh();
      };
      utterance.onerror = () => {
        if (seq !== speakSeq) return;
        speaking = false;
        api.refresh();
      };
      speaking = true;
      window.speechSynthesis.speak(utterance);
      api.refresh();
    } catch {
      api.toast('Read-aloud is not available here.', 'error');
    }
  };

  // Voice list, populated lazily — registered once, never during-render sync refresh.
  try {
    const synth = window.speechSynthesis;
    if (synth) {
      const refreshVoices = () => {
        const names = synth.getVoices().map((v) => v.name);
        if (names.join('\n') === voicesReady.join('\n')) return;
        voicesReady.length = 0;
        voicesReady.push(...names);
        api.refresh();
      };
      voicesReady.length = 0;
      voicesReady.push(...synth.getVoices().map((v) => v.name));
      if (!voicesWired) {
        voicesWired = true;
        synth.onvoiceschanged = refreshVoices;
      }
    }
  } catch {
    // no speech synthesis — read-aloud stays hidden
  }

  const titleNode = titleNodeOf(api.nodes, book);
  const tagline = titleNode.data.kind === 'title' ? titleNode.data.tagline : '';

  // The discreet menu: exports, quote card, ambience, commentary.
  const moreMenu = (pageNumber: number) =>
    h(
      'details',
      { class: 'menu reader-menu' },
      h('summary', { class: 'menu-btn', title: 'More reading tools', text: '⋯' }),
      h(
        'div',
        { class: 'menu-panel' },
        // On the title page (pageNumber 0) there is nothing to quote unless a
        // prologue exists — hide the item instead of clicking into silence.
        ...(compiled.pages.some((p) => p.number === pageNumber)
          ? [
              h('button', {
                class: 'menu-item',
                type: 'button',
                text: '🖼️ Quote card',
                onclick: () => quoteCardFor(compiled, pageNumber),
              }),
            ]
          : []),
        h('button', {
          class: 'menu-item',
          type: 'button',
          text: ambienceOn() ? '🔊 Ambience: on' : '🔊 Ambience: off',
          onclick: () => {
            toggleAmbience();
            api.refresh();
          },
        }),
        h('button', {
          class: 'menu-item',
          type: 'button',
          text: commentaryOn ? '💬 Commentary: on' : '💬 Commentary: off',
          onclick: () => {
            commentaryOn = !commentaryOn;
            api.refresh();
          },
        }),
        h('button', {
          class: 'menu-item',
          type: 'button',
          text: '⇓ PDF',
          onclick: () => void exportCompiled(api, compiled, 'pdf'),
        }),
        h('button', {
          class: 'menu-item',
          type: 'button',
          text: '⇓ EPUB',
          onclick: () => void exportCompiled(api, compiled, 'epub'),
        }),
        h('button', {
          class: 'menu-item',
          type: 'button',
          text: '⇓ .txt',
          onclick: () => void exportCompiled(api, compiled, 'txt'),
        }),
        h('button', {
          class: 'menu-item',
          type: 'button',
          text: '⇓ .md',
          onclick: () => void exportCompiled(api, compiled, 'md'),
        }),
        h('button', {
          class: 'menu-item',
          type: 'button',
          text: '📝 Director’s cut (.md)',
          onclick: () => void exportCompiled(api, compiled, 'directorcut'),
        }),
      ),
    );

  // Read-aloud options, folded away until asked for.
  const readAloudControls = () => {
    const voiceSelect = h(
      'select',
      { class: 'input voice-select', title: 'Pick the narrator voice' },
      h('option', {
        value: '',
        selected: voiceName === '' ? true : undefined,
        text: 'default voice',
      }),
      ...voicesReady.map((name) =>
        h('option', { value: name, selected: name === voiceName ? true : undefined, text: name }),
      ),
    );
    voiceSelect.addEventListener('change', () => {
      voiceName = voiceSelect.value;
    });
    const rateInput = h('input', {
      class: 'rate-range',
      type: 'range',
      min: '0.5',
      max: '1.5',
      step: '0.05',
      value: String(speechRate),
      title: 'Reading speed',
      oninput: (event: Event) => {
        speechRate = Number((event.target as HTMLInputElement).value);
      },
    });
    const bedtimeBox = h('input', {
      type: 'checkbox',
      checked: autoAdvance ? true : undefined,
      onchange: (event: Event) => {
        autoAdvance = (event.target as HTMLInputElement).checked;
      },
    });
    return h(
      'div',
      { class: 'read-aloud-controls' },
      h('span', { class: 'read-aloud-label', text: '🎙️ narrator' }),
      voiceSelect,
      h('span', { class: 'rate-wrap' }, 'speed', rateInput),
      h(
        'label',
        { class: 'check-field' },
        bedtimeBox,
        h('span', { text: 'keep turning pages (bedtime mode)' }),
      ),
    );
  };

  const moodStrip = moodStripEl(compiled, pos, jump);
  const currentMood = pos > 0 ? compiled.pages[pos - 1]?.mood : null;
  setAmbienceMood(currentMood ?? null);

  if (max === 0) {
    return h(
      'div',
      { class: 'view view-reader' },
      h('header', { class: 'view-head' }, h('h1', { class: 'title-hero', text: compiled.title })),
      h('p', { text: 'This book has no pages yet.' }),
      h(
        'div',
        { class: 'row gap' },
        button('← Library', () => api.navigate('library')),
      ),
    );
  }

  // Title page: just the book.
  if (pos === 0) {
    return h(
      'div',
      { class: 'view view-reader' },
      h(
        'header',
        { class: 'view-head title-page' },
        h('h1', { class: 'title-hero', text: compiled.title }),
        tagline ? h('p', { class: 'lede', text: tagline }) : null,
        h('p', {
          class: 'book-meta',
          text: `A book directed page by page · ${pageCount} pages · ${fmtNumber(compiled.words)} words`,
        }),
        compiled.seed ? h('p', { class: 'book-meta', text: `Seed: “${compiled.seed}”` }) : null,
      ),
      readAloudControls(),
      h(
        'div',
        { class: 'reader-bar' },
        button('Begin reading →', () => go(1), 'primary'),
        moreMenu(0),
        button('← Library', () => api.navigate('library')),
      ),
    );
  }

  const page = compiled.pages[pos - 1];
  if (!page) return h('div', { class: 'view' });

  const progress = `${Math.round((pos / max) * 100)}%`;

  return h(
    'div',
    { class: 'view view-reader' },
    h(
      'div',
      { class: 'reader-room' },
      h(
        'header',
        { class: 'reader-head' },
        h('span', {
          class: 'page-num',
          text: page.kind === 'prologue' ? 'Prologue' : `Page ${page.number} of ${pageCount}`,
        }),
        h('span', { class: 'page-book', text: compiled.title }),
      ),
      h(
        'article',
        { class: 'reader-sheet' },
        h('div', { class: `page-text doc-${page.document ?? 'story'}`, text: page.text }),
        commentaryOn && page.direction ? commentaryNote(page) : null,
      ),
      moodStrip,
      readAloudControls(),
      h(
        'div',
        { class: 'reader-bar' },
        button('◀', () => go(-1), 'ghost', { disabled: pos <= 1, title: 'Previous page (←)' }),
        h('span', {
          class: 'reader-progress',
          text:
            page.kind === 'prologue'
              ? `Prologue · ${pageCount} pages`
              : `${page.number} / ${pageCount}`,
        }),
        button('▶', () => go(1), 'primary', { disabled: pos >= max, title: 'Next page (→)' }),
        button('≡ Title page', () => go(-pos)),
        button(speaking ? '⏹ Stop reading' : '🔊 Read aloud', () => speak(page.text), 'ghost', {
          title: 'Read this page aloud (browser voice, on-device)',
        }),
        moreMenu(page.number),
      ),
      h(
        'div',
        { class: 'reader-progress-track' },
        h('div', { class: 'reader-progress-fill', style: `width: ${progress};` }),
      ),
    ),
  );
}

function installReaderKeys(
  api: AppApi,
  book: Book,
  compiled: ReturnType<typeof compileBook>,
  pos: number,
  max: number,
): void {
  if (readerKeysAttached) {
    readerKeyState = { api, book, compiled, pos, max };
    return;
  }
  readerKeysAttached = true;
  readerKeyState = { api, book, compiled, pos, max };
  window.addEventListener('keydown', (event) => {
    const state = readerKeyState;
    if (!state || state.api.view !== 'reader') return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.closest('input, textarea, select, [contenteditable="true"]') ||
        target.isContentEditable)
    )
      return;
    if (event.key === 'Escape') {
      stopReaderSpeech();
      state.api.refresh();
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      const next = Math.min(Math.max(state.pos + delta, 0), state.max);
      if (next === state.pos) return;
      positions.set(state.book.id, next);
      state.api.setReadingPosition(state.book.id, next);
    }
  });
}

interface ReaderKeyState {
  api: AppApi;
  book: Book;
  compiled: ReturnType<typeof compileBook>;
  pos: number;
  max: number;
}
let readerKeyState: ReaderKeyState | null = null;

function findBook(api: AppApi): Book | null {
  const id = api.params.book;
  if (id) return api.lib.books.find((b) => b.id === id) ?? null;
  return api.book;
}

/** The mood map: one emoji chip per page, the current page highlighted.
 * Chips jump by SLOT (pos), not display page number — with a prologue the two
 * differ by one, which used to open the wrong page and shift the highlight. */
function moodStripEl(
  compiled: ReturnType<typeof compileBook>,
  current: number,
  jump: (slot: number) => void,
): HTMLElement {
  const marks = compiled.pages
    .map((page, index) => ({ ...page, slot: index + 1 }))
    .filter((page) => page.mood);
  if (marks.length === 0) return h('div');
  return h(
    'div',
    { class: 'mood-strip' },
    h('span', { class: 'mood-strip-label', text: 'mood map' }),
    ...marks.map((page) =>
      h(
        'button',
        {
          class: `mood-chip${page.slot === current ? ' on' : ''}`,
          type: 'button',
          title: `${page.mood?.label ?? ''} ${page.mood && page.mood.value > 0 ? '+' : ''}${page.mood?.value ?? ''}`,
          onclick: () => jump(page.slot),
        },
        `${page.number}${page.mood?.icon ?? ''}${page.mood && page.mood.value > 0 ? '+' : ''}${page.mood?.value ?? ''}`,
      ),
    ),
  );
}

function commentaryNote(
  page: NonNullable<ReturnType<typeof compileBook>['pages'][number]>,
): HTMLElement {
  const d = page.direction;
  if (!d) return h('div');
  const parts: string[] = [];
  if (d.direction.trim()) parts.push(d.direction.trim());
  if (d.tone !== 'inherit') parts.push(`tone: ${d.tone}`);
  if (d.pace !== 'inherit') parts.push(`pace: ${d.pace}`);
  if (d.beat !== 'inherit') parts.push(`ending: ${d.beat}`);
  if (d.sizeTarget) parts.push(`${d.sizeTarget.value} ${d.sizeTarget.kind}`);
  if (d.chapter !== 'none') parts.push(`chapter: ${d.chapter}`);
  const emotions = Object.entries(d.emotions)
    .filter(([, v]) => v !== 0)
    .map(([name, v]) => `${name} ${v && v > 0 ? '+' : ''}${v}`);
  if (emotions.length > 0) parts.push(emotions.join(', '));
  return h(
    'p',
    { class: 'commentary-note' },
    h('span', { class: 'commentary-label', text: '🎬 directed: ' }),
    parts.length > 0 ? parts.join(' · ') : 'continue naturally',
  );
}
