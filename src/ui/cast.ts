/**
 * ui/cast.ts — the living cast. A "people · places · things · threads" panel
 * that tracks everything established in the story up to the current page,
 * maintained by a background LLM extraction after each page — and fully
 * editable by the reader: add, rename, annotate, give characters sheets,
 * and remove entries. Edits are saved onto the cast-carrying page node, so
 * every branch owns its cast; the curated names are injected into every
 * generation prompt, so renames stick.
 */
import type { AppApi } from './ctx';
import { button, h, pruneMap, spinner } from './dom';
import { genStates, renderGenPanel } from './genpage';
import { bibleMessages, buildContext, buildContextTo, renameMessages } from '../core/prompt';
import { parseBible } from '../core/parsers';
import { bibleUpTo, getNode, pageNumberAt, pathToRoot, spinePages } from '../core/tree';
import type { BibleEntry, Book, StoryBible } from '../core/types';

const busy = new Map<string, { status: 'busy' | 'error'; error: string }>();
/** The newest page awaiting a cast update per book (trailing-queue). */
const pendingBible = new Map<string, string>();

type GroupKey = 'people' | 'places' | 'things' | 'threads';

interface CastUIState {
  adding: GroupKey | null;
  editing: string | null; // `${group}:${index}`
  draft: { name: string; note: string; details: string };
  /**
   * Whether the panel is expanded. Forcing `open` on every construction meant
   * that a collapse was undone by the next re-render — which happens after
   * nearly every action (generation finishing, a cast edit, an automatic cast
   * update, navigation), so the panel could never be kept out of the way.
   */
  open: boolean;
}

const castUI = new Map<string, CastUIState>();
interface RelForm {
  open: boolean;
  from: string;
  to: string;
  kind: string;
}
const relForms = new Map<string, RelForm>();

const GROUP_META: Array<{ key: GroupKey; icon: string; label: string; addLabel: string }> = [
  { key: 'people', icon: '👥', label: 'People', addLabel: '＋ person' },
  { key: 'places', icon: '🏔️', label: 'Places', addLabel: '＋ place' },
  { key: 'things', icon: '🧷', label: 'Things', addLabel: '＋ thing' },
  { key: 'threads', icon: '🧵', label: 'Open threads', addLabel: '＋ thread' },
];

export function castBusy(bookId: string): { status: 'busy' | 'error'; error: string } | null {
  return busy.get(bookId) ?? null;
}

/**
 * Kick off a cast update for a page (fire-and-forget). Idempotent: a second
 * call while one is running is a no-op, and starting any other generation
 * marks this one stale so it can never clobber newer work.
 *
 * `manual` is set by the panel's own buttons: an explicit "refresh the cast"
 * click deserves a plain error toast, while the automatic upkeep that runs
 * after every page reports through the panel only.
 */
export async function updateBible(
  api: AppApi,
  book: Book,
  pageNodeId: string,
  { manual = false }: { manual?: boolean } = {},
): Promise<void> {
  if (busy.get(book.id)?.status === 'busy') return;
  if (!api.lib.settings.endpoint.model) return;
  busy.set(book.id, { status: 'busy', error: '' });
  api.refresh();
  try {
    const pageNode = getNode(api.nodes, pageNodeId);
    if (!pageNode || pageNode.kind !== 'page') {
      busy.delete(book.id);
      api.refresh();
      return;
    }
    const ctx = buildContextTo(api.nodes, book, pageNodeId);
    const previous = bibleUpTo(api.nodes, pageNodeId)?.bible ?? null;
    // `parallel: true` keeps any concurrent generation alive, and we
    // deliberately do NOT bump the staleness token: a cast save is harmless
    // and idempotent, so it must never invalidate in-flight page work.
    const raw = await api.generateJSON<unknown>(bibleMessages(ctx, previous), {
      model: api.lib.settings.fastModel || api.lib.settings.endpoint.model,
      parallel: true,
      // Background: navigation must not abort the cast extraction that the
      // very click that navigated had just requested.
      background: true,
      quiet: !manual,
    });
    const parsed = parseBible(typeof raw === 'string' ? raw : JSON.stringify(raw), previous);
    parsed.at = pageNumberAt(api.nodes, pageNodeId);
    parsed.updatedAt = Date.now();
    api.saveBible(pageNodeId, parsed);
    // The two-tier context memory reads node.data.summary — keep it in sync
    // with the cast extraction (one model call feeds both).
    if (api.lib.settings.autoSummary && parsed.summary.trim().length > 0) {
      api.saveSummary(pageNodeId, parsed.summary.trim());
    }
    // This page IS the newest request: drop the trailing marker, or a later
    // update finishing would see it as a pending page and re-run this one.
    if (pendingBible.get(book.id) === pageNodeId) pendingBible.delete(book.id);
    busy.delete(book.id);
    api.refresh();
    // Trailing pass: if a newer page was requested while this one ran, its
    // update was skipped by the busy-guard — run it now.
    const trailing = pendingBible.get(book.id);
    if (trailing && trailing !== pageNodeId) {
      pendingBible.delete(book.id);
      void updateBible(api, book, trailing);
    }
  } catch (err) {
    busy.delete(book.id);
    // A superseded request must not leave its marker behind, or the next
    // successful update would pick it up and re-extract an old page.
    if (pendingBible.get(book.id) === pageNodeId) pendingBible.delete(book.id);
    busy.set(book.id, { status: 'error', error: api.genError(err) });
    api.refresh();
  }
}

