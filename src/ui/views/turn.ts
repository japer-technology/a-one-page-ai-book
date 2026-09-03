/**
 * ui/views/turn.ts — THE PAGE TURN. The last page stays on screen, dimmed;
 * below it, the director's console: what happens next. Zero inputs is a valid
 * choice ("continue naturally" is still a decision). Suggested directions are
 * proposed by the model and can be stepped through back and forth; emotion
 * dials compile into calibrated structural instructions; standing rules are
 * the "don't touch" constraints that persist until removed.
 */
import type { AppApi } from '../ctx';
import { button, field, h, spinner } from '../dom';
import {
  buildContext,
  endingsMessages,
  EMOTION_META,
  suggestionsMessages,
} from '../../core/prompt';
import { getNode, pageNumberAt, titleNodeOf } from '../../core/tree';
import type {
  Book,
  ChapterIntent,
  LengthPreference,
  PageSizeTarget,
  StoryNode,
  Tone,
  TurnInput,
} from '../../core/types';
import { DEFAULT_TURN, DOCUMENT_META, DOCUMENT_FORMATS, EMOTION_NAMES } from '../../core/types';
import { generatePage, genStates, renderGenPanel } from '../genpage';
import { renderCast } from '../cast';
import { renderStoryMemory } from '../story';
import { startEditingPage } from './page';

// Session view state: turn inputs survive re-renders.
const inputs = new Map<string, TurnInput>();
const suggestions = new Map<string, string[]>();
const suggestIndex = new Map<string, number>();
const autoSuggested = new Set<string>();
const endings = new Map<string, Array<{ title: string; premise: string }>>();

