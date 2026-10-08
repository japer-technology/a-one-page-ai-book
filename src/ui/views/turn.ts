/**
 * ui/views/turn.ts — THE PAGE TURN. The last page stays on screen, dimmed;
 * below it, the director's console: what happens next. Zero inputs is a valid
 * choice ("continue naturally" is still a decision). Suggested directions are
 * proposed by the model and can be stepped through back and forth; emotion
 * dials compile into calibrated structural instructions; standing rules are
 * the "don't touch" constraints that persist until removed.
 */
import type { AppApi } from '../ctx';
import { button, field, h, pruneMap, spinner } from '../dom';
import {
  buildContext,
  conflictMessages,
  conflictVerdicts,
  endingsMessages,
  EMOTION_META,
  pageMessages,
  suggestionsMessages,
} from '../../core/prompt';
import { getNode, pageNumberAt, seedTextOf, titleNodeOf } from '../../core/tree';
import { parseStringList } from '../../core/parsers';
import type {
  Book,
  ChapterIntent,
  LengthPreference,
  Pace,
  PageBeat,
  PageSizeTarget,
  StoryNode,
  Tone,
  TurnInput,
} from '../../core/types';
import { DEFAULT_TURN, DOCUMENT_META, DOCUMENT_FORMATS, EMOTION_NAMES } from '../../core/types';
import { clearGenState, generatePage, genStates, renderGenPanel } from '../genpage';
import { renderCast } from '../cast';
import { renderStoryMemory } from '../story';
import { startEditingPage } from './page';

// Session view state: turn inputs survive re-renders.
const inputs = new Map<string, TurnInput>();
const suggestions = new Map<string, string[]>();
const suggestIndex = new Map<string, number>();
const autoSuggested = new Set<string>();
const endings = new Map<string, Array<{ title: string; premise: string }>>();
const conflicts = new Map<string, string[] | null>();
/** What-if ghost previews: written but NOT attached to the tree. */
/** Sticky per-book turn settings: size, tone, dials, pace, beat, chapter and
 * format persist across turns until the reader changes them. The free-text
 * direction is one-shot and never sticks. */
const stickyInputs = new Map<string, TurnInput>();

function stickyFor(bookId: string): TurnInput {
  const sticky = stickyInputs.get(bookId);
  if (!sticky) return { ...DEFAULT_TURN, emotions: {} };
  return { ...sticky, direction: '', emotions: { ...sticky.emotions } };
}

function rememberSticky(bookId: string, input: TurnInput): void {
  stickyInputs.set(bookId, { ...input, direction: '' });
}

const ghosts = new Map<string, { text: string; direction: string }>();
/** The direction each ghost preview was REQUESTED with (survives a failure). */
const ghostRequests = new Map<string, string>();
const conflictBusy = new Set<string>();
/**
 * Standing-rule and tweak drafts. These inputs have no model state behind them,
 * so a re-render used to silently discard whatever the reader had half-typed —
 * and a re-render is exactly what happens when the background cast or summary
 * update lands while they are typing. Keyed per book: one shared draft leaked
 * a half-typed rule from book A into every other book's console.
 */
const ruleDrafts = new Map<string, { text: string }>();

function ruleDraftFor(bookId: string): { text: string } {
  let draft = ruleDrafts.get(bookId);
  if (!draft) {
    draft = { text: '' };
    ruleDrafts.set(bookId, draft);
  }
  return draft;
}
/** Requests started by the turn console itself, so its buttons can go busy. */
const turnBusy = new Set<string>();
/** Set when a conflict check itself FAILED, as opposed to finding conflicts. */
const conflictErrors = new Map<string, string>();
/** Turns whose direction box has already received the caret. */
const turnFocused = new Set<string>();