/** Fire-and-forget cast update when the setting allows it. */
export function maybeUpdateBible(api: AppApi, book: Book, pageNodeId: string): void {
  if (!api.lib.settings.autoBible) return;
  if (!api.lib.settings.endpoint.model) return;
  // Remember the newest request: if an update is already in flight, the
  // busy-guard in updateBible would skip this one; the trailing pass picks it up.
  pendingBible.set(book.id, pageNodeId);
  void updateBible(api, book, pageNodeId);
}

/**
 * The cast panel. `pageNodeId` limits the cast to "up to this page"
 * (used by the reader); default is the book's frontier (page & turn views).
 */
export function renderCast(
  api: AppApi,
  book: Book,
  opts: { pageNodeId?: string | null; open?: boolean } = {},
): HTMLElement {
  pruneMap(castUI, 60);
  pruneMap(relForms, 60);
  const upTo = opts.pageNodeId ?? book.frontierId;
  const latest = bibleUpTo(api.nodes, upTo);
  const state = busy.get(book.id);
  const ui = castUI.get(book.id) ?? {
    adding: null,
    editing: null,
    draft: { name: '', note: '', details: '' },
    open: opts.open !== false,
  };
  // Honour an explicit `open` request only on the FIRST render for this book;
  // afterwards the reader's own collapse/expand wins.
  if (opts.open !== undefined && !castUI.has(book.id)) ui.open = opts.open;
  castUI.set(book.id, ui);

  // Edits are saved onto the node that carries the shown cast — or the most
  // recent page on the path when nothing has been extracted yet.
  const path = pathToRoot(api.nodes, upTo);
  const lastPage = [...path].reverse().find((n) => n.kind === 'page');
  const targetNodeId = latest?.nodeId ?? lastPage?.id ?? null;
  const bible = latest?.bible ?? null;

  const entryCount = bible
    ? bible.people.length + bible.places.length + bible.things.length + bible.threads.length
    : 0;

  const groups = GROUP_META.map(({ key, icon, label, addLabel }) => {
    const entries = bible?.[key] ?? [];
    return h(
      'div',
      { class: 'cast-group' },
      h(
        'div',
        { class: 'cast-group-head' },
        h('h4', { class: 'cast-group-title', text: `${icon} ${label}` }),
        targetNodeId
          ? button(
              addLabel,
              () => {
                ui.adding = key;
                ui.editing = null;
                ui.draft = { name: '', note: '', details: '' };
                api.refresh();
              },
              'chip',
            )
          : null,
      ),
      entries.length === 0 && ui.adding !== key ? h('p', { class: 'cast-empty', text: '—' }) : null,
      ui.adding === key ? entryForm(api, book, targetNodeId, key, null, ui) : null,
      h(
        'ul',
        { class: 'cast-list' },
        ...entries.map((entry, index) => castEntry(api, book, targetNodeId, key, index, entry, ui)),
      ),
    );
  });

  const stateLine =
    state?.status === 'busy'
      ? h('span', { class: 'cast-state' }, spinner(), ' updating the cast…')
      : state?.status === 'error'
        ? h('span', { class: 'cast-state cast-state-error', text: 'cast update failed' })
        : latest
          ? h('span', { class: 'cast-state', text: `as of page ${latest.pageNumber}` })
          : null;

  const body = h(
    'div',
    { class: 'cast-body' },
    h(
      'p',
      { class: 'cast-hint' },
      'You curate the cast: rename anyone, fix notes, add threads and relationships. The model writes with these names.',
    ),
    genStates.get(`surgery:${book.id}`)
      ? h(
          'div',
          { class: 'surgery-panel' },
          renderGenPanel(api, `surgery:${book.id}`, () => {}),
        )
      : null,
    bible?.summary
      ? h(
          'div',
          { class: 'cast-summary' },
          h('h4', { class: 'cast-group-title', text: '📖 The story so far' }),
          h('p', { class: 'cast-summary-text', text: bible.summary }),
        )
      : null,
    h('div', { class: 'cast-grid' }, ...groups),
    relationsSection(api, book, targetNodeId, bible),
    graphSection(bible),
    state?.status === 'error'
      ? h(
          'div',
          { class: 'banner banner-error' },
          state.error,
          ' ',
          button('Retry', () => void updateBible(api, book, upTo, { manual: true }), 'chip'),
          // The upkeep runs on its own: the reader's page was written and kept
          // before this call was ever made, and saying so stops a failed cast
          // refresh from reading as "the app is broken, your page is at risk".
          h('p', {
            class: 'banner-hint',
            text: 'This is the optional cast upkeep — the pages you have written are unaffected. Retry, or pick a stronger model for upkeep in Settings.',
          }),
        )
      : null,
  );

  const details = h(
    'details',
    { class: 'cast', open: ui.open ? true : undefined },
    h(
      'summary',
      { class: 'cast-summary' },
      h('span', { class: 'cast-title', text: '📇 The cast — people · places · things · threads' }),
      h('span', {
        class: 'cast-count',
        text: entryCount > 0 ? `${entryCount} known` : 'empty for now',
      }),
      stateLine,
      h(
        'span',
        { class: 'cast-actions' },
        button(
          '↻ Update from the story',
          (event) => {
            event.preventDefault();
            event.stopPropagation();
            void updateBible(api, book, upTo, { manual: true });
          },
          'chip',
          { title: 'Ask the model to re-read the story so far and refresh the cast' },
        ),
      ),
    ),
    body,
  );
  // Remember the reader's choice — the panel is re-created on every render.
  details.addEventListener('toggle', () => {
    ui.open = details.open;
  });
  return details;
}

