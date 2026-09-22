/**
 * ui/views/page.ts — the page phase. One page, short, on screen. Generate until
 * it's good — and then CRAFT it: every paragraph can be rewritten by the model,
 * edited word by word, inserted, moved, or deleted. Every change becomes a new
 * version (all kept forever) and you can flip back and forth through versions
 * and pages. The living cast follows along.
 */
import type { AppApi } from '../ctx';
import { button, fmtDate, fmtNumber, h, pruneMap } from '../dom';
import { compileBook, countWords, joinParagraphs, paragraphsOf } from '../../core/compile';
import {
  chapterCountUpTo,
  childrenOf,
  getNode,
  pageNumberAt,
  pathToRoot,
  seedTextOf,
  spinePages,
  titleNodeOf,
} from '../../core/tree';
import type { Book, StoryNode, TurnInput } from '../../core/types';
import { DEFAULT_TURN } from '../../core/types';
import type { EmotionName } from '../../core/types';
import {
  buildContext,
  EMOTION_META,
  insertParagraphMessages,
  paragraphMessages,
  rewriteSpanMessages,
} from '../../core/prompt';
import { generateCandidates, generatePage, genStates, renderGenPanel } from '../genpage';
import { maybeUpdateBible, renderCast } from '../cast';
import { maybeUpdateSummary, renderStoryMemory } from '../story';
import { quoteCardFor } from '../quote';
import { ambienceOn, setAmbienceMood, toggleAmbience } from '../sound';
import { diffWords } from '../../core/diff';
import { lintText, lintVerdict } from '../../core/lint';
import { audit } from '../audit';

// Session view state.
const editState = new Map<string, { open: boolean; text: string }>();
/** Inline paragraph editing: key `${pageId}:${index}` (replace) or `${pageId}:after${index}` / `${pageId}:append`. */
const paraEdit = new Map<string, { text: string }>();
/** AI paragraph panels: key `${pageId}:${index}` with mode rewrite|insert, or `${pageId}:add`. */
const paraPanel = new Map<string, { mode: 'rewrite' | 'insert' | 'add'; instruction: string }>();
const showVersions = new Set<string>();
const autoStarted = new Set<string>();
const renaming = new Map<string, string>();
const diffOpen = new Set<string>();
const headingEdit = new Map<string, string>();
const candidatesBusy = new Set<string>();
/** Previous chosen version per page, for the one-click Undo. */
const lastCommit = new Map<string, number>();

const TONE_LABEL: Record<string, string> = {
  inherit: 'tone unchanged',
  darker: 'darker',
  lighter: 'lighter',
  warmer: 'warmer',
  colder: 'colder',
  funnier: 'funnier',
  'more-serious': 'more serious',
  'more-poetic': 'more poetic',
  'more-plain': 'more plain',
};

