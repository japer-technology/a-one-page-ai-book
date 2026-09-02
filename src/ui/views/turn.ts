/**
 * ui/views/turn.ts — THE PAGE TURN. The last page stays on screen, dimmed;
 * below it, the director's console: what happens next. Zero inputs is a valid
 * choice ("continue naturally" is still a decision). Suggested directions are
 * proposed by the model and grounded in the story so far.
 */
import type { AppApi } from '../ctx';
import { button, field, h, spinner } from '../dom';
import { buildContext, suggestionsMessages } from '../../core/prompt';
import { getNode, pageNumberAt, titleNodeOf } from '../../core/tree';
import type { Book, LengthPreference, StoryNode, Tone, TurnInput } from '../../core/types';
import { DEFAULT_TURN } from '../../core/types';
import { generatePage, genStates, renderGenPanel } from '../genpage';

// Session view state: turn inputs survive re-renders.
const inputs = new Map<string, TurnInput>();
const suggestions = new Map<string, string[]>();

export function renderTurn(api: AppApi): HTMLElement {
  const book = api.book;
  if (!book)
    return h(
      'div',
      { class: 'view' },
      button('← Library', () => api.navigate('library')),
    );

  const fromId = api.params.from ?? frontierParent(api);
  const from = fromId ? getNode(api.nodes, fromId) : null;
  if (!from || from.data.kind !== 'page') {
    return h(
      'div',
      { class: 'view' },
      h('p', { text: 'Nothing to turn from.' }),
      button('← Library', () => api.navigate('library')),
    );
  }

  const key = `turn:${book.id}`;
  const busy = genStates.get(key);
  if (busy) {
    return h(
      'div',
      { class: 'view view-turn' },
      fadedPage(api, book, from),
      renderGenPanel(api, key, () => void generateNext(api, book, from, key)),
    );
  }

  const stateKey = `${book.id}:${from.id}`;
  const input = inputs.get(stateKey) ?? { ...DEFAULT_TURN };
  inputs.set(stateKey, input);

  const directionBox = h('textarea', {
    class: 'input direction-input',
    rows: 3,
    placeholder: 'What happens next? (leave empty to continue naturally)',
    value: input.direction,
    oninput: (event: Event) => {
      input.direction = (event.target as HTMLTextAreaElement).value;
    },
  });

  const lengthControl = segmented(
    [
      ['shorter', 'shorter'],
      ['standard', 'standard'],
      ['longer', 'longer'],
    ],
    input.length,
    (value) => {
      input.length = value as LengthPreference;
    },
  );

  const toneSelect = h(
    'select',
    {
      class: 'input',
      onchange: (event: Event) => {
        input.tone = (event.target as HTMLSelectElement).value as Tone;
      },
    },
    ...[
      ['inherit', 'tone: inherit'],
      ['darker', 'darker'],
      ['lighter', 'lighter'],
      ['warmer', 'warmer'],
      ['colder', 'colder'],
      ['funnier', 'funnier'],
      ['more-serious', 'more serious'],
      ['more-poetic', 'more poetic'],
      ['more-plain', 'more plain'],
    ].map(([v, label]) =>
      h('option', { value: v, selected: v === input.tone ? true : undefined, text: label }),
    ),
  );

  const endingBox = h('input', {
    type: 'checkbox',
    checked: input.ending ? true : undefined,
    onchange: (event: Event) => {
      input.ending = (event.target as HTMLInputElement).checked;
    },
  });

  const applySuggestion = (item: string) => {
    input.direction = item;
    directionBox.value = item;
  };

  const suggestArea = h('div', { class: 'suggest-area' });
  for (const item of suggestions.get(stateKey) ?? []) {
    suggestArea.appendChild(
      h('button', {
        class: 'chip chip-suggest',
        type: 'button',
        text: item,
        onclick: () => applySuggestion(item),
      }),
    );
  }

  return h(
    'div',
    { class: 'view view-turn' },
    fadedPage(api, book, from),
    h(
      'section',
      { class: 'turn-panel' },
      h('h2', { class: 'turn-title', text: 'The page is written. What happens next?' }),
      field('Direction', directionBox, 'A one-liner is plenty — or nothing at all.'),
      h(
        'div',
        { class: 'row gap' },
        button('✨ Suggest directions', () => void suggest(api, book, stateKey, suggestArea)),
      ),
      suggestArea,
      h('div', { class: 'grid-2' }, field('Page length', lengthControl), field('Tone', toneSelect)),
      h(
        'label',
        { class: 'field check-field' },
        endingBox,
        h('span', { text: ' Bring the story to a close with this page' }),
      ),
      h(
        'div',
        { class: 'actions' },
        button('Generate next page →', () => void generateNext(api, book, from, key), 'primary'),
        button('Continue naturally', () => {
          inputs.set(stateKey, { ...DEFAULT_TURN });
          void generateNext(api, book, from, key, true);
        }),
      ),
    ),
  );
}