const RULE_PRESETS = [
  'Don’t reveal the letter yet',
  'Don’t introduce a love interest',
  'Don’t kill anyone',
  'Don’t leave the island',
  'Keep the story in the past tense',
  'Don’t change the point-of-view character',
  'Don’t resolve the mystery too fast',
  'Don’t reveal the stranger’s name',
];

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
  const input = inputs.get(stateKey) ?? { ...DEFAULT_TURN, emotions: {} };
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

  // ---- Page size: presets + precise word/paragraph/character targets -------
  const sizeTarget = input.sizeTarget;
  const sizeNumber = h('input', {
    class: 'input size-number',
    type: 'number',
    min: '1',
    max: '200000',
    value: String(sizeTarget?.value ?? 300),
    oninput: (event: Event) => {
      const value = Number((event.target as HTMLInputElement).value);
      if (Number.isFinite(value) && value > 0) {
        input.sizeTarget = {
          kind: sizeUnit.value as PageSizeTarget['kind'],
          value: Math.round(value),
        };
      }
    },
  });
  const sizeUnit = h(
    'select',
    {
      class: 'input size-unit',
      onchange: (event: Event) => {
        const kind = (event.target as HTMLSelectElement).value as PageSizeTarget['kind'];
        const value = Number(sizeNumber.value);
        if (Number.isFinite(value) && value > 0)
          input.sizeTarget = { kind, value: Math.round(value) };
      },
    },
    ...[
      ['words', 'words'],
      ['paragraphs', 'paragraphs'],
      ['chars', 'characters'],
    ].map(([v, label]) =>
      h('option', {
        value: v,
        selected: v === (sizeTarget?.kind ?? 'words') ? true : undefined,
        text: label,
      }),
    ),
  );
  const lengthControl = h(
    'div',
    { class: 'size-control' },
    segmented(
      [
        ['shorter', 'shorter'],
        ['standard', 'standard'],
        ['longer', 'longer'],
        ['custom', 'custom…'],
      ],
      sizeTarget ? 'custom' : input.length,
      (value) => {
        if (value === 'custom') {
          input.sizeTarget = { kind: 'words', value: 320 };
        } else {
          input.sizeTarget = null;
          input.length = value as LengthPreference;
        }
        api.refresh();
      },
    ),
    sizeTarget
      ? h(
          'div',
          { class: 'row gap size-row' },
          h('span', { class: 'size-label', text: 'exactly about' }),
          sizeNumber,
          sizeUnit,
        )
      : null,
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

  const chapterSelect = h(
    'select',
    {
      class: 'input',
      onchange: (event: Event) => {
        input.chapter = (event.target as HTMLSelectElement).value as ChapterIntent;
      },
    },
    ...[
      ['none', 'no chapter break'],
      ['start', '⧉ start a new chapter'],
      ['close', '↘ bring this chapter to a close'],
    ].map(([v, label]) =>
      h('option', { value: v, selected: v === input.chapter ? true : undefined, text: label }),
    ),
  );

  const documentSelect = h(
    'select',
    {
      class: 'input',
      title: 'What kind of page should this be?',
      onchange: (event: Event) => {
        input.document = (event.target as HTMLSelectElement).value as typeof input.document;
      },
    },
    ...DOCUMENT_FORMATS.map((format) =>
      h('option', {
        value: format,
        selected: format === input.document ? true : undefined,
        text: `${DOCUMENT_META[format].icon} ${DOCUMENT_META[format].label}`,
      }),
    ),
  );

  const endingBox = h('input', {
    type: 'checkbox',
    checked: input.ending ? true : undefined,
    onchange: (event: Event) => {
      input.ending = (event.target as HTMLInputElement).checked;
    },
  });

  // ---- Suggested directions, with back/forth stepping ----------------------
  const list = suggestions.get(stateKey) ?? [];
  const sIndex = Math.min(
    Math.max(suggestIndex.get(stateKey) ?? 0, 0),
    Math.max(0, list.length - 1),
  );
  const applySuggestion = (item: string) => {
    input.direction = item;
    directionBox.value = item;
  };
  const stepSuggestion = (delta: number) => {
    if (list.length === 0) return;
    const nextIndex = (sIndex + delta + list.length) % list.length;
    suggestIndex.set(stateKey, nextIndex);
    const item = list[nextIndex];
    if (item) applySuggestion(item);
    api.refresh();
  };

  const suggestArea = h('div', { class: 'suggest-area' });
  list.forEach((item, index) => {
    suggestArea.appendChild(
      h('button', {
        class: `chip chip-suggest${index === sIndex ? ' chip-on' : ''}`,
        type: 'button',
        text: item,
        onclick: () => {
          suggestIndex.set(stateKey, index);
          applySuggestion(item);
          api.refresh();
        },
      }),
    );
  });
  if (list.length > 1) {
    suggestArea.appendChild(
      h(
        'span',
        { class: 'suggest-nav' },
        button('◀', () => stepSuggestion(-1), 'chip', { title: 'Previous suggestion' }),
        h('span', { class: 'suggest-count', text: `${sIndex + 1} of ${list.length}` }),
        button('▶', () => stepSuggestion(1), 'chip', { title: 'Next suggestion' }),
      ),
    );
  }

  // ---- Emotion dials -------------------------------------------------------
  const touchedCount = Object.keys(input.emotions).length;
  const dials = h(
    'div',
    { class: 'dial-grid' },
    ...EMOTION_NAMES.map((name) => dialRow(name, input)),
  );

  // ---- Standing rules ------------------------------------------------------
  const rules = book.rules ?? [];
  const ruleInput = h('input', {
    class: 'input rule-input',
    type: 'text',
    list: 'rule-presets',
    placeholder: '“Don’t reveal the letter yet” — lasts until you remove it',
    onkeydown: (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addRule();
      }
    },
  });
  const addRule = () => {
    const rule = ruleInput.value.trim();
    if (!rule) return;
    api.setRules(book, [...rules, rule]);
    ruleInput.value = '';
  };
  const rulesArea = h(
    'div',
    { class: 'rules-area' },
    ...rules.map((rule) =>
      h(
        'span',
        { class: 'chip rule-chip' },
        rule,
        h('button', {
          class: 'rule-x',
          type: 'button',
          title: 'Remove this standing rule',
          text: '✕',
          onclick: () =>
            api.setRules(
              book,
              rules.filter((r) => r !== rule),
            ),
        }),
      ),
    ),
  );
  const rulePresets = h(
    'datalist',
    { id: 'rule-presets' },
    ...RULE_PRESETS.map((p) => h('option', { value: p })),
  );

  // ---- Auto-suggest --------------------------------------------------------
  if (
    api.lib.settings.autoSuggest &&
    list.length === 0 &&
    !autoSuggested.has(stateKey) &&
    !genStates.has(`turn:${book.id}`)
  ) {
    autoSuggested.add(stateKey);
    setTimeout(() => void suggest(api, book, stateKey, suggestArea), 0);
  }

  // ---- Proposed endings ----------------------------------------------------
  const endingList = endings.get(stateKey) ?? [];
  const endingsArea = input.ending
    ? h(
        'div',
        { class: 'endings-area' },
        h(
          'div',
          { class: 'row gap' },
          button('✨ Propose endings', () => void proposeEndings(api, book, stateKey, endingsArea)),
        ),
        ...endingList.map((ending) =>
          h('button', {
            class: 'chip chip-suggest',
            type: 'button',
            text: `${ending.title} — ${ending.premise}`,
            title: 'Use this ending as the direction',
            onclick: () => {
              input.direction = `${ending.title}: ${ending.premise}`;
              directionBox.value = input.direction;
            },
          }),
        ),
      )
    : null;

  // ---- Turn templates (saved mood recipes) ---------------------------------
  const templates = api.lib.settings.templates ?? [];
  const templateSelect = h(
    'select',
    { class: 'input' },
    h('option', { value: '', selected: true, text: 'apply a saved template…' }),
    ...templates.map((t) => h('option', { value: t.name, text: t.name })),
  );
  const templatesRow =
    templates.length > 0
      ? h(
          'div',
          { class: 'row gap templates-row' },
          templateSelect,
          button('Apply', () => {
            const found = templates.find((t) => t.name === templateSelect.value);
            if (found) {
              inputs.set(stateKey, {
                ...structuredClone(found.input),
                direction: input.direction || found.input.direction,
              });
              api.refresh();
            }
          }),
          button('💾 Save this setup', () => {
            const name = window.prompt('Name this turn setup (a reusable mood recipe):');
            if (!name?.trim()) return;
            const templatesNext = [
              ...templates.filter((t) => t.name !== name.trim()),
              { name: name.trim(), input: { ...structuredClone(input), direction: '' } },
            ];
            api.update((lib) => ({
              ...lib,
              settings: { ...lib.settings, templates: templatesNext },
            }));
            api.toast(`Saved template “${name.trim()}”`, 'success');
          }),
        )
      : h(
          'div',
          { class: 'row gap templates-row' },
          button('💾 Save this setup as a template', () => {
            const name = window.prompt('Name this turn setup (a reusable mood recipe):');
            if (!name?.trim()) return;
            api.update((lib) => ({
              ...lib,
              settings: {
                ...lib.settings,
                templates: [
                  ...(lib.settings.templates ?? []),
                  { name: name.trim(), input: { ...structuredClone(input), direction: '' } },
                ],
              },
            }));
            api.toast(`Saved template “${name.trim()}”`, 'success');
          }),
        );

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
        'details',
        { class: 'folds dials' },
        h(
          'summary',
          { class: 'dials-summary' },
          h('span', {
            text: `🎚️ Emotion dials${touchedCount > 0 ? ` — ${touchedCount} touched` : ''}`,
          }),
          h('span', {
            class: 'field-hint',
            text: '±3, structural not adjectival · 0 = inherit the mood',
          }),
        ),
        dials,
        h(
          'div',
          { class: 'row gap' },
          button('Reset dials', () => {
            input.emotions = {};
            api.refresh();
          }),
        ),
      ),
      h(
        'div',
        { class: 'grid-2' },
        field('Chapter', chapterSelect),
        field('Page format', documentSelect),
      ),
      h(
        'label',
        { class: 'field check-field' },
        endingBox,
        h('span', { text: ' Bring the story to a close with this page' }),
      ),
      endingsArea,
      templatesRow,
      field(
        'Standing rules — “don’t touch”',
        rulesArea,
        'Persist for the rest of the book, until removed.',
      ),
      h('div', { class: 'row gap' }, ruleInput, button('＋ Add rule', addRule)),
      h(
        'div',
        { class: 'actions' },
        button('Generate next page →', () => void generateNext(api, book, from, key), 'primary'),
        button('Continue naturally', () => {
          inputs.set(stateKey, { ...DEFAULT_TURN, emotions: {} });
          void generateNext(api, book, from, key, true);
        }),
        button('✍️ I’ll write it myself', () => writeMyself(api, book, from), 'ghost', {
          title: 'Skip the model — open a blank page and write the next beat by hand',
        }),
      ),
    ),
    renderCast(api, book),
    renderStoryMemory(api, book),
    rulePresets,
  );
}