export function renderPage(api: AppApi): HTMLElement {
  // A re-render replaces the page DOM and invalidates the text selection, so
  // any floating span toolbar must die here — its offsets would target stale
  // version text otherwise.
  removeSpanToolbar();
  pruneMap(editState, 200);
  pruneMap(paraEdit, 200);
  pruneMap(paraPanel, 200);
  const book = api.book;
  if (!book)
    return h(
      'div',
      { class: 'view' },
      h('p', { text: 'No book open.' }),
      button('← Library', () => api.navigate('library')),
    );

  const frontier = getNode(api.nodes, book.frontierId);
  if (!frontier) {
    return h(
      'div',
      { class: 'view' },
      h('p', { class: 'banner banner-error', text: 'This book’s frontier node is missing.' }),
      button('← Library', () => api.navigate('library')),
    );
  }

  if (frontier.kind === 'turn') {
    setTimeout(() => api.navigate('turn', { from: frontier.parentId ?? book.chosenTitleId }), 0);
    return h('div', { class: 'view' });
  }
  if (frontier.kind === 'ending' || frontier.kind === 'seed') {
    setTimeout(() => api.navigate(book.status === 'finished' ? 'theend' : 'library'), 0);
    return h('div', { class: 'view' });
  }
  if (frontier.kind === 'title') return beginView(api, book);

  const page = frontier;
  if (page.data.kind !== 'page') return h('div', { class: 'view' });
  const data = page.data;
  const chosen = data.versions[data.chosenVersion - 1];
  if (!chosen) return h('div', { class: 'view' }, h('p', { text: 'No version selected.' }));

  installKeys(api, book, page);

  const key = `page:${book.id}`;
  const busy = genStates.get(key);
  if (busy) {
    return h(
      'div',
      { class: 'view view-page' },
      pageHeader(api, book, pageNumberAt(api.nodes, page.id)),
      renderGenPanel(
        api,
        key,
        () =>
          void generatePage(
            api,
            book,
            data.direction,
            pageNumberAt(api.nodes, page.id),
            key,
            `Rewriting page ${pageNumberAt(api.nodes, page.id)}…`,
            { kind: 'version', pageId: page.id },
          ),
      ),
    );
  }

  const pageNum = pageNumberAt(api.nodes, page.id);
  const forked = childrenOf(api.nodes, page.id).length > 0;
  const edit = editState.get(page.id) ?? { open: false, text: chosen.text };

  const body = edit.open
    ? h(
        'div',
        { class: 'edit-area' },
        h('textarea', {
          class: 'page-edit',
          rows: 16,
          value: edit.text,
          oninput: (event: Event) => {
            edit.text = (event.target as HTMLTextAreaElement).value;
          },
        }),
        h(
          'div',
          { class: 'row gap' },
          button(
            'Save as your version',
            () => {
              api.appendVersion(page.id, edit.text, 'user');
              editState.set(page.id, { open: false, text: '' });
              maybeUpdateBible(api, book, page.id);
              maybeUpdateSummary(api, book, page.id);
              api.toast('Saved as a version edited by you', 'success');
            },
            'primary',
          ),
          button('Cancel', () => {
            editState.set(page.id, { open: false, text: chosen.text });
            api.refresh();
          }),
        ),
      )
    : craftBody(api, book, page, chosen.text);

  const tweakInput = h('input', {
    class: 'input',
    type: 'text',
    placeholder: '“make the keeper’s hands shake” / “end on the door, not the letter”',
  });

  const keepLabel = data.direction.ending
    ? '✔ The End — keep this closing page'
    : '✔ Keep this page →';

  setAmbienceMood(
    data.direction.emotions && Object.keys(data.direction.emotions).length > 0
      ? (() => {
          const mood = (() => {
            let best: { label: string; value: number } | null = null;
            for (const [name, value] of Object.entries(data.direction.emotions)) {
              if (!value) continue;
              if (!best || Math.abs(value) > Math.abs(best.value)) {
                best = { label: name, value };
              }
            }
            return best;
          })();
          return mood ? { icon: '', label: mood.label, value: mood.value } : null;
        })()
      : null,
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

  const headingEditor = headingRow(api, page, chosen.text);

  return h(
    'div',
    { class: 'view view-page' },
    h(
      'div',
      { class: 'page-layout' },
      h(
        'div',
        { class: 'page-main' },
        pageHeader(api, book, pageNum),
        data.direction.ending
          ? h('div', {
              class: 'banner banner-ending',
              text: 'This page was directed to bring the story to a close.',
            })
          : null,
        forked
          ? h('div', {
              class: 'banner',
              text: 'This page already has a path growing from it. Keeping or tweaking here forks a new branch — the existing path stays intact.',
            })
          : null,
        headingEditor,
        spineNav(api, book, page),
        h(
          'div',
          { class: 'page-meta' },
          h('span', { text: `${fmtNumber(countWords(chosen.text))} words` }),
          h('span', { text: `${data.model || book.model || 'model'}` }),
        ),
        body,
        undoBar(api, page),
        directionChips(data.direction),
      ),
      h(
        'aside',
        { class: 'page-rail' },
        h(
          'div',
          { class: 'actions' },
          button(
            keepLabel,
            () => {
              if (data.direction.ending) {
                maybeUpdateBible(api, book, page.id);
                maybeUpdateSummary(api, book, page.id);
                api.finishBook(book, page.id, data.direction.direction || 'The End');
                api.navigate('theend');
              } else {
                maybeUpdateBible(api, book, page.id);
                maybeUpdateSummary(api, book, page.id);
                api.navigate('turn', { from: page.id });
              }
            },
            'primary',
          ),
          button('↻ Regenerate', () => {
            // Iron Author: a re-roll is a version, and versions are gated.
            if (!allowReroll(api, book, page)) return;
            void generatePage(
              api,
              book,
              data.direction,
              pageNum,
              key,
              `Rewriting page ${pageNum}…`,
              {
                kind: 'version',
                pageId: page.id,
              },
            );
          }),
          button('✎ Edit this page', () => {
            editState.set(page.id, { open: true, text: chosen.text });
            api.refresh();
          }),
          button(
            candidatesBusy.has(page.id)
              ? '🎲 Writing alternatives…'
              : '🎲 Generate 2 more versions',
            () => void runCandidates(api, book, page),
            'ghost',
            {
              disabled: candidatesBusy.has(page.id),
              title: 'Ask the model for two parallel alternatives, then pick your favorite',
            },
          ),
          button(
            '🖼️ Quote card',
            () => quoteCardFor(compileBook(api.nodes, book), pageNum),
            'ghost',
            {
              title: 'Render this page as a shareable image',
            },
          ),
          ambienceButton,
        ),
        candidatesSection(api, book, page),
        book.ironMode !== 'none'
          ? h('p', {
              class: 'iron-chip',
              text:
                book.ironMode === 'iron'
                  ? '⚔ Iron Author — this page is final'
                  : `⚔ Three strikes — ${rollsLeft(book, page)} re-roll${rollsLeft(book, page) === 1 ? '' : 's'} left`,
            })
          : null,
        h(
          'div',
          { class: 'row gap tweak-row' },
          tweakInput,
          button(
            'Regenerate with this tweak',
            () => {
              const tweak = tweakInput.value.trim();
              const direction: TurnInput = {
                ...data.direction,
                direction: tweak || data.direction.direction,
              };
              if (page.parentId === null) return;
              void generatePage(
                api,
                book,
                direction,
                pageNum,
                key,
                `Writing a new page ${pageNum}…`,
                {
                  kind: 'new',
                  parentId: page.parentId,
                },
                // The fork replaces THIS page number on a sibling branch, so
                // a chapter break here re-opens the same chapter this page did.
                chapterCountUpTo(api.nodes, page.id),
              );
            },
            'ghost',
            { title: 'Forks a new branch from the same moment' },
          ),
        ),
        versionPicker(api, page),
        lintCard(page),
        renderCast(api, book),
        renderStoryMemory(api, book),
        h(
          'p',
          { class: 'kbd-hint' },
          'keys: ←/→ walk pages · shift+←/→ flip versions · hover a paragraph to craft it',
        ),
        h('button', {
          class: 'help-link',
          type: 'button',
          text: '? crafting help',
          title: 'Open the help for page crafting',
          onclick: () => api.navigate('help', { section: 'craft' }),
        }),
      ),
    ),
  );
}

// ---- Paragraph crafting ---------------------------------------------------

function craftBody(api: AppApi, book: Book, page: StoryNode, text: string): HTMLElement {
  if (page.data.kind !== 'page') return h('div');
  const paras = paragraphsOf(text);
  const blocks: Array<HTMLElement | null> = [];
  paras.forEach((para, index) => {
    blocks.push(paragraphBlock(api, book, page, para, index, paras));
    blocks.push(insertEditBlock(api, book, page, index, paras));
  });
  blocks.push(addParagraphBlock(api, book, page, paras));
  const container = h(
    'div',
    {
      class: `page-text page-craft doc-${page.data.direction.document}`,
    },
    ...blocks,
  );
  container.addEventListener('mouseup', () => {
    setTimeout(() => considerSelection(api, book, page, paras), 0);
  });
  container.addEventListener('keyup', (event: KeyboardEvent) => {
    if (event.shiftKey) setTimeout(() => considerSelection(api, book, page, paras), 0);
  });
  container.addEventListener('scroll', () => removeSpanToolbar());
  return container;
}

function paragraphBlock(
  api: AppApi,
  book: Book,
  page: StoryNode,
  para: string,
  index: number,
  paras: string[],
): HTMLElement {
  if (page.data.kind !== 'page') return h('div');
  const key = `${page.id}:${index}`;
  const edit = paraEdit.get(key);
  const panel = paraPanel.get(key);
  const genKey = `para:${key}`;
  const busy = genStates.get(genKey);

  if (edit) {
    const textarea = h('textarea', {
      class: 'para-edit',
      rows: Math.max(2, Math.ceil(para.length / 90)),
      value: edit.text,
      oninput: (event: Event) => {
        edit.text = (event.target as HTMLTextAreaElement).value;
      },
    });
    return h(
      'div',
      { class: 'para para-editing' },
      textarea,
      h(
        'div',
        { class: 'row gap' },
        button(
          'Save',
          () => {
            const next = [...paras];
            next[index] = edit.text;
            commitUserVersion(
              api,
              book,
              page,
              next,
              'Paragraph saved — a new version was born',
              key,
            );
          },
          'primary',
        ),
        button('Cancel', () => {
          paraEdit.delete(key);
          api.refresh();
        }),
      ),
    );
  }

  if (busy) {
    return h(
      'div',
      { class: 'para para-busy' },
      h('p', { class: 'para-body para-dim', text: para }),
      renderGenPanel(
        api,
        genKey,
        () => void aiParagraph(api, book, page, index, paras, panel?.instruction ?? ''),
      ),
    );
  }

  const spanBusy = genStates.get(`span:${page.id}:${index}`);
  return h(
    'div',
    { class: 'para', dataset: { index: String(index) } },
    h('p', { class: 'para-body', text: para, title: `${countWords(para)} words` }),
    spanBusy
      ? renderGenPanel(api, `span:${page.id}:${index}`, () => {
          const task = spanTask.get(`span:${page.id}:${index}`) ?? {
            start: 0,
            end: para.length,
            text: para,
            instruction: '',
          };
          void aiSpanRewrite(api, book, page, index, task.start, task.end, task.text);
        })
      : null,
    h(
      'div',
      { class: 'para-tools' },
      paraTool('↻', 'Rewrite this paragraph with the model', () => {
        paraPanel.set(key, { mode: 'rewrite', instruction: '' });
        api.refresh();
      }),
      paraTool('✎', 'Edit these words yourself', () => {
        paraEdit.set(key, { text: para });
        api.refresh();
      }),
      paraTool('＋', 'Insert a paragraph after this one', () => {
        paraPanel.set(key, { mode: 'insert', instruction: '' });
        api.refresh();
      }),
      paraTool('↑', 'Move up', () => {
        if (index === 0) return;
        const next = [...paras];
        const [moved] = next.splice(index, 1);
        if (moved !== undefined) next.splice(index - 1, 0, moved);
        commitUserVersion(api, book, page, next, 'Paragraph moved', key);
      }),
      paraTool('↓', 'Move down', () => {
        if (index >= paras.length - 1) return;
        const next = [...paras];
        const [moved] = next.splice(index, 1);
        if (moved !== undefined) next.splice(index + 1, 0, moved);
        commitUserVersion(api, book, page, next, 'Paragraph moved', key);
      }),
      paraTool('✕', 'Delete this paragraph', () => {
        commitUserVersion(
          api,
          book,
          page,
          paras.filter((_, i) => i !== index),
          'Paragraph removed — every version is kept',
          key,
        );
      }),
    ),
    panel ? paragraphPanel(api, book, page, index, paras, panel) : null,
  );
}

function paragraphPanel(
  api: AppApi,
  book: Book,
  page: StoryNode,
  index: number,
  paras: string[],
  panel: { mode: 'rewrite' | 'insert' | 'add'; instruction: string },
): HTMLElement {
  const key = `${page.id}:${index}`;
  const input = h('input', {
    class: 'input para-tweak',
    type: 'text',
    value: panel.instruction,
    placeholder:
      panel.mode === 'rewrite'
        ? '“more dread”, “shorter sentences”, “his hands shake” — or leave empty'
        : '“add a line of dialogue”, “a memory of the storm” — or leave empty',
    oninput: (event: Event) => {
      panel.instruction = (event.target as HTMLInputElement).value;
    },
  });
  return h(
    'div',
    { class: 'para-panel' },
    input,
    h(
      'div',
      { class: 'row gap' },
      button(
        panel.mode === 'rewrite' ? 'Rewrite with AI' : 'Write with AI',
        () => void aiParagraph(api, book, page, index, paras, panel.instruction),
        'primary',
      ),
      button('⌨ Type it myself', () => {
        paraEdit.set(
          panel.mode === 'rewrite' ? `${page.id}:${index}` : `${page.id}:after${index}`,
          { text: panel.mode === 'rewrite' ? (paras[index] ?? '') : '' },
        );
        paraPanel.delete(key);
        api.refresh();
      }),
      button('Cancel', () => {
        paraPanel.delete(key);
        api.refresh();
      }),
    ),
  );
}

/** Handles "insert after index" inline editing (Type it myself). */
function insertEditBlock(
  api: AppApi,
  book: Book,
  page: StoryNode,
  index: number,
  paras: string[],
): HTMLElement | null {
  const key = `${page.id}:after${index}`;
  const edit = paraEdit.get(key);
  if (!edit) return null;
  const textarea = h('textarea', {
    class: 'para-edit',
    rows: 3,
    placeholder: 'Write the new paragraph…',
    oninput: (event: Event) => {
      edit.text = (event.target as HTMLTextAreaElement).value;
    },
  });
  return h(
    'div',
    { class: 'para para-editing' },
    textarea,
    h(
      'div',
      { class: 'row gap' },
      button(
        'Insert',
        () => {
          const next = [...paras];
          next.splice(index + 1, 0, edit.text);
          commitUserVersion(api, book, page, next, 'Paragraph inserted', key);
        },
        'primary',
      ),
      button('Cancel', () => {
        paraEdit.delete(key);
        api.refresh();
      }),
    ),
  );
}

function addParagraphBlock(api: AppApi, book: Book, page: StoryNode, paras: string[]): HTMLElement {
  const key = `${page.id}:add`;
  const panel = paraPanel.get(key);
  const genKey = `para:${key}`;
  const busy = genStates.get(genKey);
  const edit = paraEdit.get(`${page.id}:append`);

  if (edit) {
    const textarea = h('textarea', {
      class: 'para-edit',
      rows: 3,
      value: edit.text,
      placeholder: 'Write the new paragraph…',
      oninput: (event: Event) => {
        edit.text = (event.target as HTMLTextAreaElement).value;
      },
    });
    return h(
      'div',
      { class: 'para-add' },
      textarea,
      h(
        'div',
        { class: 'row gap' },
        button(
          'Append',
          () => {
            commitUserVersion(
              api,
              book,
              page,
              [...paras, edit.text],
              'Paragraph added',
              `${page.id}:append`,
            );
          },
          'primary',
        ),
        button('Cancel', () => {
          paraEdit.delete(`${page.id}:append`);
          api.refresh();
        }),
      ),
    );
  }

  if (busy) {
    return h(
      'div',
      { class: 'para-add' },
      renderGenPanel(
        api,
        genKey,
        () => void aiParagraph(api, book, page, paras.length, paras, panel?.instruction ?? ''),
      ),
    );
  }

  if (panel) {
    const input = h('input', {
      class: 'input para-tweak',
      type: 'text',
      value: panel.instruction,
      placeholder: '“a moment of doubt”, “describe the kitchen” — or leave empty',
      oninput: (event: Event) => {
        panel.instruction = (event.target as HTMLInputElement).value;
      },
    });
    return h(
      'div',
      { class: 'para-add' },
      input,
      h(
        'div',
        { class: 'row gap' },
        button(
          '✍ Write with AI',
          () => void aiParagraph(api, book, page, paras.length, paras, panel.instruction),
          'primary',
        ),
        button('⌨ Type it', () => {
          paraEdit.set(`${page.id}:append`, { text: '' });
          paraPanel.delete(key);
          api.refresh();
        }),
        button('Cancel', () => {
          paraPanel.delete(key);
          api.refresh();
        }),
      ),
    );
  }

  return h(
    'div',
    { class: 'para-add' },
    button('＋ Add a paragraph', () => {
      paraPanel.set(key, { mode: 'add', instruction: '' });
      api.refresh();
    }),
  );
}

function paraTool(label: string, title: string, onClick: () => void): HTMLElement {
  return h('button', {
    class: 'para-tool',
    type: 'button',
    text: label,
    title,
    onclick: onClick,
  });
}

// ---- Parallel candidates ---------------------------------------------------

function candidatesSection(api: AppApi, book: Book, page: StoryNode): HTMLElement | null {
  const keys = [...genStates.keys()].filter((key) => key.startsWith(`cand:${page.id}:`)).sort();
  if (keys.length === 0) return null;
  return h(
    'section',
    { class: 'candidates' },
    h('h3', { class: 'candidates-title', text: 'Parallel alternatives — keep the one you love' }),
    ...keys.map((key) =>
      h(
        'div',
        { class: 'candidate' },
        renderGenPanel(api, key, () => retryCandidate(api, book, page, key)),
      ),
    ),
    h(
      'div',
      { class: 'row gap' },
      button('Cancel all', () => api.abortGeneration()),
    ),
  );
}

function retryCandidate(api: AppApi, book: Book, page: StoryNode, key: string): void {
  genStates.delete(key);
  void generateCandidates(api, book, page, 1);
}

async function runCandidates(api: AppApi, book: Book, page: StoryNode): Promise<void> {
  if (candidatesBusy.has(page.id)) return; // one fan-out batch at a time
  // Iron Author: candidates are versions too, and versions are gated.
  if (!allowReroll(api, book, page)) return;
  if (page.data.kind === 'page') lastCommit.set(page.id, page.data.chosenVersion);
  candidatesBusy.add(page.id);
  const attached = await generateCandidates(api, book, page, 2);
  candidatesBusy.delete(page.id);
  if (attached > 0) {
    showVersions.add(page.id);
    api.toast(
      attached === 1
        ? 'One new version ready — flip through the version picker'
        : `${attached} new versions ready — flip through the version picker`,
      'success',
    );
  }
}

/** Drop transient editing state for a page (version flips, page walks). */
function clearCraftState(pageId: string): void {
  lastCommit.delete(pageId);
  for (const key of [...paraEdit.keys()]) {
    if (key.startsWith(`${pageId}:`)) paraEdit.delete(key);
  }
  for (const key of [...paraPanel.keys()]) {
    if (key.startsWith(`${pageId}:`)) paraPanel.delete(key);
  }
  for (const key of [...spanEdit.keys()]) {
    if (key.startsWith(`span:${pageId}:`)) spanEdit.delete(key);
  }
  for (const key of [...spanTask.keys()]) {
    if (key.startsWith(`span:${pageId}:`)) spanTask.delete(key);
  }
}

// ---- Iron Author mode ------------------------------------------------------

/** How many AI re-rolls this page has left (Iron Author difficulty). */
function rollsLeft(book: Book, page: StoryNode): number {
  const mode = book.ironMode ?? 'none';
  if (mode === 'none') return Number.POSITIVE_INFINITY;
  const used = page.data.kind === 'page' ? Math.max(0, page.data.versions.length - 1) : 0;
  const budget = mode === 'three' ? 3 : 0;
  return Math.max(0, budget - used);
}

function allowReroll(api: AppApi, book: Book, page: StoryNode): boolean {
  if (rollsLeft(book, page) > 0) return true;
  api.toast(
    '⚔ Iron Author: this page is final — keep it, or walk back and fork a new path',
    'info',
  );
  return false;
}

/** The story linter card for the control rail. */
function lintCard(page: StoryNode): HTMLElement | null {
  if (page.data.kind !== 'page') return null;
  const chosen = page.data.versions[page.data.chosenVersion - 1];
  if (!chosen || chosen.text.trim().length === 0) return null;
  const report = lintText(chosen.text);
  return h(
    'details',
    { class: 'lint-card' },
    h(
      'summary',
      { class: 'lint-summary' },
      h('span', { text: `🩺 Story linter: ${lintVerdict(report)}` }),
      h('span', {
        class: 'field-hint',
        text: `${report.words} words · ${report.sentences} sentences · ${report.paragraphs} paragraphs`,
      }),
    ),
    h(
      'div',
      { class: 'lint-body' },
      report.issues.length === 0
        ? h('p', { class: 'conflict-ok', text: '✓ Nothing the linter can smell.' })
        : h(
            'ul',
            { class: 'conflict-list' },
            ...report.issues.map((issue) =>
              h('li', {
                class: issue.severity === 'warn' ? 'lint-warn' : 'lint-info',
                text: issue.message,
              }),
            ),
          ),
      h('p', {
        class: 'field-hint',
        text: `adverbs ${Math.round(report.adverbRatio * 100)}% · dialogue ${Math.round(report.dialogueDensity * 100)}% · sentence variance ${report.sentenceVariance}`,
      }),
    ),
  );
}

function commitUserVersion(
  api: AppApi,
  book: Book,
  page: StoryNode,
  paras: string[],
  message: string,
  editKey: string,
): void {
  if (page.data.kind === 'page') lastCommit.set(page.id, page.data.chosenVersion);
  api.appendVersion(page.id, joinParagraphs(paras), 'user');
  paraEdit.delete(editKey);
  paraPanel.delete(editKey); // rewrite/insert panels share the paragraph key
  if (editKey === `${page.id}:append`) paraPanel.delete(`${page.id}:add`);
  maybeUpdateBible(api, book, page.id);
  maybeUpdateSummary(api, book, page.id);
  api.toast(message, 'success');
}

/** Rewrite/insert a paragraph with the model; stream into the block; save as a new version. */
async function aiParagraph(
  api: AppApi,
  book: Book,
  page: StoryNode,
  index: number,
  paras: string[],
  instruction: string,
): Promise<void> {
  if (page.data.kind !== 'page') return;
  if (!allowReroll(api, book, page)) return;
  const isAdd = index >= paras.length;
  const genKey = `para:${isAdd ? `${page.id}:add` : `${page.id}:${index}`}`;
  const token = api.beginGen();
  audit(`aiParagraph start key=${genKey}`);
  genStates.set(genKey, {
    token,
    status: 'busy',
    label: isAdd ? 'Writing a new paragraph…' : `Rewriting paragraph ${index + 1}…`,
    stream: '',
    error: '',
  });
  api.refresh();
  try {
    const ctx = buildContext(api.nodes, book);
    const pageNumber = pageNumberAt(api.nodes, page.id);
    const pageText = joinParagraphs(paras);
    const messages = isAdd
      ? insertParagraphMessages(ctx, pageNumber, pageText, instruction, book.rules)
      : paragraphMessages(ctx, pageNumber, pageText, paras[index] ?? '', instruction, book.rules);
    const model = book.model || api.lib.settings.endpoint.model;
    const text = await api.generateText(messages, {
      model,
      onToken: (piece) => {
        const state = genStates.get(genKey);
        if (state) state.stream += piece;
      },
    });
    if (api.staleGen(token)) {
      genStates.delete(genKey);
      return;
    }
    const cleaned = text.trim();
    if (cleaned.length === 0) throw new Error('The model returned an empty paragraph');
    // Re-read the CURRENT chosen text at commit time: the reader may have
    // edited other paragraphs while this generation ran, and we must never
    // revert their work by appending from the pre-edit snapshot.
    const chosenNow =
      page.data.kind === 'page'
        ? (page.data.versions[page.data.chosenVersion - 1]?.text ?? '')
        : '';
    const fresh = paragraphsOf(chosenNow);
    const next = [...fresh];
    if (isAdd) next.push(cleaned);
    else if (next[index] !== undefined) next[index] = cleaned;
    else next.push(cleaned);
    genStates.delete(genKey);
    paraPanel.delete(isAdd ? `${page.id}:add` : `${page.id}:${index}`);
    if (page.data.kind === 'page') lastCommit.set(page.id, page.data.chosenVersion);
    api.appendVersion(page.id, joinParagraphs(next), 'ai', model);
    maybeUpdateBible(api, book, page.id);
    maybeUpdateSummary(api, book, page.id);
    api.refresh();
    api.toast('Paragraph written — saved as a new version', 'success');
  } catch (err) {
    genStates.delete(genKey);
    if (api.staleGen(token)) {
      api.refresh();
      return;
    }
    genStates.set(genKey, {
      token,
      status: 'error',
      label: 'Paragraph generation failed',
      stream: '',
      error: api.genError(err),
    });
    api.refresh();
  }
}

// ---- Version picker -------------------------------------------------------

function versionPicker(api: AppApi, page: StoryNode): HTMLElement {
  if (page.data.kind !== 'page') return h('span');
  const { versions, chosenVersion } = page.data;
  const chosen = versions[chosenVersion - 1];
  const open = showVersions.has(page.id);
  const prev = () => {
    clearCraftState(page.id);
    api.chooseVersion(page.id, Math.max(1, chosenVersion - 1));
  };
  const next = () => {
    clearCraftState(page.id);
    api.chooseVersion(page.id, Math.min(versions.length, chosenVersion + 1));
  };

  const picker = h(
    'span',
    { class: 'version-picker' },
    button('◀', prev, 'ghost', {
      disabled: chosenVersion <= 1,
      title: 'Previous version (shift+←)',
    }),
    h('span', {
      class: 'version-now',
      text: `version ${chosenVersion} of ${versions.length}${chosen?.by === 'user' ? ' · edited by you' : ''}`,
    }),
    button('▶', next, 'ghost', {
      disabled: chosenVersion >= versions.length,
      title: 'Next version (shift+→)',
    }),
    versions.length > 1
      ? button(
          open ? '▴ All versions' : '▾ All versions',
          () => {
            if (open) showVersions.delete(page.id);
            else showVersions.add(page.id);
            api.refresh();
          },
          'ghost',
        )
      : null,
    versions.length > 1
      ? button(
          diffOpen.has(page.id) ? '▴ Hide diff' : '△ Diff vs previous',
          () => {
            if (diffOpen.has(page.id)) diffOpen.delete(page.id);
            else diffOpen.add(page.id);
            api.refresh();
          },
          'ghost',
          { title: 'Show what changed between the previous version and this one' },
        )
      : null,
  );

  const diff = diffOpen.has(page.id)
    ? h(
        'div',
        { class: 'diff-panel' },
        ...diffOf(versions[chosenVersion - 2]?.text ?? '', chosen?.text ?? ''),
      )
    : null;
  if (!open) return h('div', { class: 'version-picker-block' }, picker, diff);
  const ordered = versions
    .map((version, index) => ({ version, index }))
    .sort((a, b) => Number(b.version.pinned ?? false) - Number(a.version.pinned ?? false));
  const list = h(
    'div',
    { class: 'version-list' },
    ...ordered.map(({ version, index }) =>
      h(
        'div',
        { class: `version-row${index + 1 === chosenVersion ? ' on' : ''}` },
        h('button', {
          class: 'version-pin',
          type: 'button',
          text: version.pinned ? '📌' : '·',
          title: version.pinned ? 'Unpin this version' : 'Pin this version so it is never lost',
          onclick: () => {
            api.togglePin(page.id, index + 1);
          },
        }),
        h(
          'button',
          {
            class: 'version-item',
            type: 'button',
            title: version.text.slice(0, 120),
            onclick: () => {
              clearCraftState(page.id);
              api.chooseVersion(page.id, index + 1);
            },
          },
          `${version.pinned ? '📌 ' : ''}v${version.v} · ${version.by === 'user' ? 'you' : 'ai'} · ${fmtNumber(countWords(version.text))} words · ${fmtDate(version.at)}`,
        ),
      ),
    ),
  );
  return h('div', { class: 'version-picker-block' }, picker, list);
}

// ---- Story spine (walk the pages) -----------------------------------------

function spineNav(api: AppApi, book: Book, page: StoryNode): HTMLElement {
  const spine = spinePages(api.nodes, page.id);
  const idx = spine.findIndex((p) => p.id === page.id);
  const frontier = getNode(api.nodes, book.frontierId);
  const atFrontier = frontier?.id === page.id;
  const prevPage = idx > 0 ? spine[idx - 1] : null;
  const nextPage = idx >= 0 && idx < spine.length - 1 ? spine[idx + 1] : null;
  const nextLabel = nextPage ? `Page ${idx + 2} ▶` : atFrontier ? 'The turn ▶' : 'Frontier ▶';
  const nextAction = () => {
    if (nextPage) api.openPageAt(book, nextPage.id);
    else if (atFrontier) api.navigate('turn', { from: page.id });
    else if (frontier) {
      // Walking back from the frontier: the ▶ button must land on whatever
      // the frontier is — a turn console, the ending, or the frontier page.
      if (frontier.kind === 'turn') {
        api.navigate('turn', { from: frontier.parentId ?? book.chosenTitleId });
      } else if (frontier.kind === 'ending') {
        api.navigate('theend');
      } else {
        api.openPageAt(book, frontier.id);
      }
    }
  };

  const dots = spine.map((p, i) => {
    const branches = childrenOf(api.nodes, p.id).length;
    return h(
      'button',
      {
        class: `spine-dot${i === idx ? ' on' : ''}`,
        type: 'button',
        title: `Page ${i + 1}${branches > 1 ? ` · ${branches} paths grow from here` : ''}`,
        onclick: () => api.openPageAt(book, p.id),
      },
      `${i + 1}${branches > 1 ? '·' : ''}`,
    );
  });

  return h(
    'div',
    { class: 'spine' },
    button('◀', () => (prevPage ? api.openPageAt(book, prevPage.id) : null), 'ghost', {
      disabled: !prevPage,
      title: 'Previous page (←)',
    }),
    h('div', { class: 'spine-dots' }, ...dots),
    button(nextLabel, nextAction, 'ghost', {
      title: 'Next page (→)',
    }),
  );
}

// ---- Keyboard shortcuts ----------------------------------------------------

let keyApi: AppApi | null = null;
let keyBook: Book | null = null;
let keyPage: StoryNode | null = null;
let keysAttached = false;

function installKeys(api: AppApi, book: Book, page: StoryNode): void {
  keyApi = api;
  keyBook = book;
  keyPage = page;
  if (keysAttached) return;
  keysAttached = true;
  window.addEventListener('keydown', (event) => {
    const api = keyApi;
    const book = keyBook;
    const page = keyPage;
    if (!api || !book || !page || api.view !== 'page') return;
    if (page.data.kind !== 'page') return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.closest('input, textarea, select, [contenteditable="true"]') ||
        target.isContentEditable)
    )
      return;
    if (genStates.get(`page:${book.id}`)) return;

    if (event.key === 'Escape') {
      clearSpanToolbar();
      editState.delete(page.id);
      for (const k of [...paraEdit.keys()]) if (k.startsWith(`${page.id}:`)) paraEdit.delete(k);
      paraPanel.delete(`${page.id}:add`);
      api.refresh();
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      if (event.shiftKey) {
        const current = page.data.chosenVersion;
        const targetVersion = Math.max(1, Math.min(page.data.versions.length, current + delta));
        if (targetVersion !== current) {
          event.preventDefault();
          api.chooseVersion(page.id, targetVersion);
        }
        return;
      }
      const spine = spinePages(api.nodes, page.id);
      const idx = spine.findIndex((p) => p.id === page.id);
      const targetPage = delta > 0 ? spine[idx + 1] : spine[idx - 1];
      if (targetPage) {
        event.preventDefault();
        api.openPageAt(book, targetPage.id);
      } else if (delta > 0 && idx === spine.length - 1) {
        event.preventDefault();
        api.navigate('turn', { from: page.id });
      }
    }
  });
}

