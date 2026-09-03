/**
 * ui/views/archive.ts — the story map. The whole tree of a book, laid out as a
 * timeline: the chosen spine, every discarded version of every page, and the
 * roads not taken (branches). Chosen paths are bright; unchosen paths are
 * ghosted but clickable — click any moment to re-enter and fork from it.
 */
import type { AppApi } from '../ctx';
import { button, fmtNumber, h } from '../dom';
import { countWords } from '../../core/compile';
import {
  branchTip,
  childrenOf,
  collectSubtree,
  getNode,
  pageNumberAt,
  pathToRoot,
  seedTextOf,
  spinePages,
  titleNodeOf,
} from '../../core/tree';
import type { Book, StoryNode, TurnInput } from '../../core/types';
import type { EmotionName } from '../../core/types';
import { EMOTION_META } from '../../core/prompt';

// Session state: pages selected for side-by-side comparison (up to two).
const compare = new Set<string>();
let replayTimer: ReturnType<typeof setInterval> | null = null;
let replayIndex = 0;

export function renderArchive(api: AppApi): HTMLElement {
  const book = findBook(api);
  if (!book) {
    return h(
      'div',
      { class: 'view' },
      h('p', { text: 'No book open.' }),
      button('← Library', () => api.navigate('library')),
    );
  }

  const nodes = api.nodes;
  const titleNode = titleNodeOf(nodes, book);
  const title = titleNode.data.kind === 'title' ? titleNode.data.title : 'Untitled';
  const seed = seedTextOf(nodes, book);
  const spine = spinePages(nodes, book.frontierId);
  const subtree = collectSubtree(nodes, book.seedNodeId);
  const branchCount = subtree.filter((n) => childrenOf(nodes, n.id).length > 1).length;
  const path = pathToRoot(nodes, book.frontierId);
  const ending = path.find((n) => n.kind === 'ending');

  const titles = (() => {
    const seedNode = getNode(nodes, book.seedNodeId);
    if (!seedNode || seedNode.data.kind !== 'seed' || seedNode.data.titles.length === 0)
      return null;
    return h(
      'section',
      { class: 'card archive-titles' },
      h('h2', { text: 'Every title, remembered — every one is a doorway' }),
      h('p', {
        class: 'field-hint',
        text: 'Each proposed title can be entered and written from; writing under one never touches the others. Your seed is a garden of parallel books.',
      }),
      h(
        'div',
        { class: 'title-list' },
        ...seedNode.data.titles.map((option) => {
          const titleNode = childrenOf(nodes, book.seedNodeId).find(
            (n) => n.kind === 'title' && n.data.kind === 'title' && n.data.title === option.title,
          );
          const tip = titleNode ? branchTip(nodes, titleNode.id) : null;
          const pages = tip ? spinePages(nodes, tip.id).length : 0;
          const here = tip !== null && book.frontierId === tip.id;
          const chosen = option.title === title;
          return h(
            'div',
            { class: `title-card${chosen ? ' selected' : ''}` },
            h(
              'div',
              { class: 'title-text' },
              h('h2', { text: option.title }),
              option.tagline ? h('p', { class: 'book-tagline', text: option.tagline }) : null,
            ),
            h(
              'div',
              { class: 'row gap title-actions' },
              h('span', {
                class: 'book-meta',
                text: here
                  ? '▸ you are here'
                  : chosen
                    ? 'the chosen title'
                    : pages > 0
                      ? `${pages} page${pages === 1 ? '' : 's'} written`
                      : 'not started yet',
              }),
              button('Enter', () => api.openBranch(book, option), 'chip', {
                title: 'Enter this title and write (or continue) from it',
              }),
            ),
          );
        }),
      ),
    );
  })();

  const entries = spine.map((page, index) =>
    timelineEntry(api, book, page, index + 1, spine[index + 1]?.id),
  );

  return h(
    'div',
    { class: 'view view-archive' },
    h(
      'header',
      { class: 'view-head' },
      h('h1', { class: 'title-hero', text: title }),
      h('p', { class: 'lede', text: 'The story map — a garden of possibilities.' }),
      h('p', { class: 'book-meta', text: `Seed: “${seed}”` }),
      h('p', {
        class: 'book-meta',
        text: `${spine.length} pages on the chosen path · ${subtree.length} moments · ${branchCount} branch points · ${subtree.filter((n) => n.kind === 'page').reduce((sum, n) => sum + (n.data.kind === 'page' ? n.data.versions.length : 0), 0)} versions kept`,
      }),
    ),
    h(
      'div',
      { class: 'row gap' },
      button(
        '← Back to the book',
        () => (api.book?.id === book.id ? api.navigate('page') : api.navigate('library')),
        'primary',
      ),
      button(
        '✎ Rename',
        () => {
          const name = window.prompt('Rename this book:', title);
          if (name?.trim()) api.renameTitle(book, name.trim());
        },
        'ghost',
      ),
      button('📖 Read the chosen path', () =>
        api.navigate('reader', { book: book.id, to: ending?.id ?? book.frontierId }),
      ),
      button('🏁 The frontier', () => {
        const frontier = getNode(nodes, book.frontierId);
        if (frontier?.kind === 'turn') {
          api.navigate('turn', { from: frontier.parentId ?? book.chosenTitleId });
        } else {
          api.openPageAt(book, book.frontierId);
        }
      }),
    ),
    treeMap(api, book, spine),
    replayControls(api),
    comparePanel(api, book),
    titles,
    book.rules.length > 0
      ? h(
          'section',
          { class: 'card' },
          h('h2', { text: 'Standing rules' }),
          h(
            'div',
            { class: 'rules-area' },
            ...book.rules.map((rule) => h('span', { class: 'chip rule-chip', text: rule })),
          ),
        )
      : null,
    h('section', { class: 'archive-timeline' }, ...entries),
    ending
      ? h(
          'div',
          { class: 'archive-ending' },
          h('p', { class: 'theend-kicker', text: 'T H E   E N D' }),
          h('p', {
            class: 'book-meta',
            text: ending.data.kind === 'ending' ? `“${ending.data.note}”` : '',
          }),
          button(
            'Read the finished book',
            () => api.navigate('reader', { book: book.id, to: ending.id }),
            'primary',
          ),
        )
      : null,
  );
}

