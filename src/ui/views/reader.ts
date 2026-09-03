/**
 * ui/views/reader.ts — read the compiled book: title page first, then one page
 * at a time. The compiled book is just ONE path through the tree; the tree
 * itself stays alive in the library. Read-aloud turns the one-page rhythm into
 * a bedtime story, and the living cast follows along up to the current page.
 */
import type { AppApi } from '../ctx';
import { button, fmtNumber, h } from '../dom';
import { compileBook } from '../../core/compile';
import { spinePages, titleNodeOf } from '../../core/tree';
import type { Book } from '../../core/types';
import { exportCompiledFile } from '../../store/files';
import { quoteCardFor } from '../quote';
import { ambienceOn, setAmbienceMood, toggleAmbience } from '../sound';
import { renderCast } from '../cast';
import { renderStoryMemory } from '../story';

// Session view state: reading position per book + read-aloud preferences.
const positions = new Map<string, number>();
let speaking = false;
let autoAdvance = false;
let speechRate = 0.95;
let voiceName = '';
const voicesReady: string[] = [];

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
  const saved = api.lib.settings.readingPositions[book.id];
  const pos = Math.min(Math.max(positions.get(book.id) ?? saved ?? 0, 0), max);
  positions.set(book.id, pos);

  const stopSpeaking = () => {
    speaking = false;
    try {
      window.speechSynthesis?.cancel();
    } catch {
      // speech synthesis unavailable — nothing to cancel
    }
  };

  const go = (delta: number) => {
    stopSpeaking();
    const next = Math.min(Math.max(pos + delta, 0), max);
    positions.set(book.id, next);
    api.setReadingPosition(book.id, next);
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
      utterance.rate = speechRate;
      if (voiceName) {
        const voice = window.speechSynthesis.getVoices().find((v) => v.name === voiceName);
        if (voice) utterance.voice = voice;
      }
      utterance.onend = () => {
        speaking = false;
        if (autoAdvance) {
          const next = Math.min(Math.max(positions.get(book.id) ?? 0, 0) + 1, max);
          if (next !== (positions.get(book.id) ?? 0) && next <= max) {
            positions.set(book.id, next);
            api.refresh();
            const following = compiled.pages[next - 1];
            if (following && next > 0) speak(following.text);
            return;
          }
        }
        api.refresh();
      };
      utterance.onerror = () => {
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

  // Refresh the voice list lazily (browsers populate it asynchronously).
  // CRITICAL: never call api.refresh() from in here synchronously — this code
  // runs DURING render, and a synchronous re-render would recurse back into
  // renderReader forever (every level rebuilds the whole view, ballooning the
  // heap to gigabytes). Populate the picker in place; let the async
  // onvoiceschanged event trigger refreshes once the browser loads voices.
  try {
    const synth = window.speechSynthesis;
    if (synth) {
      const refreshVoices = () => {
        const names = synth.getVoices().map((v) => v.name);
        if (names.join('\n') === voicesReady.join('\n')) return; // nothing changed
        voicesReady.length = 0;
        voicesReady.push(...names);
        api.refresh();
      };
      voicesReady.length = 0;
      voicesReady.push(...synth.getVoices().map((v) => v.name));
      synth.onvoiceschanged = refreshVoices;
    }
  } catch {
    // no speech synthesis — read-aloud stays hidden
  }

  const readAloudButton = (text: string): HTMLElement =>
    button(speaking ? '⏹ Stop reading' : '🔊 Read aloud', () => speak(text), 'ghost', {
      title: 'Read this page aloud (browser voice, on-device)',
    });

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

  const readAloudControls = h(
    'div',
    { class: 'read-aloud-controls' },
    h('span', { class: 'read-aloud-label', text: '🎙️ read-aloud' }),
    voiceSelect,
    h(
      'label',
      { class: 'check-field' },
      bedtimeBox,
      h('span', { text: 'keep turning pages (bedtime mode)' }),
    ),
    h('span', { class: 'rate-wrap' }, 'speed', rateInput),
  );

  const titleNode = titleNodeOf(api.nodes, book);
  const tagline = titleNode.data.kind === 'title' ? titleNode.data.tagline : '';

  const exportRow = h(
    'div',
    { class: 'row gap' },
    button('⇓ .pdf', () => void exportCompiledFile(compiled, 'pdf'), 'ghost', {
      title: 'Export a print-ready PDF',
    }),
    button('⇓ .epub', () => void exportCompiledFile(compiled, 'epub'), 'ghost', {
      title: 'Export the book as a real EPUB e-book',
    }),
    button('⇓ .txt', () => void exportCompiledFile(compiled, 'txt')),
    button('⇓ .md', () => void exportCompiledFile(compiled, 'md')),
  );

  const ambienceButton = button(
    ambienceOn() ? '🔊 ambience: on' : '🔊 ambience: off',
    () => {
      const on = toggleAmbience();
      api.toast(on ? 'Ambience on — the room follows the mood' : 'Ambience off', 'info');
      api.refresh();
    },
    'ghost',
    { title: 'A generated soundscape that follows the mood of each page' },
  );

  const currentMood = pos > 0 ? compiled.pages[pos - 1]?.mood : null;
  setAmbienceMood(currentMood ?? null);

  const moodStrip = moodStripEl(compiled, pos, (pageNumber) => {
    stopSpeaking();
    positions.set(book.id, pageNumber);
    api.setReadingPosition(book.id, pageNumber);
  });

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
        exportRow,
      ),
    );
  }

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
          text: `A book directed page by page · ${max} pages · ${fmtNumber(compiled.words)} words`,
        }),
        compiled.seed ? h('p', { class: 'book-meta', text: `Seed: “${compiled.seed}”` }) : null,
      ),
      moodStrip,
      readAloudControls,
      h(
        'div',
        { class: 'actions' },
        button('Begin reading →', () => go(1), 'primary'),
        ambienceButton,
        exportRow,
        button('← Library', () => api.navigate('library')),
      ),
    );
  }

  const page = compiled.pages[pos - 1];
  if (!page) return h('div', { class: 'view' });
  const spine = spinePages(api.nodes, toId);
  const pageNode = spine[pos - 1];

  return h(
    'div',
    { class: 'view view-reader' },
    h(
      'header',
      { class: 'page-head' },
      h('span', { class: 'page-num', text: `Page ${page.number} of ${max}` }),
      h('span', { class: 'page-book', text: compiled.title }),
    ),
    h('div', { class: `page-text doc-${page.document ?? 'story'}`, text: page.text }),
    moodStrip,
    readAloudControls,
    h(
      'div',
      { class: 'actions' },
      button('◀', () => go(-1), 'ghost', { disabled: pos <= 1, title: 'Previous page' }),
      button('▶', () => go(1), 'primary', { disabled: pos >= max, title: 'Next page' }),
      button('≡ Title page', () => go(-pos)),
      readAloudButton(page.text),
      button('🖼️ Quote card', () => quoteCardFor(compiled, page.number), 'ghost', {
        title: 'Render this page as a shareable image',
      }),
      ambienceButton,
      exportRow,
    ),
    pageNode ? renderCast(api, book, { pageNodeId: pageNode.id }) : null,
    pageNode ? renderStoryMemory(api, book, { pageNodeId: pageNode.id }) : null,
  );
}

function findBook(api: AppApi): Book | null {
  const id = api.params.book;
  if (id) return api.lib.books.find((b) => b.id === id) ?? null;
  return api.book;
}

/** The mood map: one emoji chip per page, the current page highlighted. */
function moodStripEl(
  compiled: ReturnType<typeof compileBook>,
  current: number,
  jump: (pageNumber: number) => void,
): HTMLElement {
  const marks = compiled.pages.map((page) => ({ ...page })).filter((page) => page.mood);
  if (marks.length === 0) return h('div');
  return h(
    'div',
    { class: 'mood-strip' },
    h('span', { class: 'mood-strip-label', text: 'mood map' }),
    ...marks.map((page) =>
      h(
        'button',
        {
          class: `mood-chip${page.number === current ? ' on' : ''}`,
          type: 'button',
          title: `${page.mood?.label ?? ''} ${page.mood && page.mood.value > 0 ? '+' : ''}${page.mood?.value ?? ''}`,
          onclick: () => jump(page.number),
        },
        `${page.number}${page.mood?.icon ?? ''}${page.mood && page.mood.value > 0 ? '+' : ''}${page.mood?.value ?? ''}`,
      ),
    ),
  );
}