function frontierParent(api: AppApi): string | null {
  const book = api.book;
  if (!book) return null;
  const frontier = getNode(api.nodes, book.frontierId);
  return frontier ? frontier.parentId : null;
}

function fadedPage(api: AppApi, book: Book, from: StoryNode): HTMLElement {
  const title = titleNodeOf(api.nodes, book);
  const titleText = title.data.kind === 'title' ? title.data.title : 'Untitled';
  const chosen =
    from.data.kind === 'page' ? from.data.versions[from.data.chosenVersion - 1] : undefined;
  return h(
    'div',
    { class: 'faded-page' },
    h('span', { class: 'page-num', text: `Page ${pageNumberAt(api.nodes, from.id)} · kept ✓` }),
    h('span', { class: 'page-book', text: titleText }),
    h('div', { class: 'page-text faded-text', text: chosen?.text ?? '' }),
  );
}

async function suggest(
  api: AppApi,
  book: Book,
  stateKey: string,
  area: HTMLElement,
): Promise<void> {
  const token = api.beginGen();
  area.replaceChildren(spinner(), ' thinking…');
  try {
    const context = buildContext(api.nodes, book);
    const raw = await api.generateJSON<string[]>(suggestionsMessages(context, 3), {
      model: book.model || api.lib.settings.endpoint.model,
    });
    if (api.staleGen(token)) return;
    const list = raw.filter((s) => typeof s === 'string' && s.length > 0).slice(0, 3);
    suggestions.set(stateKey, list);
    api.refresh();
  } catch (err) {
    if (api.staleGen(token)) return;
    area.replaceChildren();
    api.toast(api.genError(err), 'error');
  }
}

async function generateNext(
  api: AppApi,
  book: Book,
  from: StoryNode,
  key: string,
  naturally = false,
): Promise<void> {
  const stateKey = `${book.id}:${from.id}`;
  const input = naturally ? { ...DEFAULT_TURN } : (inputs.get(stateKey) ?? { ...DEFAULT_TURN });
  inputs.set(stateKey, input);
  // Retry after a failed generation reuses the recorded decision instead of
  // creating a duplicate turn node (which would fake a branch point).
  const frontier = getNode(api.nodes, book.frontierId);
  const turn =
    frontier && frontier.kind === 'turn' && frontier.parentId === from.id
      ? frontier
      : api.attachTurn(book, from.id, input);
  const nextPageNumber = pageNumberAt(api.nodes, from.id) + 1;
  const node = await generatePage(
    api,
    book,
    input,
    nextPageNumber,
    key,
    `Writing page ${nextPageNumber}…`,
    {
      kind: 'new',
      parentId: turn.id,
    },
  );
  if (node) api.navigate('page');
}

function segmented(
  options: Array<[string, string]>,
  value: string,
  onChange: (value: string) => void,
): HTMLElement {
  const group = h(
    'div',
    { class: 'segmented' },
    ...options.map(([v, label]) =>
      h('button', {
        class: `seg${v === value ? ' seg-on' : ''}`,
        type: 'button',
        text: label,
        onclick: () => {
          onChange(v);
          for (const seg of Array.from(group.querySelectorAll('.seg'))) {
            seg.classList.toggle('seg-on', seg.textContent === label);
          }
        },
      }),
    ),
  );
  return group;
}