function timelineEntry(
  api: AppApi,
  book: Book,
  page: StoryNode,
  pageNumber: number,
  chosenNextPageId: string | undefined,
): HTMLElement {
  if (page.data.kind !== 'page') return h('div');
  const { versions, chosenVersion, direction } = page.data;
  const chosen = versions[chosenVersion - 1];
  const preview = chosen?.text.slice(0, 140) ?? '';
  const branches = branchPagesOf(api, page, chosenNextPageId);

  const versionButtons = h(
    'div',
    { class: 'archive-versions' },
    ...versions.map((version, index) =>
      h('button', {
        class: `chip version-chip${index + 1 === chosenVersion ? ' chip-on' : ''}`,
        type: 'button',
        title: version.text.slice(0, 160),
        text: `v${version.v}${version.by === 'user' ? ' ✎' : ''} · ${fmtNumber(countWords(version.text))}w`,
        onclick: () => {
          api.chooseVersion(page.id, index + 1);
          api.toast(`Page ${pageNumber} now shows version ${index + 1}`, 'info');
        },
      }),
    ),
  );

  const moodChips = moodOf(direction);
  const directionText = direction.direction
    ? truncate(direction.direction, 120)
    : 'continue naturally';

  return h(
    'article',
    { class: 'archive-entry' },
    h(
      'div',
      { class: 'archive-entry-head' },
      h('span', { class: 'page-num', text: `Page ${pageNumber}` }),
      h('span', {
        class: 'archive-meta',
        text: `${fmtNumber(countWords(chosen?.text ?? ''))} words · ${page.data.model || book.model}`,
      }),
      button('Open', () => api.openPageAt(book, page.id), 'ghost'),
    ),
    h('p', { class: 'archive-preview', text: `${preview}…` }),
    h('p', { class: 'archive-direction', text: `turn: ${directionText}` }),
    moodChips.length > 0 ? h('div', { class: 'direction-chips' }, ...moodChips) : null,
    versionButtons,
    branches.length > 0
      ? h(
          'div',
          { class: 'archive-branches' },
          h('p', {
            class: 'archive-branch-label',
            text: `🌿 ${branches.length} road${branches.length > 1 ? 's' : ''} not taken from here`,
          }),
          ...branches.map((branch) =>
            h(
              'button',
              {
                class: 'archive-branch',
                type: 'button',
                onclick: () => api.openPageAt(book, branch.id),
              },
              h('span', {
                class: 'archive-branch-direction',
                text:
                  branch.data.kind === 'page'
                    ? truncate(branch.data.direction.direction || 'continue naturally', 80)
                    : '',
              }),
              h('span', {
                class: 'archive-branch-preview',
                text:
                  branch.data.kind === 'page'
                    ? truncate(branch.data.versions[branch.data.chosenVersion - 1]?.text ?? '', 100)
                    : '',
              }),
              h('span', { class: 'archive-branch-cta', text: 're-enter →' }),
            ),
          ),
        )
      : null,
  );
}