function castEntry(
  api: AppApi,
  book: Book,
  targetNodeId: string | null,
  group: GroupKey,
  index: number,
  entry: BibleEntry,
  ui: CastUIState,
): HTMLElement {
  const key = `${group}:${index}`;
  if (ui.editing === key && targetNodeId) {
    return entryForm(api, book, targetNodeId, group, index, ui, entry);
  }
  return h(
    'li',
    { class: 'cast-entry' },
    h(
      'span',
      { class: 'cast-entry-main' },
      h('span', { class: 'cast-name', text: entry.name }),
      entry.note ? h('span', { class: 'cast-note', text: entry.note }) : null,
    ),
    entry.details ? h('span', { class: 'cast-details', text: entry.details }) : null,
    h(
      'span',
      { class: 'cast-entry-tools' },
      h('button', {
        class: 'cast-tool',
        type: 'button',
        text: '✎',
        'aria-label': `Rename or edit ${entry.name}`,
        title: 'Rename / edit this entry',
        onclick: () => {
          ui.editing = key;
          ui.adding = null;
          ui.draft = { name: entry.name, note: entry.note, details: entry.details ?? '' };
          api.refresh();
        },
      }),
      h('button', {
        class: 'cast-tool cast-tool-danger',
        type: 'button',
        text: '✕',
        'aria-label': `Remove ${entry.name}`,
        title: 'Remove this entry',
        onclick: () => {
          if (!targetNodeId) return;
          api.saveBible(
            targetNodeId,
            mutateBible(api, targetNodeId, (bible) => {
              const list = [...bible[group]];
              list.splice(index, 1);
              return { ...bible, [group]: list };
            }),
          );
          ui.editing = null;
          ui.adding = null;
          api.toast(`Removed “${entry.name}”`, 'info');
        },
      }),
    ),
  );
}

