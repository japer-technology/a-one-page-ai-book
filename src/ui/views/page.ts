/**
 * ui/views/page.ts — the page phase. One page, short, on screen. Generate until
 * it's good: keep, regenerate, regenerate with a tweak, flip through versions,
 * or edit it yourself. Every version is kept forever.
 */
import type { AppApi } from '../ctx';
import { button, fmtNumber, h } from '../dom';
import { countWords } from '../../core/compile';
import { childrenOf, getNode, pageNumberAt, seedTextOf, titleNodeOf } from '../../core/tree';
import type { Book, StoryNode, TurnInput } from '../../core/types';
import { DEFAULT_TURN } from '../../core/types';
import { generatePage, genStates, renderGenPanel } from '../genpage';

// Session view state.
const editState = new Map<string, { open: boolean; text: string }>();
const autoStarted = new Set<string>();

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

  const directionChips = h(
    'div',
    { class: 'direction-chips' },
    data.direction.direction
      ? h('span', { class: 'chip', text: `direction: ${truncate(data.direction.direction, 90)}` })
      : null,
    data.direction.tone !== 'inherit'
      ? h('span', { class: 'chip', text: TONE_LABEL[data.direction.tone] })
      : null,
    data.direction.length !== 'standard'
      ? h('span', { class: 'chip', text: `${data.direction.length} page` })
      : null,
  );

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
    : h('div', { class: 'page-text', text: chosen.text });

  const tweakInput = h('input', {
    class: 'input',
    type: 'text',
    placeholder: '“make the keeper’s hands shake” / “end on the door, not the letter”',
  });

  const keepLabel = data.direction.ending
    ? '✔ The End — keep this closing page'
    : '✔ Keep this page →';

  return h(
    'div',
    { class: 'view view-page' },
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
          text: 'This page already has a path growing from it. A new tweak will fork a new branch — the existing path stays intact.',
        })
      : null,
    h(
      'div',
      { class: 'page-meta' },
      h('span', { text: `${fmtNumber(countWords(chosen.text))} words` }),
      h('span', { text: `${data.model || book.model || 'model'}` }),
      versionsNav(api, page),
    ),
    body,
    directionChips,
    h(
      'div',
      { class: 'actions' },
      button(
        keepLabel,
        () => {
          if (data.direction.ending) {
            api.finishBook(book, page.id, data.direction.direction || 'The End');
            api.navigate('theend');
          } else {
            api.navigate('turn', { from: page.id });
          }
        },
        'primary',
      ),
      button(
        '↻ Regenerate',
        () =>
          void generatePage(api, book, data.direction, pageNum, key, `Rewriting page ${pageNum}…`, {
            kind: 'version',
            pageId: page.id,
          }),
      ),
      button('✎ Edit this page', () => {
        editState.set(page.id, { open: true, text: chosen.text });
        api.refresh();
      }),
    ),
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
          void generatePage(api, book, direction, pageNum, key, `Writing a new page ${pageNum}…`, {
            kind: 'new',
            parentId: page.parentId,
          });
        },
        'ghost',
        { title: 'Forks a new branch from the same moment' },
      ),
    ),
  );
}

function beginView(api: AppApi, book: Book): HTMLElement {
  const titleNode = titleNodeOf(api.nodes, book);
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
            parentId: book.chosenTitleId,
          }),
      ),
    );
  }

  if (api.params.auto === '1' && !autoStarted.has(book.id)) {
    autoStarted.add(book.id);
    setTimeout(
      () =>
        void generatePage(api, book, beginDirection(api), 1, key, 'Writing page 1…', {
          kind: 'new',
          parentId: book.chosenTitleId,
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
            parentId: book.chosenTitleId,
          }),
        'primary',
      ),
    ),
  );
}

function beginDirection(api: AppApi): TurnInput {
  return { ...DEFAULT_TURN, length: api.lib.settings.defaultLength };
}

function versionsNav(api: AppApi, page: StoryNode): HTMLElement | null {
  if (page.data.kind !== 'page' || page.data.versions.length < 2) return null;
  const { versions, chosenVersion } = page.data;
  const chosen = versions[chosenVersion - 1];
  return h(
    'span',
    { class: 'version-nav' },
    button('◀', () => api.chooseVersion(page.id, Math.max(1, chosenVersion - 1)), 'ghost', {
      disabled: chosenVersion <= 1,
    }),
    ` version ${chosenVersion} of ${versions.length} `,
    button(
      '▶',
      () => api.chooseVersion(page.id, Math.min(versions.length, chosenVersion + 1)),
      'ghost',
      { disabled: chosenVersion >= versions.length },
    ),
    chosen?.by === 'user' ? ' (edited by you)' : '',
  );
}

function pageHeader(api: AppApi, book: Book, pageNum: number): HTMLElement {
  const title = titleNodeOf(api.nodes, book);
  const titleText = title.data.kind === 'title' ? title.data.title : 'Untitled';
  return h(
    'header',
    { class: 'page-head' },
    h('span', { class: 'page-num', text: `Page ${pageNum}` }),
    h('span', { class: 'page-book', text: titleText }),
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}