// ---- First page / begin view ----------------------------------------------

function beginView(api: AppApi, book: Book): HTMLElement {
  // The frontier IS a title here — possibly an unchosen one entered via the
  // story map, so page 1 must grow under THIS title, not the chosen one.
  const frontier = getNode(api.nodes, book.frontierId);
  const titleNode = frontier && frontier.kind === 'title' ? frontier : titleNodeOf(api.nodes, book);
  const title = titleNode.data.kind === 'title' ? titleNode.data.title : 'Untitled';
  const tagline = titleNode.data.kind === 'title' ? titleNode.data.tagline : '';
  const seed = seedTextOf(api.nodes, book);
  const key = `page:${book.id}`;
  const busy = genStates.get(key);

  if (busy) {
    return h(
      'div',
      { class: 'view view-page' },
      h(
        'header',
        { class: 'view-head' },
        h('h1', { class: 'title-hero', text: title }),
        tagline ? h('p', { class: 'lede', text: tagline }) : null,
      ),
      renderGenPanel(
        api,
        key,
        () =>
          void generatePage(api, book, beginDirection(api), 1, key, 'Writing page 1…', {
            kind: 'new',
            parentId: book.frontierId,
          }),
      ),
    );
  }

  if (api.params.auto === '1' && !autoStarted.has(book.id)) {
    audit(`beginView auto-start book=${book.id}`);
    autoStarted.add(book.id);
    setTimeout(
      () =>
        void generatePage(api, book, beginDirection(api), 1, key, 'Writing page 1…', {
          kind: 'new',
          parentId: book.frontierId,
        }),
      0,
    );
  }

  return h(
    'div',
    { class: 'view view-page' },
    h(
      'header',
      { class: 'view-head' },
      h('h1', { class: 'title-hero', text: title }),
      tagline ? h('p', { class: 'lede', text: tagline }) : null,
      h('p', { class: 'book-meta', text: `Seed: “${seed}”` }),
    ),
    h(
      'div',
      { class: 'actions' },
      button(
        '✒ Write page 1',
        () =>
          void generatePage(api, book, beginDirection(api), 1, key, 'Writing page 1…', {
            kind: 'new',
            parentId: book.frontierId,
          }),
        'primary',
      ),
      button(
        '↺ Pick another title',
        () => api.navigate('titles', { seed: book.seedNodeId }),
        'ghost',
        {
          title: 'Go back to the proposed titles — every one of them is a doorway',
        },
      ),
    ),
  );
}