const NUDGES = [
  'end on dialogue',
  'add sensory detail',
  'show, don’t tell',
  'raise the stakes',
  'a moment of calm',
  'reveal a secret',
  'let a character change their mind',
  'cut to a new location',
];

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

  pruneMap(inputs, 200);
  pruneMap(suggestions, 200);
  pruneMap(suggestIndex, 200);
  pruneMap(endings, 200);
  pruneMap(conflicts, 200);
  // A ghost holds a whole model-written page, so it gets the same treatment as
  // its siblings — these maps used to accumulate for the life of the tab.
  pruneMap(ghosts, 200);
  pruneMap(ghostRequests, 200);
  pruneMap(conflictErrors, 200);
  pruneMap(ruleDrafts, 200);
  if (autoSuggested.size > 300) autoSuggested.clear();
  if (turnFocused.size > 300) turnFocused.clear();
  const fromId = api.params.from ?? frontierParent(api);
  const from = fromId ? getNode(api.nodes, fromId) : null;
  if (!from || (from.data.kind !== 'page' && from.data.kind !== 'title')) {
    return h(
      'div',
      { class: 'view' },
      h('p', { text: 'Nothing to turn from.' }),
      button('← Library', () => api.navigate('library')),
    );
  }
  const fromTitle = from.data.kind === 'title';

  // Keyed per position: a failed generation used to wedge the console for the
  // WHOLE book — every position showed the same error panel, and its Retry
  // generated from whichever page was on screen at the click. Each position
  // now owns its panel, and Retry can only repeat its own attempt.
  const key = `turn:${book.id}:${from.id}`;
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
  const input = inputs.get(stateKey) ?? stickyFor(book.id);
  inputs.set(stateKey, input);

  const directionBox = h('textarea', {
    class: 'input direction-input',
    rows: 3,
    placeholder: 'What happens next? (leave empty to continue naturally)',
    value: input.direction,
    oninput: (event: Event) => {
      input.direction = (event.target as HTMLTextAreaElement).value;
      // The conflict checker is disabled while the direction is empty; nothing
      // re-renders on typing, so it must be switched on live or it stays
      // unreachable for the whole visit to the turn console.
      checkButton.disabled = input.direction.trim().length === 0;
      // A verdict about the old direction is stale the moment the text changes
      // (the suggestion chips and nudges below delete both maps for exactly
      // this reason). Typing deliberately does not re-render, so the on-screen
      // verdict has to go now as well — but ONLY the verdict: the check row is
      // this area's last child, and clearing the whole area deleted the
      // "Check this direction" button itself (nothing rebuilds it until an
      // unrelated render).
      conflicts.delete(stateKey);
      conflictErrors.delete(stateKey);
      const area = document.querySelector('.conflict-area');
      if (area) for (const node of [...area.children].slice(0, -1)) node.remove();
    },
  });
  // The direction is the primary control: put the caret there the first time
  // this turn is shown, so the reader can start typing immediately.
  if (!turnFocused.has(stateKey)) {
    turnFocused.add(stateKey);
    setTimeout(() => directionBox.focus(), 0);
  }

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
        ['para1', '¶ one paragraph'],
        ['para3', '¶ two–three paragraphs'],
        ['shorter', 'shorter'],
        ['standard', 'standard'],
        ['longer', 'longer'],
        ['custom', 'custom…'],
      ],
      sizeTarget
        ? sizeTarget.kind === 'paragraphs'
          ? sizeTarget.value === 1
            ? 'para1'
            : 'para3'
          : 'custom'
        : input.length,
      (value) => {
        if (value === 'custom') {
          input.sizeTarget = { kind: 'words', value: 320 };
        } else if (value === 'para1') {
          input.sizeTarget = { kind: 'paragraphs', value: 1 };
        } else if (value === 'para3') {
          input.sizeTarget = { kind: 'paragraphs', value: 3 };
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

  const paceControl = segmented(
    [
      ['inherit', 'pace: inherit'],
      ['slow', '🐌 slow & meditative'],
      ['propulsive', '⚡ propulsive'],
    ],
    input.pace,
    (value) => {
      input.pace = value as Pace;
    },
  );
  const beatControl = segmented(
    [
      ['inherit', 'ending: inherit'],
      ['cliffhanger', '⛰ cliffhanger'],
      ['resting', '🌙 resting point'],
    ],
    input.beat,
    (value) => {
      input.beat = value as PageBeat;
    },
  );

  const endingBox = h('input', {
    type: 'checkbox',
    checked: input.ending ? true : undefined,
    onchange: (event: Event) => {
      input.ending = (event.target as HTMLInputElement).checked;
      // Built once and revealed in place. The gallery used to be created only
      // when `input.ending` was already true at render time, so ticking the box
      // left the promised “Propose endings” button invisible.
      endingsArea.hidden = !input.ending;
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
    // The direction changed: any conflict verdict about the old direction is
    // stale and must not linger under the new one.
    conflicts.delete(stateKey);
    conflictErrors.delete(stateKey);
    checkButton.disabled = false;
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
      h(
        'span',
        { class: 'suggest-item' },
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
        h('button', {
          class: 'ghost-btn',
          type: 'button',
          text: '👻',
          title: 'What if…? Write a ghost preview of this direction WITHOUT committing it',
          onclick: () => void ghostPreview(api, book, from, stateKey, item),
        }),
      ),
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
  const dialsLabel = h('span', {
    text: `🎚️ Emotion dials${Object.keys(input.emotions).length > 0 ? ` — ${Object.keys(input.emotions).length} touched` : ''}`,
  });
  // Dragging a dial must not re-render the view (the range would lose the
  // drag), but the fold's “— N touched” count is live feedback: update the
  // label in place as dials move.
  const updateDialsLabel = () => {
    const count = Object.keys(input.emotions).length;
    dialsLabel.textContent = `🎚️ Emotion dials${count > 0 ? ` — ${count} touched` : ''}`;
  };
  const dials = h(
    'div',
    { class: 'dial-grid' },
    ...EMOTION_NAMES.map((name) => dialRow(name, input, updateDialsLabel)),
  );

  // ---- Standing rules ------------------------------------------------------
  const rules = book.rules ?? [];
  // Per-book draft: a half-typed rule for book A must not appear pre-filled
  // in book B's console.
  const ruleDraft = ruleDraftFor(book.id);
  const ruleInput = h('input', {
    class: 'input rule-input',
    type: 'text',
    list: 'rule-presets',
    value: ruleDraft.text,
    placeholder: '“Don’t reveal the letter yet” — lasts until you remove it',
    oninput: (event: Event) => {
      ruleDraft.text = (event.target as HTMLInputElement).value;
    },
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
    // Clear the draft BEFORE the mutation: setRules re-renders synchronously,
    // so clearing afterwards would only touch a detached node.
    ruleDraft.text = '';
    ruleInput.value = '';
    api.setRules(book, [...rules, rule]);
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

  // ---- Conflict checker -----------------------------------------------------
  const conflictList = conflicts.get(stateKey);
  const checking = conflictBusy.has(stateKey);
  const conflictError = conflictErrors.get(stateKey) ?? '';
  const conflictArea = h('div', { class: 'conflict-area' });
  if (conflictError) {
    // A network failure is not a continuity problem: showing it inside the red
    // "this direction conflicts" banner invented a story conflict out of an
    // unreachable server.
    conflictArea.appendChild(
      h(
        'div',
        { class: 'banner' },
        conflictError,
        ' ',
        button('Retry', () => void checkConflicts(api, book, stateKey, input), 'chip'),
      ),
    );
  }
  if (conflictList && conflictList.length === 0) {
    conflictArea.appendChild(
      h('p', {
        class: 'conflict-ok',
        text: '✓ No conflicts found — this direction is consistent with the story.',
      }),
    );
    conflictArea.appendChild(
      button(
        '✕',
        () => {
          // Refresh: without it the dismissed verdict stayed on screen until
          // some unrelated render (a cast or memory update) happened to run.
          conflicts.delete(stateKey);
          api.refresh();
        },
        'chip',
      ),
    );
  } else if (conflictList) {
    {
      conflictArea.appendChild(
        h(
          'div',
          { class: 'banner banner-error' },
          '⚠️ This direction conflicts with the story so far:',
        ),
      );
      conflictArea.appendChild(
        h('ul', { class: 'conflict-list' }, ...conflictList.map((item) => h('li', { text: item }))),
      );
      conflictArea.appendChild(
        button(
          '✕',
          () => {
            // Refresh: without it the dismissed verdict stayed on screen until
            // some unrelated render (a cast or memory update) happened to run.
            conflicts.delete(stateKey);
            api.refresh();
          },
          'chip',
        ),
      );
    }
  }
  const checkButton = button(
    checking ? 'Checking…' : '🔍 Check this direction',
    () => void checkConflicts(api, book, stateKey, input),
    'ghost',
    {
      disabled: checking || input.direction.trim().length === 0,
      title: 'Ask the model whether this direction contradicts anything established',
    },
  );
  conflictArea.appendChild(h('div', { class: 'row gap' }, checkButton));

  // ---- Auto-suggest --------------------------------------------------------
  if (
    api.lib.settings.autoSuggest &&
    list.length === 0 &&
    !autoSuggested.has(stateKey) &&
    !genStates.has(`turn:${book.id}:${from.id}`)
  ) {
    autoSuggested.add(stateKey);
    setTimeout(() => void suggest(api, book, stateKey, suggestArea), 0);
  }

  // ---- Proposed endings ----------------------------------------------------
  const endingList = endings.get(stateKey) ?? [];
  const endingsArea = h(
    'div',
    { class: 'endings-area', hidden: !input.ending },
    h(
      'div',
      { class: 'row gap' },
      button(
        '✨ Propose endings',
        () => void proposeEndings(api, book, stateKey, endingsArea),
        'ghost',
        {
          disabled: turnBusy.has(`endings:${stateKey}`),
        },
      ),
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
          conflicts.delete(stateKey);
          // Same trap the nudges were fixed for: the button's disabled state is
          // computed at render time, so filling the box from a chip left
          // "Check this direction" dead right underneath the text it had just
          // written.
          checkButton.disabled = false;
          api.refresh();
        },
      }),
    ),
  );

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
              // Applying a template can change the direction: a verdict about
              // the old one must not linger under the new text.
              conflicts.delete(stateKey);
              conflictErrors.delete(stateKey);
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
    h(
      'div',
      { class: 'turn-layout' },
      fadedPage(api, book, from),
      h(
        'section',
        { class: 'turn-panel' },
        h('h2', {
          class: 'turn-title',
          text: fromTitle
            ? 'The title is chosen. How does page one begin?'
            : 'The page is written. What happens next?',
        }),
        h('button', {
          class: 'help-link',
          type: 'button',
          text: '? what is all this',
          title: 'Open the help for the turn console',
          onclick: () => api.navigate('help', { section: 'turn' }),
        }),
        field('Direction', directionBox, 'A one-liner is plenty — or nothing at all.'),
        h(
          'div',
          { class: 'nudges' },
          h('span', { class: 'nudges-label', text: 'quick nudges' }),
          ...NUDGES.map((nudge) =>
            button(
              nudge,
              () => {
                input.direction = input.direction.trim()
                  ? `${input.direction.trim()} — ${nudge}`
                  : nudge;
                directionBox.value = input.direction;
                conflicts.delete(stateKey);
                // A stale verdict about the OLD text must go, and the Check
                // button's disabled state is computed at render time — a nudge
                // was the only way to fill the direction box without it, so
                // "Check this direction" stayed dead for the whole visit.
                checkButton.disabled = false;
                api.refresh();
              },
              'chip',
              { title: `Append “${nudge}” to the direction` },
            ),
          ),
        ),
        h(
          'div',
          { class: 'row gap' },
          button(
            turnBusy.has(`suggest:${stateKey}`) ? '✨ Thinking…' : '✨ Suggest directions',
            () => void suggest(api, book, stateKey, suggestArea),
            'ghost',
            { disabled: turnBusy.has(`suggest:${stateKey}`) },
          ),
        ),
        suggestArea,
        ghostPanel(api, book, from, stateKey),
        h(
          'div',
          { class: 'grid-2' },
          field('Page length', lengthControl),
          field('Tone', toneSelect),
        ),
        h(
          'details',
          { class: 'folds dials' },
          h(
            'summary',
            { class: 'dials-summary' },
            dialsLabel,
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
          'div',
          { class: 'grid-2' },
          field('Pace', paceControl),
          field('Page ending', beatControl),
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
        conflictArea,
        h(
          'div',
          { class: 'actions turn-submit' },
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
    ),
    renderCast(api, book),
    renderStoryMemory(api, book),
    rulePresets,
  );
}

function dialRow(
  name: (typeof EMOTION_NAMES)[number],
  input: TurnInput,
  onTouched?: () => void,
): HTMLElement {
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
      onTouched?.();
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
  const fromTitle = from.data.kind === 'title';
  const chosen =
    from.data.kind === 'page' ? from.data.versions[from.data.chosenVersion - 1] : undefined;
  return h(
    'div',
    { class: 'faded-page' },
    h('span', {
      class: 'page-num',
      text: fromTitle ? 'The title · kept ✓' : `Page ${pageNumberAt(api.nodes, from.id)} · kept ✓`,
    }),
    h('span', { class: 'page-book', text: fromTitle ? taglineOf(api, book) : titleText }),
    fromTitle
      ? h(
          'div',
          { class: 'page-text faded-text title-faded' },
          h('h2', { class: 'title-hero', text: titleText }),
          h('p', { class: 'lede', text: taglineOf(api, book) }),
          h('p', { class: 'book-meta', text: `Seed: “${seedTextOf(api.nodes, book)}”` }),
        )
      : h('div', {
          class: `page-text faded-text doc-${from.data.kind === 'page' ? from.data.direction.document : 'story'}`,
          text: chosen?.text ?? '',
        }),
  );
}

function taglineOf(api: AppApi, book: Book): string {
  const title = titleNodeOf(api.nodes, book);
  return title.data.kind === 'title' ? title.data.tagline : '';
}

async function suggest(
  api: AppApi,
  book: Book,
  stateKey: string,
  area: HTMLElement,
): Promise<void> {
  // One request at a time: a double-click used to start two model calls and
  // abort the first, which then reported "Generation cancelled.".
  const busyKey = `suggest:${stateKey}`;
  if (turnBusy.has(busyKey)) return;
  turnBusy.add(busyKey);
  const token = api.beginGen();
  area.replaceChildren(spinner(), ' thinking…');
  try {
    const context = buildContext(api.nodes, book);
    const raw = await api.generateJSON<string[]>(suggestionsMessages(context, 3), {
      model: api.lib.settings.fastModel || api.lib.settings.endpoint.model,
    });
    if (api.staleGen(token)) return;
    const list = raw.filter((s) => typeof s === 'string' && s.length > 0).slice(0, 3);
    suggestions.set(stateKey, list);
    suggestIndex.set(stateKey, 0);
    api.refresh();
  } catch {
    if (api.staleGen(token)) return;
    area.replaceChildren();
    // Already reported by the generation funnel; a second toast is noise.
  } finally {
    turnBusy.delete(busyKey);
    api.refresh();
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
  const busyKey = `endings:${stateKey}`;
  if (turnBusy.has(busyKey)) return;
  turnBusy.add(busyKey);
  const token = api.beginGen();
  area.replaceChildren(spinner(), ' dreaming up endings…');
  try {
    const context = buildContext(api.nodes, book);
    const raw = await api.generateJSON<unknown>(endingsMessages(context, 3), {
      model: api.lib.settings.fastModel || api.lib.settings.endpoint.model,
    });
    if (api.staleGen(token)) return;
    const parsed = parseEndings(raw);
    endings.set(stateKey, parsed);
    api.refresh();
  } catch {
    if (api.staleGen(token)) return;
    area.replaceChildren();
  } finally {
    turnBusy.delete(busyKey);
    api.refresh();
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

async function checkConflicts(
  api: AppApi,
  book: Book,
  stateKey: string,
  input: TurnInput,
): Promise<void> {
  if (conflictBusy.has(stateKey)) return;
  conflictBusy.add(stateKey);
  conflicts.delete(stateKey);
  conflictErrors.delete(stateKey);
  api.refresh();
  const checked = input.direction;
  try {
    const context = buildContext(api.nodes, book);
    const raw = await api.generateJSON<unknown>(conflictMessages(context, input.direction), {
      model: api.lib.settings.fastModel || api.lib.settings.endpoint.model,
    });
    const list = conflictVerdicts(
      parseStringList(typeof raw === 'string' ? raw : JSON.stringify(raw)),
    );
    // The reader can keep typing (or apply a template) while the check runs: a
    // verdict about the direction that was SENT must not appear under whatever
    // is in the box now.
    if (input.direction === checked) conflicts.set(stateKey, list);
  } catch (err) {
    // Keep this OUT of `conflicts`: the render maps a non-empty list to the red
    // "this direction conflicts with the story" banner, which turned an
    // unreachable model into an invented continuity problem. And keep it out
    // of `conflictErrors` too when the reader CANCELLED the check (navigating
    // away aborts it) or has since edited the direction: a request the reader
    // stopped is not a model failure, and the banner used to greet them on
    // their next visit to the console.
    const cancelled = err instanceof DOMException && err.name === 'AbortError';
    if (!cancelled && input.direction === checked) {
      conflictErrors.set(stateKey, api.genError(err));
    }
  }
  conflictBusy.delete(stateKey);
  api.refresh();
}

function ghostPanel(
  api: AppApi,
  book: Book,
  from: StoryNode,
  stateKey: string,
): HTMLElement | null {
  const key = `ghost:${stateKey}`;
  const state = genStates.get(key);
  const ghost = ghosts.get(stateKey);
  if (!state && !ghost) return null;
  if (state) {
    return h(
      'div',
      { class: 'ghost-panel' },
      h('p', {
        class: 'ghost-title',
        text: '👻 What if… — a ghost page (nothing is committed yet)',
      }),
      renderGenPanel(api, key, () => {
        // Retry the direction that actually FAILED. `ghosts` is only written on
        // success, so reading it here made the Retry button a no-op after a
        // failure — or, worse, silently re-ran a stale earlier ghost.
        const wanted = ghostRequests.get(stateKey);
        if (wanted !== undefined) void ghostPreview(api, book, from, stateKey, wanted);
      }),
      h(
        'div',
        { class: 'row gap' },
        button('✕ Let it dissolve', () => {
          // Dismiss AND abort: dropping only the local state left the request
          // running, and its completion — which checks the staleness token, not
          // this map — then saved the finished ghost and brought the panel
          // back. This is what the busy panel's own Cancel already does.
          genStates.delete(key);
          api.abortGeneration();
          api.refresh();
        }),
      ),
    );
  }
  if (!ghost) return null;
  return h(
    'div',
    { class: 'ghost-panel' },
    h('p', { class: 'ghost-title', text: `👻 What if… “${ghost.direction}”` }),
    h('div', { class: 'page-text ghost-text', text: ghost.text }),
    h(
      'div',
      { class: 'row gap' },
      button(
        '🌿 Adopt as a branch',
        () => {
          const input: TurnInput = { ...DEFAULT_TURN, emotions: {}, direction: ghost.direction };
          const frontier = getNode(api.nodes, book.frontierId);
          const turn =
            frontier && frontier.kind === 'turn' && frontier.parentId === from.id
              ? frontier
              : api.attachTurn(book, from.id, input);
          api.attachPage(book, turn.id, input, ghost.text, api.lib.settings.endpoint.model, 'ai');
          ghosts.delete(stateKey);
          genStates.delete(key);
          api.navigate('page');
        },
        'primary',
      ),
      button('✕ Let it dissolve', () => {
        ghosts.delete(stateKey);
        genStates.delete(key);
        api.refresh();
      }),
    ),
  );
}

async function ghostPreview(
  api: AppApi,
  book: Book,
  from: StoryNode,
  stateKey: string,
  direction: string,
): Promise<void> {
  const key = `ghost:${stateKey}`;
  const token = api.beginGen();
  // Remember what was ASKED for, before the request can fail: the error
  // panel's Retry needs the direction, and `ghosts` only ever holds successes.
  ghostRequests.set(stateKey, direction);
  genStates.set(key, {
    token,
    status: 'busy',
    label: 'Writing a ghost page…',
    stream: '',
    error: '',
  });
  api.refresh();
  try {
    const ctx = buildContext(api.nodes, book);
    const input: TurnInput = { ...DEFAULT_TURN, emotions: {}, direction };
    const model = api.lib.settings.endpoint.model;
    const text = await api.generateText(
      pageMessages(ctx, input, pageNumberAt(api.nodes, from.id) + 1, book.rules),
      {
        model,
        onToken: (piece) => {
          const state = genStates.get(key);
          if (state) state.stream += piece;
        },
        onRetry: () => {
          const state = genStates.get(key);
          if (state) state.stream = '';
        },
      },
    );
    if (api.staleGen(token)) {
      clearGenState(key, token);
      return;
    }
    const cleaned = text.trim();
    if (!cleaned) throw new Error('The model returned an empty ghost page');
    clearGenState(key, token);
    ghosts.set(stateKey, { text: cleaned, direction });
    api.refresh();
  } catch (err) {
    clearGenState(key, token);
    if (api.staleGen(token)) return;
    genStates.set(key, {
      token,
      status: 'error',
      label: 'Ghost page failed',
      stream: '',
      error: api.genError(err),
    });
    api.refresh();
  }
}

/** The reader authors the next page themselves — no model involved. */
function writeMyself(api: AppApi, book: Book, from: StoryNode): void {
  const stateKey = `${book.id}:${from.id}`;
  const input = inputs.get(stateKey) ?? stickyFor(book.id);
  inputs.set(stateKey, input);
  const frontier = getNode(api.nodes, book.frontierId);
  const turn =
    frontier && frontier.kind === 'turn' && frontier.parentId === from.id
      ? frontier
      : api.attachTurn(book, from.id, input);
  const node = api.attachPage(book, turn.id, input, '', api.lib.settings.endpoint.model, 'user');
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
    : (inputs.get(stateKey) ?? stickyFor(book.id));
  inputs.set(stateKey, input);
  if (naturally) {
    // "Continue naturally" is an explicit choice of defaults — reset the sticky.
    stickyInputs.delete(book.id);
  } else {
    rememberSticky(book.id, input);
  }
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