function dialRow(name: (typeof EMOTION_NAMES)[number], input: TurnInput): HTMLElement {
  const meta = EMOTION_META[name];
  const value = input.emotions[name] ?? 0;
  const valueLabel = h('span', {
    class: `dial-value${value === 0 ? ' dial-inherit' : value > 0 ? ' dial-plus' : ' dial-minus'}`,
    text: value === 0 ? 'inherit' : `${value > 0 ? '+' : ''}${value}`,
  });
  const range = h('input', {
    class: 'dial-range',
    type: 'range',
    min: '-3',
    max: '3',
    step: '1',
    value: String(value),
    title: describeDial(name, value),
    oninput: (event: Event) => {
      const nextValue = Number((event.target as HTMLInputElement).value);
      if (nextValue === 0) delete input.emotions[name];
      else input.emotions[name] = nextValue;
      valueLabel.textContent =
        nextValue === 0 ? 'inherit' : `${nextValue > 0 ? '+' : ''}${nextValue}`;
      valueLabel.className = `dial-value${nextValue === 0 ? ' dial-inherit' : nextValue > 0 ? ' dial-plus' : ' dial-minus'}`;
      range.title = describeDial(name, nextValue);
    },
  });
  return h(
    'div',
    { class: 'dial-row' },
    h('span', { class: 'dial-name', text: `${meta.icon} ${meta.label}` }),
    range,
    valueLabel,
  );
}