function beginDirection(api: AppApi): TurnInput {
  return { ...DEFAULT_TURN, length: api.lib.settings.defaultLength };
}

function directionChips(direction: TurnInput): HTMLElement {
  const emotionChips = Object.entries(direction.emotions)
    .filter(([, value]) => value !== 0)
    .map(([name, value]) =>
      h('span', {
        class: 'chip chip-emotion',
        text: `${EMOTION_META[name as EmotionName]?.icon ?? '🎭'} ${name} ${value > 0 ? '+' : ''}${value}`,
        title: `${EMOTION_META[name as EmotionName]?.label ?? name}: ${value}`,
      }),
    );
  const chapterChip =
    direction.chapter === 'start'
      ? [h('span', { class: 'chip', text: 'chapter break' })]
      : direction.chapter === 'close'
        ? [h('span', { class: 'chip', text: 'chapter close' })]
        : [];
  return h(
    'div',
    { class: 'direction-chips' },
    direction.direction
      ? h('span', { class: 'chip', text: `direction: ${truncate(direction.direction, 90)}` })
      : null,
    direction.tone !== 'inherit'
      ? h('span', { class: 'chip', text: TONE_LABEL[direction.tone] })
      : null,
    direction.length !== 'standard' && !direction.sizeTarget
      ? h('span', { class: 'chip', text: `${direction.length} page` })
      : null,
    direction.sizeTarget
      ? h('span', {
          class: 'chip chip-size',
          text: `≈ ${direction.sizeTarget.value} ${direction.sizeTarget.kind}`,
        })
      : null,
    direction.pace !== 'inherit'
      ? h('span', { class: 'chip', text: direction.pace === 'slow' ? '🐌 slow' : '⚡ propulsive' })
      : null,
    direction.beat !== 'inherit'
      ? h('span', {
          class: 'chip',
          text: direction.beat === 'cliffhanger' ? '⛰ cliffhanger' : '🌙 resting point',
        })
      : null,
    ...chapterChip,
    ...emotionChips,
  );
}