function entryForm(
  api: AppApi,
  book: Book,
  targetNodeId: string | null,
  group: GroupKey,
  index: number | null,
  ui: CastUIState,
  existing?: BibleEntry,
): HTMLElement {
  const draft = ui.draft;
  if (existing && draft.name === '') {
    draft.name = existing.name;
    draft.note = existing.note;
    draft.details = existing.details ?? '';
  }
  const nameInput = h('input', {
    class: 'input cast-input-name',
    type: 'text',
    value: draft.name,
    placeholder: 'Name — e.g. Elin Marr, the lighthouse, the letter',
    oninput: (event: Event) => {
      draft.name = (event.target as HTMLInputElement).value;
    },
  });
  const noteInput = h('input', {
    class: 'input',
    type: 'text',
    value: draft.note,
    placeholder: 'One short line — role or significance',
    oninput: (event: Event) => {
      draft.note = (event.target as HTMLInputElement).value;
    },
  });
  const detailsInput =
    group === 'people'
      ? h('textarea', {
          class: 'input cast-input-details',
          rows: 3,
          value: draft.details,
          placeholder: 'Character sheet (optional): appearance, want, secret, relationships…',
          oninput: (event: Event) => {
            draft.details = (event.target as HTMLTextAreaElement).value;
          },
        })
      : null;

  const save = () => {
    if (!targetNodeId) return;
    const name = draft.name.trim();
    if (!name) {
      api.toast('Give it a name first', 'info');
      return;
    }
    api.saveBible(
      targetNodeId,
      mutateBible(api, targetNodeId, (bible) => {
        const list = [...bible[group]];
        const entry: BibleEntry = {
          name,
          note: draft.note.trim(),
          details: group === 'people' && draft.details.trim() ? draft.details.trim() : undefined,
        };
        if (index === null) list.push(entry);
        else {
          const previous = list[index];
          list[index] = previous ? { ...previous, ...entry } : entry;
        }
        return { ...bible, [group]: list };
      }),
    );
    ui.adding = null;
    ui.editing = null;
    api.toast(index === null ? `Added “${name}”` : `Saved “${name}”`, 'success');
  };

  const renaming =
    existing !== undefined && draft.name.trim().length > 0 && draft.name.trim() !== existing.name;

  return h(
    'div',
    { class: 'cast-form' },
    nameInput,
    noteInput,
    detailsInput,
    h(
      'div',
      { class: 'row gap' },
      button('Save', save, 'primary'),
      renaming
        ? button(
            '🔧 Save + rename everywhere',
            () => {
              save();
              const oldName = existing.name;
              const newName = draft.name.trim();
              if (
                window.confirm(
                  `Rewrite EVERY page of the chosen path replacing “${oldName}” with “${newName}”? Past pages become new versions — nothing is destroyed.`,
                )
              ) {
                void renameSurgery(api, book, oldName, newName);
              }
            },
            'ghost',
            { title: 'Retroactive surgery: every past page gets the new name' },
          )
        : null,
      button('Cancel', () => {
        ui.adding = null;
        ui.editing = null;
        api.refresh();
      }),
    ),
  );
}