function describeDial(name: (typeof EMOTION_NAMES)[number], value: number): string {
  const meta = EMOTION_META[name];
  if (value === 0) return `${meta.label}: inherit the current mood`;
  const magnitude = { 1: 'slightly', 2: 'clearly', 3: 'strongly' }[Math.abs(value)] ?? 'slightly';
  const direction =
    value > 0 ? `more ${meta.label.toLowerCase()}` : `less ${meta.label.toLowerCase()}`;
  return `${meta.label}: ${magnitude} ${direction}`;
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
      model: api.lib.settings.fastModel || book.model || api.lib.settings.endpoint.model,
    });
    if (api.staleGen(token)) return;
    const list = raw.filter((s) => typeof s === 'string' && s.length > 0).slice(0, 3);
    suggestions.set(stateKey, list);
    suggestIndex.set(stateKey, 0);
    api.refresh();
  } catch (err) {
    if (api.staleGen(token)) return;
    area.replaceChildren();
    api.toast(api.genError(err), 'error');
  }
}

/** Propose possible endings (bittersweet / triumphant / twist) and offer them as chips. */
async function proposeEndings(
  api: AppApi,
  book: Book,
  stateKey: string,
  area: HTMLElement | null,
): Promise<void> {
  if (!area) return;
  const token = api.beginGen();
  area.replaceChildren(spinner(), ' dreaming up endings…');
  try {
    const context = buildContext(api.nodes, book);
    const raw = await api.generateJSON<unknown>(endingsMessages(context, 3), {
      model: api.lib.settings.fastModel || book.model || api.lib.settings.endpoint.model,
    });
    if (api.staleGen(token)) return;
    const parsed = parseEndings(raw);
    endings.set(stateKey, parsed);
    api.refresh();
  } catch (err) {
    if (api.staleGen(token)) return;
    area.replaceChildren();
    api.toast(api.genError(err), 'error');
  }
}

function parseEndings(raw: unknown): Array<{ title: string; premise: string }> {
  try {
    const list = Array.isArray(raw) ? raw : [];
    const out = list
      .map((item) => {
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          return {
            title: typeof record.title === 'string' ? record.title.trim() : '',
            premise: typeof record.premise === 'string' ? record.premise.trim() : '',
          };
        }
        return { title: '', premise: '' };
      })
      .filter((e) => e.title.length > 0 || e.premise.length > 0);
    if (out.length > 0) return out.slice(0, 3);
  } catch {
    // fall through to string salvage
  }
  const text = String(raw);
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, 3)
    .map((line) => {
      const [title, ...rest] = line.split(/[—–:]\s*/);
      return { title: title ?? '', premise: rest.join(' ') };
    });
}

/** The reader authors the next page themselves — no model involved. */
function writeMyself(api: AppApi, book: Book, from: StoryNode): void {
  const stateKey = `${book.id}:${from.id}`;
  const input = inputs.get(stateKey) ?? { ...DEFAULT_TURN, emotions: {} };
  inputs.set(stateKey, input);
  const frontier = getNode(api.nodes, book.frontierId);
  const turn =
    frontier && frontier.kind === 'turn' && frontier.parentId === from.id
      ? frontier
      : api.attachTurn(book, from.id, input);
  const node = api.attachPage(
    book,
    turn.id,
    input,
    '',
    book.model || api.lib.settings.endpoint.model,
    'user',
  );
  api.toast('Your page — write it, then keep it like any other', 'info');
  startEditingPage(node.id);
  api.navigate('page');
}

async function generateNext(
  api: AppApi,
  book: Book,
  from: StoryNode,
  key: string,
  naturally = false,
): Promise<void> {
  const stateKey = `${book.id}:${from.id}`;
  const input = naturally
    ? { ...DEFAULT_TURN, emotions: {} }
    : (inputs.get(stateKey) ?? { ...DEFAULT_TURN, emotions: {} });
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