function pageHeader(api: AppApi, book: Book, pageNum: number): HTMLElement {
  // Show the title of the branch being read — re-entering another proposed
  // title moves the frontier onto that title's branch, and the header follows.
  const byPath = pathToRoot(api.nodes, book.frontierId).find((n) => n.kind === 'title');
  const title = byPath ?? titleNodeOf(api.nodes, book);
  const titleText = title.data.kind === 'title' ? title.data.title : 'Untitled';
  const isRenaming = renaming.has(book.id);
  const renameInput = h('input', {
    class: 'input rename-input',
    type: 'text',
    value: renaming.get(book.id) ?? titleText,
    oninput: (event: Event) => {
      renaming.set(book.id, (event.target as HTMLInputElement).value);
    },
  });
  return h(
    'header',
    { class: 'page-head' },
    h('span', { class: 'page-num', text: `Page ${pageNum}` }),
    isRenaming
      ? h(
          'span',
          { class: 'page-book rename-row' },
          renameInput,
          button(
            'Save',
            () => {
              api.renameTitle(book, renaming.get(book.id) ?? titleText);
              renaming.delete(book.id);
            },
            'chip',
          ),
          button(
            '✕',
            () => {
              renaming.delete(book.id);
              api.refresh();
            },
            'chip',
          ),
        )
      : h(
          'span',
          { class: 'page-book' },
          titleText,
          button(
            '✎',
            () => {
              renaming.set(book.id, titleText);
              api.refresh();
            },
            'chip',
            { title: 'Rename this book' },
          ),
        ),
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// ---- Selection-based span control (word/sentence level) --------------------

const spanTask = new Map<
  string,
  { start: number; end: number; text: string; instruction: string }
>();

function undoBar(api: AppApi, page: StoryNode): HTMLElement | null {
  if (page.data.kind !== 'page') return null;
  const previous = lastCommit.get(page.id);
  if (previous === undefined || previous === page.data.chosenVersion) return null;
  return h(
    'div',
    { class: 'undo-bar' },
    h('span', { text: 'You just changed this page.' }),
    button(
      '↩ Undo',
      () => {
        api.chooseVersion(page.id, previous);
        lastCommit.delete(page.id);
      },
      'ghost',
    ),
    h('span', { class: 'undo-hint', text: '— or keep it; every version is saved' }),
  );
}

function considerSelection(api: AppApi, book: Book, page: StoryNode, paras: string[]): void {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    removeSpanToolbar();
    return;
  }
  const range = selection.getRangeAt(0);
  const anchorEl =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const focusEl =
    range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
  if (!anchorEl || !focusEl) {
    removeSpanToolbar();
    return;
  }
  const paraBody = anchorEl.closest('.para-body');
  if (!paraBody || paraBody !== focusEl.closest('.para-body')) {
    removeSpanToolbar();
    return;
  }
  const paraEl = paraBody.closest('.para');
  const index = Number((paraEl as HTMLElement | null)?.dataset.index ?? -1);
  if (index < 0 || index >= paras.length) {
    removeSpanToolbar();
    return;
  }
  const paragraph = paras[index] ?? '';
  // Element-level ranges (a whole-paragraph selection) report child offsets
  // against the .para-body element; text ranges report character offsets.
  const start =
    range.startContainer instanceof Element ? 0 : Math.min(range.startOffset, paragraph.length);
  const end =
    range.endContainer instanceof Element
      ? paragraph.length
      : Math.min(range.endOffset, paragraph.length);
  if (end <= start) {
    removeSpanToolbar();
    return;
  }
  const text = paragraph.slice(start, end);
  if (!text.trim()) {
    removeSpanToolbar();
    return;
  }
  const rect = range.getBoundingClientRect();
  mountSpanToolbar(api, book, page, index, start, end, text, rect.left, rect.top);
}

let spanToolbarEl: HTMLElement | null = null;

export function clearSpanToolbar(): void {
  spanTask.clear();
  removeSpanToolbar();
}

function removeSpanToolbar(): void {
  spanToolbarEl?.remove();
  spanToolbarEl = null;
}

function mountSpanToolbar(
  api: AppApi,
  book: Book,
  page: StoryNode,
  index: number,
  start: number,
  end: number,
  text: string,
  x: number,
  y: number,
): void {
  removeSpanToolbar();
  const shown = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  const genKey = `span:${page.id}:${index}`;
  const isBusy = genStates.has(genKey);
  const editing = spanEdit.has(genKey);
  const box = h(
    'div',
    { class: 'span-toolbar', style: `left:${Math.round(x)}px; top:${Math.round(y - 46)}px;` },
    h('div', { class: 'span-caption', title: text, text: `“${shown}”` }),
    editing
      ? h(
          'div',
          { class: 'span-edit' },
          h('textarea', {
            class: 'para-edit',
            rows: 3,
            value: spanEdit.get(genKey) ?? text,
            oninput: (event: Event) => {
              spanEdit.set(genKey, (event.target as HTMLTextAreaElement).value);
            },
          }),
          h(
            'div',
            { class: 'row gap' },
            button(
              'Replace',
              () => {
                const replacement = spanEdit.get(genKey) ?? text;
                spanEdit.delete(genKey);
                applySpanReplacement(api, book, page, index, start, end, replacement);
              },
              'primary',
            ),
            button('Cancel', () => {
              spanEdit.delete(genKey);
              removeSpanToolbar();
            }),
          ),
        )
      : h(
          'div',
          { class: 'row gap' },
          button(
            '↻ Rewrite',
            () => {
              removeSpanToolbar();
              spanTask.set(genKey, { start, end, text, instruction: '' });
              void aiSpanRewrite(api, book, page, index, start, end, text);
            },
            'primary',
            { disabled: isBusy },
          ),
          button('✎ Edit', () => {
            spanEdit.set(genKey, text);
            // Rebuild the floating box IN PLACE — a full api.refresh() here
            // would detach the view, destroy the selection, and (on empty
            // ranges) make getRangeAt throw.
            removeSpanToolbar();
            mountSpanToolbar(api, book, page, index, start, end, text, x, y);
          }),
          button('✕', () => removeSpanToolbar()),
        ),
  );
  document.body.appendChild(box);
  spanToolbarEl = box;
}

const spanEdit = new Map<string, string>();

function applySpanReplacement(
  api: AppApi,
  book: Book,
  page: StoryNode,
  index: number,
  start: number,
  end: number,
  replacement: string,
): void {
  const paras = paragraphsOf(
    page.data.kind === 'page' ? (page.data.versions[page.data.chosenVersion - 1]?.text ?? '') : '',
  );
  const current = paras[index];
  if (current === undefined) return;
  const next = [...paras];
  next[index] = current.slice(0, start) + replacement + current.slice(end);
  removeSpanToolbar();
  commitUserVersion(
    api,
    book,
    page,
    next,
    'Selection edited — new version saved',
    `${page.id}:${index}`,
  );
}

async function aiSpanRewrite(
  api: AppApi,
  book: Book,
  page: StoryNode,
  index: number,
  start: number,
  end: number,
  text: string,
): Promise<void> {
  if (page.data.kind !== 'page') return;
  if (!allowReroll(api, book, page)) return;
  const genKey = `span:${page.id}:${index}`;
  const task = spanTask.get(genKey) ?? { start, end, text, instruction: '' };
  spanTask.set(genKey, task);
  const token = api.beginGen();
  genStates.set(genKey, {
    token,
    status: 'busy',
    label: 'Rewriting the selection…',
    stream: '',
    error: '',
  });
  api.refresh();
  try {
    const ctx = buildContext(api.nodes, book);
    const chosen = page.data.versions[page.data.chosenVersion - 1];
    const paras = paragraphsOf(chosen?.text ?? '');
    const paragraph = paras[index] ?? '';
    const messages = rewriteSpanMessages(
      ctx,
      pageNumberAt(api.nodes, page.id),
      paragraph,
      task.text,
      task.instruction,
      book.rules,
    );
    const model = book.model || api.lib.settings.endpoint.model;
    const rewritten = await api.generateText(messages, {
      model,
      onToken: (piece) => {
        const state = genStates.get(genKey);
        if (state) state.stream += piece;
      },
    });
    if (api.staleGen(token)) {
      genStates.delete(genKey);
      return;
    }
    const cleaned = rewritten.trim();
    if (!cleaned) throw new Error('The model returned an empty span');
    genStates.delete(genKey);
    spanTask.delete(genKey);
    // Commit against the CURRENT chosen text (concurrent edits elsewhere on
    // the page must survive this rewrite).
    const chosenNow =
      page.data.kind === 'page'
        ? (page.data.versions[page.data.chosenVersion - 1]?.text ?? '')
        : '';
    const fresh = paragraphsOf(chosenNow);
    const currentParagraph = fresh[index] ?? paragraph;
    const next = [...fresh];
    next[index] =
      currentParagraph.slice(0, task.start) + cleaned + currentParagraph.slice(task.end);
    if (page.data.kind === 'page') lastCommit.set(page.id, page.data.chosenVersion);
    api.appendVersion(page.id, joinParagraphs(next), 'ai', model);
    maybeUpdateBible(api, book, page.id);
    maybeUpdateSummary(api, book, page.id);
    api.refresh();
    api.toast('Selection rewritten — saved as a new version', 'success');
  } catch (err) {
    genStates.delete(genKey);
    if (api.staleGen(token)) {
      api.refresh();
      return;
    }
    genStates.set(genKey, {
      token,
      status: 'error',
      label: 'Rewrite failed',
      stream: '',
      error: api.genError(err),
    });
    api.refresh();
  }
}

/** Inline editor for the chapter heading (first line) of a chapter-opening page. */
function headingRow(api: AppApi, page: StoryNode, text: string): HTMLElement | null {
  if (page.data.kind !== 'page' || page.data.direction.chapter !== 'start') return null;
  const data = page.data;
  const lines = text.split('\n');
  const headingIndex = lines.findIndex((line) => /^\s*chapter\b/i.test(line.trim()));
  const heading = headingIndex >= 0 ? (lines[headingIndex]?.trim() ?? '') : '';
  if (!heading) return null;
  const isEditing = headingEdit.has(page.id);
  const input = h('input', {
    class: 'input heading-input',
    type: 'text',
    value: headingEdit.get(page.id) ?? heading,
    oninput: (event: Event) => {
      headingEdit.set(page.id, (event.target as HTMLInputElement).value);
    },
  });
  const save = () => {
    const next = [...lines];
    next[headingIndex] = headingEdit.get(page.id) ?? heading;
    lastCommit.set(page.id, data.chosenVersion);
    api.appendVersion(page.id, next.join('\n'), 'user');
    headingEdit.delete(page.id);
    api.toast('Chapter heading saved as a new version', 'success');
  };
  return h(
    'div',
    { class: 'heading-row' },
    isEditing
      ? h(
          'div',
          { class: 'row gap' },
          input,
          button('Save', save, 'primary'),
          button('✕', () => {
            headingEdit.delete(page.id);
            api.refresh();
          }),
        )
      : h(
          'div',
          { class: 'row gap heading-display' },
          h('h2', { class: 'chapter-heading', text: heading }),
          button(
            '✎',
            () => {
              headingEdit.set(page.id, heading);
              api.refresh();
            },
            'chip',
            { title: 'Edit this chapter heading' },
          ),
        ),
  );
}

function diffOf(before: string, after: string): HTMLElement[] {
  return diffWords(before, after).map((part) =>
    h('span', {
      class: part.kind === 'same' ? 'diff-same' : part.kind === 'add' ? 'diff-add' : 'diff-del',
      text: part.text,
      title:
        part.kind === 'add'
          ? 'added in this version'
          : part.kind === 'del'
            ? 'in the previous version'
            : '',
    }),
  );
}

/** Open the full-page editor for a freshly hand-written page (turn view). */
export function startEditingPage(pageId: string): void {
  editState.set(pageId, { open: true, text: '' });
}