/** Retroactive rename: rewrite every chosen-path page that mentions the name. */
async function renameSurgery(
  api: AppApi,
  book: Book,
  oldName: string,
  newName: string,
): Promise<void> {
  const key = `surgery:${book.id}`;
  if (genStates.has(key)) return;
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b${escape(oldName)}\\b`, 'i');
  const spine = spinePages(api.nodes, book.frontierId);
  const targets = spine.filter((pageNode) => {
    if (pageNode.data.kind !== 'page') return false;
    const text = pageNode.data.versions[pageNode.data.chosenVersion - 1]?.text ?? '';
    return pattern.test(text);
  });
  if (targets.length === 0) {
    api.toast(`“${oldName}” does not appear on the chosen path`, 'info');
    return;
  }
  const token = api.beginGen();
  const model = api.lib.settings.endpoint.model;
  for (let i = 0; i < targets.length; i++) {
    const pageNode = targets[i];
    if (!pageNode || pageNode.data.kind !== 'page') continue;
    const text = pageNode.data.versions[pageNode.data.chosenVersion - 1]?.text ?? '';
    genStates.set(key, {
      token,
      status: 'busy',
      label: `Surgery ${i + 1} of ${targets.length}: renaming in page ${pageNumberAt(api.nodes, pageNode.id)}…`,
      stream: '',
      error: '',
    });
    api.refresh();
    try {
      const ctx = buildContext(api.nodes, book);
      const rewritten = await api.generateText(
        renameMessages(ctx, pageNumberAt(api.nodes, pageNode.id), text, oldName, newName),
        {
          model,
          onToken: (piece) => {
            const state = genStates.get(key);
            if (state) state.stream += piece;
          },
          // A retry re-sends the same surgery; without clearing the preview the
          // panel shows attempt 1's page followed by attempt 2's.
          onRetry: () => {
            const state = genStates.get(key);
            if (state) state.stream = '';
          },
        },
      );
      if (api.staleGen(token)) {
        genStates.delete(key);
        return;
      }
      const cleaned = rewritten.trim();
      if (!cleaned) throw new Error('The model returned an empty page');
      api.appendVersion(pageNode.id, cleaned, 'ai', model);
    } catch (err) {
      genStates.delete(key);
      if (api.staleGen(token)) return;
      genStates.set(key, {
        token,
        status: 'error',
        label: 'Surgery stopped',
        stream: '',
        error: api.genError(err),
      });
      api.refresh();
      return;
    }
  }
  genStates.delete(key);
  api.refresh();
  api.toast(
    `Renamed “${oldName}” → “${newName}” across ${targets.length} page${targets.length === 1 ? '' : 's'} — every change is a new version`,
    'success',
  );
}

/** Copy the shown bible (or a fresh one) through a mutation, for saving back. */
function mutateBible(
  api: AppApi,
  pageNodeId: string,
  recipe: (bible: StoryBible) => StoryBible,
): StoryBible {
  const existing = bibleUpTo(api.nodes, pageNodeId);
  const base: StoryBible = existing?.bible ?? {
    people: [],
    places: [],
    things: [],
    threads: [],
    relations: [],
    summary: '',
    at: pageNumberAt(api.nodes, pageNodeId),
    updatedAt: Date.now(),
  };
  return { ...recipe(structuredClone(base)), updatedAt: Date.now() };
}

// ---- Relationships ----------------------------------------------------------

function relationsSection(
  api: AppApi,
  book: Book,
  targetNodeId: string | null,
  bible: StoryBible | null,
): HTMLElement {
  const relations = bible?.relations ?? [];
  const form = relForms.get(book.id) ?? { open: false, from: '', to: '', kind: '' };
  relForms.set(book.id, form);

  const peopleNames = bible?.people.map((p) => p.name) ?? [];
  const select = (value: string, onchange: (v: string) => void): HTMLElement =>
    h(
      'select',
      {
        class: 'input rel-select',
        onchange: (event: Event) => onchange((event.target as HTMLSelectElement).value),
      },
      h('option', { value: '', selected: value === '' ? true : undefined, text: '— who —' }),
      ...peopleNames.map((name) =>
        h('option', { value: name, selected: value === name ? true : undefined, text: name }),
      ),
    );
  const fromSelect = select(form.from, (v) => {
    form.from = v;
  });
  const toSelect = select(form.to, (v) => {
    form.to = v;
  });
  const kindInput = h('input', {
    class: 'input rel-kind',
    type: 'text',
    value: form.kind,
    placeholder: 'kind — sisters, mentor, rivals, in love…',
    oninput: (event: Event) => {
      form.kind = (event.target as HTMLInputElement).value;
    },
  });

  const addRelation = () => {
    if (!targetNodeId) return;
    const from = form.from.trim();
    const to = form.to.trim();
    const kind = form.kind.trim();
    if (!from || !to || !kind || from === to) {
      api.toast('Pick two different people and name the bond', 'info');
      return;
    }
    api.saveBible(
      targetNodeId,
      mutateBible(api, targetNodeId, (bible) => ({
        ...bible,
        relations: [...bible.relations, { from, to, kind }],
      })),
    );
    form.open = false;
    form.kind = '';
    api.toast(`Added: ${from} — ${kind} — ${to}`, 'success');
  };

  return h(
    'div',
    { class: 'cast-relations' },
    h(
      'div',
      { class: 'cast-group-head' },
      h('h4', { class: 'cast-group-title', text: '💞 Relationships' }),
      targetNodeId
        ? button(
            form.open ? 'Cancel' : '＋ relationship',
            () => {
              form.open = !form.open;
              api.refresh();
            },
            'chip',
          )
        : null,
    ),
    form.open
      ? h(
          'div',
          { class: 'rel-form' },
          h('div', { class: 'row gap' }, fromSelect, h('span', { text: '—' }), toSelect, kindInput),
          h('div', { class: 'row gap' }, button('Add', addRelation, 'primary')),
        )
      : null,
    relations.length === 0 && !form.open
      ? h('p', { class: 'cast-empty', text: 'No bonds recorded yet.' })
      : h(
          'ul',
          { class: 'cast-list rel-list' },
          ...relations.map((relation, index) =>
            h(
              'li',
              { class: 'cast-entry' },
              h('span', {
                class: 'cast-name',
                text: `${relation.from} — ${relation.kind} — ${relation.to}`,
              }),
              h('button', {
                class: 'cast-tool cast-tool-danger',
                type: 'button',
                title: 'Remove this relationship',
                text: '✕',
                'aria-label': `Remove the relationship ${relation.from} — ${relation.kind} — ${relation.to}`,
                onclick: () => {
                  if (!targetNodeId) return;
                  api.saveBible(
                    targetNodeId,
                    mutateBible(api, targetNodeId, (bible) => ({
                      ...bible,
                      relations: bible.relations.filter((_, i) => i !== index),
                    })),
                  );
                  api.toast('Relationship removed', 'info');
                },
              }),
            ),
          ),
        ),
  );
}

// ---- The relationship graph -------------------------------------------------

function graphSection(bible: StoryBible | null): HTMLElement | null {
  if (!bible || bible.people.length < 2) return null;
  const people = bible.people.map((p) => p.name);
  const relations = bible.relations.filter((r) => people.includes(r.from) && people.includes(r.to));
  if (relations.length === 0) return null;

  const ns = 'http://www.w3.org/2000/svg';
  const size = 300;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 108;
  // Position by first-occurrence index so duplicate names don't collide.
  const pos = new Map<string, { x: number; y: number }>();
  const nameSeen = new Set<string>();
  people.forEach((name, index) => {
    const angle = (Math.PI * 2 * index) / people.length - Math.PI / 2;
    const key = nameSeen.has(name) ? `${name}#${index}` : name;
    nameSeen.add(name);
    pos.set(key, {
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    });
  });

  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'rel-graph');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Relationship map');

  const el = (tag: string, attrs: Record<string, string | number>, text?: string): SVGElement => {
    const node = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const pointOf = (name: string): { x: number; y: number } | undefined => {
    const direct = pos.get(name);
    if (direct) return direct;
    const key = [...pos.keys()].find((k) => k.startsWith(`${name}#`));
    return key ? pos.get(key) : undefined;
  };
  relations.forEach((relation) => {
    const a = pointOf(relation.from);
    const b = pointOf(relation.to);
    if (!a || !b) return;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    svg.appendChild(
      el('line', {
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        class: 'rel-edge',
        style: `stroke: hsl(${kindHue(relation.kind)} 45% 62%)`,
      }),
    );
    svg.appendChild(
      el('text', { x: mx, y: my, class: 'rel-kind-label', 'text-anchor': 'middle' }, relation.kind),
    );
  });

  people.forEach((name) => {
    const point = pos.get(name);
    if (!point) return;
    const group = document.createElementNS(ns, 'g');
    group.setAttribute('class', 'rel-node');
    group.appendChild(el('circle', { cx: point.x, cy: point.y, r: 22 }));
    group.appendChild(
      el(
        'text',
        { x: point.x, y: point.y + 4, class: 'rel-node-label', 'text-anchor': 'middle' },
        name.slice(0, 14),
      ),
    );
    group.appendChild(el('title', {}, name));
    svg.appendChild(group);
  });

  return h(
    'div',
    { class: 'cast-graph' },
    h('h4', { class: 'cast-group-title', text: '🕸️ The web of bonds' }),
    svg,
  );
}

function kindHue(kind: string): number {
  let hash = 0;
  for (const ch of kind) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return hash % 360;
}