/** Pages that branch off this page through turn nodes, other than the chosen continuation. */
function branchPagesOf(
  api: AppApi,
  page: StoryNode,
  chosenNextPageId: string | undefined,
): StoryNode[] {
  const out: StoryNode[] = [];
  for (const turn of childrenOf(api.nodes, page.id).filter((n) => n.kind === 'turn')) {
    for (const child of childrenOf(api.nodes, turn.id)) {
      if (child.kind !== 'page') continue;
      if (child.id !== chosenNextPageId) out.push(child);
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

function moodOf(direction: TurnInput): HTMLElement[] {
  const chips: HTMLElement[] = [];
  for (const [name, value] of Object.entries(direction.emotions ?? {})) {
    if (!value) continue;
    if (!(name in EMOTION_META)) continue;
    chips.push(
      h('span', {
        class: 'chip chip-emotion',
        text: `${EMOTION_META[name as EmotionName]?.icon ?? '🎭'} ${name} ${value > 0 ? '+' : ''}${value}`,
      }),
    );
  }
  if (direction.tone && direction.tone !== 'inherit') {
    chips.push(h('span', { class: 'chip', text: direction.tone }));
  }
  if (direction.length && direction.length !== 'standard') {
    chips.push(h('span', { class: 'chip', text: `${direction.length} page` }));
  }
  return chips;
}

function findBook(api: AppApi): Book | null {
  const id = api.params.book;
  if (id) return api.lib.books.find((b) => b.id === id) ?? null;
  return api.book;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// ---- The visual tree -------------------------------------------------------

function treeMap(api: AppApi, book: Book, spine: StoryNode[]): HTMLElement {
  if (spine.length === 0) return h('div');
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'tree-map');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Story tree');

  const COL_W = 176;
  const ROW_H = 64;
  const NODE_W = 150;
  const NODE_H = 44;
  const PAD = 22;

  const columns = spine.map((page, i) => ({
    chosen: page,
    branches: branchPagesOf(api, page, spine[i + 1]?.id),
  }));
  const maxBranches = columns.reduce((max, c) => Math.max(max, c.branches.length), 0);
  const width = PAD * 2 + columns.length * COL_W;
  const height = PAD * 2 + (maxBranches + 1) * ROW_H;
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const el = (tag: string, attrs: Record<string, string | number>, text?: string): SVGElement => {
    const node = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // The chosen spine runs along the top.
  svg.appendChild(
    el('line', {
      x1: PAD + COL_W / 2,
      y1: PAD + ROW_H / 2,
      x2: width - PAD - COL_W / 2,
      y2: PAD + ROW_H / 2,
      class: 'tree-line',
    }),
  );

  columns.forEach((column, index) => {
    const cx = PAD + index * COL_W + COL_W / 2;
    const cy = PAD + ROW_H / 2;
    nodeBox(svg, el, api, book, column.chosen, cx, cy, false, index + 1);
    column.branches.forEach((branch, j) => {
      const bx = cx - COL_W / 2 + 26;
      const by = PAD + (j + 1) * ROW_H + ROW_H / 2;
      svg.appendChild(
        el('path', {
          d: `M ${cx} ${cy + NODE_H / 2} C ${cx} ${by - ROW_H / 2}, ${bx + NODE_W / 2} ${by - ROW_H / 2}, ${bx + NODE_W / 2} ${by - NODE_H / 2}`,
          class: 'tree-line tree-line-ghost',
          fill: 'none',
        }),
      );
      nodeBox(svg, el, api, book, branch, bx, by, true, index + 1);
    });
  });

  return h(
    'section',
    { class: 'card tree-card' },
    h('h2', { text: '🌳 The tree' }),
    h(
      'p',
      { class: 'field-hint' },
      'The chosen spine runs along the top; ghosted nodes are the roads not taken. Click any node to re-enter and fork from it.',
    ),
    svg,
  );
}

function nodeBox(
  svg: SVGElement,
  el: (tag: string, attrs: Record<string, string | number>, text?: string) => SVGElement,
  api: AppApi,
  book: Book,
  page: StoryNode,
  cx: number,
  cy: number,
  ghost: boolean,
  pageNumber: number,
): void {
  const ns = 'http://www.w3.org/2000/svg';
  const W = 150;
  const H = 44;
  const x = cx - W / 2;
  const y = cy - H / 2;
  if (page.data.kind !== 'page') return;
  const chosen = page.data.versions[page.data.chosenVersion - 1];
  const words = countWords(chosen?.text ?? '');

  const group = document.createElementNS(ns, 'g');
  group.setAttribute('class', ghost ? 'tree-node tree-ghost' : 'tree-node tree-chosen');
  group.addEventListener('click', () => api.openPageAt(book, page.id));
  group.appendChild(el('rect', { x, y, width: W, height: H, rx: 8 }));
  group.appendChild(
    el(
      'text',
      { x: x + 8, y: y + 17, class: 'tree-label' },
      `Page ${pageNumber} · v${page.data.chosenVersion}`,
    ),
  );
  group.appendChild(
    el(
      'text',
      { x: x + 8, y: y + 33, class: 'tree-sub' },
      `${words} words · ${page.data.versions.length} version${page.data.versions.length === 1 ? '' : 's'}`,
    ),
  );
  group.appendChild(el('title', {}, page.data.direction.direction || `Page ${pageNumber}`));
  svg.appendChild(group);
}

// ---- Side-by-side comparison -----------------------------------------------

function comparePanel(api: AppApi, book: Book): HTMLElement | null {
  const ids = [...compare].filter((id) => getNode(api.nodes, id)?.kind === 'page').slice(0, 2);
  if (ids.length < 2) {
    return compare.size > 0
      ? h('p', {
          class: 'field-hint',
          text: 'Pick a second page with “◧ Compare” to read them side by side.',
        })
      : null;
  }
  const nodes = ids
    .map((id) => getNode(api.nodes, id))
    .filter((n): n is StoryNode => n !== null && n.kind === 'page');
  if (nodes.length < 2) return null;
  return h(
    'section',
    { class: 'card compare-panel' },
    h(
      'div',
      { class: 'compare-head' },
      h('h2', { text: '◧ Side by side' }),
      button('Clear', () => {
        compare.clear();
        api.refresh();
      }),
    ),
    h(
      'div',
      { class: 'compare-grid' },
      comparePane(api, book, nodes[0]!),
      comparePane(api, book, nodes[1]!),
    ),
  );
}

function comparePane(api: AppApi, book: Book, node: StoryNode): HTMLElement {
  if (node.data.kind !== 'page') return h('div');
  const data = node.data;
  const chosen = data.versions[data.chosenVersion - 1];
  return h(
    'div',
    { class: 'compare-pane' },
    h(
      'div',
      { class: 'compare-pane-head' },
      h('span', { class: 'page-num', text: `Page ${pageNumberAt(api.nodes, node.id)}` }),
      h('span', {
        class: 'archive-meta',
        text: `version ${data.chosenVersion} of ${data.versions.length} · ${fmtNumber(countWords(chosen?.text ?? ''))} words`,
      }),
    ),
    h('div', { class: 'page-text compare-text', text: chosen?.text ?? '' }),
    h(
      'div',
      { class: 'archive-versions' },
      ...data.versions.map((version, index) =>
        h('button', {
          class: `chip version-chip${index + 1 === data.chosenVersion ? ' chip-on' : ''}`,
          type: 'button',
          text: `v${version.v}${version.by === 'user' ? ' ✎' : ''}${version.pinned ? ' 📌' : ''}`,
          onclick: () => api.chooseVersion(node.id, index + 1),
        }),
      ),
    ),
    button('Open this page →', () => api.openPageAt(book, node.id), 'ghost'),
  );
}

// ---- Time-lapse replay -----------------------------------------------------

function replayControls(api: AppApi): HTMLElement {
  const running = replayTimer !== null;
  const start = () => {
    if (running) return;
    replayIndex = 0;
    replayTimer = setInterval(() => {
      // Re-query the LIVE entries every tick: re-renders (including the one
      // below, which flips the button label) replace the DOM, so a list
      // captured up front would go stale and detached — the replay would
      // silently highlight nothing.
      const entries = [...document.querySelectorAll('.archive-entry')];
      if (entries.length === 0) {
        stop();
        return;
      }
      if (replayIndex >= entries.length) {
        stop();
        return;
      }
      entries.forEach((other) => other.classList.remove('replaying'));
      const entry = entries[replayIndex];
      entry?.classList.add('replaying');
      entry?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      replayIndex++;
    }, 1100);
    api.refresh();
  };
  const stop = () => {
    if (replayTimer) clearInterval(replayTimer);
    replayTimer = null;
    document
      .querySelectorAll('.archive-entry')
      .forEach((entry) => entry.classList.remove('replaying'));
    api.refresh();
  };
  return h(
    'div',
    { class: 'row gap replay-row' },
    button(running ? '⏹ Stop replay' : '▶ Replay the journey', running ? stop : start, 'ghost', {
      title: 'Watch the book write itself: each page lights up in order',
    }),
    h('span', { class: 'field-hint', text: 'a time-lapse of the chosen path' }),
  );
}
