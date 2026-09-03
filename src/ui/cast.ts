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
import { button, h, spinner } from './dom';
import { bibleMessages, buildContextTo } from '../core/prompt';
import { parseBible } from '../core/parsers';
import { bibleUpTo, getNode, pageNumberAt, pathToRoot } from '../core/tree';
import type { BibleEntry, Book, StoryBible } from '../core/types';

const busy = new Map<string, { status: 'busy' | 'error'; error: string }>();

type GroupKey = 'people' | 'places' | 'things' | 'threads';

interface CastUIState {
  adding: GroupKey | null;
  editing: string | null; // `${group}:${index}`
  draft: { name: string; note: string; details: string };
}

const castUI = new Map<string, CastUIState>();

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
 */
export async function updateBible(api: AppApi, book: Book, pageNodeId: string): Promise<void> {
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
      model: api.lib.settings.fastModel || book.model || api.lib.settings.endpoint.model,
      parallel: true,
    });
    const parsed = parseBible(typeof raw === 'string' ? raw : JSON.stringify(raw), previous);
    parsed.at = pageNumberAt(api.nodes, pageNodeId);
    parsed.updatedAt = Date.now();
    api.saveBible(pageNodeId, parsed);
    busy.delete(book.id);
    api.refresh();
  } catch (err) {
    busy.delete(book.id);
    busy.set(book.id, { status: 'error', error: api.genError(err) });
    api.refresh();
  }
}

/** Fire-and-forget cast update when the setting allows it. */
export function maybeUpdateBible(api: AppApi, book: Book, pageNodeId: string): void {
  if (!api.lib.settings.autoBible) return;
  if (!api.lib.settings.endpoint.model) return;
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
  const upTo = opts.pageNodeId ?? book.frontierId;
  const latest = bibleUpTo(api.nodes, upTo);
  const state = busy.get(book.id);
  const ui = castUI.get(book.id) ?? {
    adding: null,
    editing: null,
    draft: { name: '', note: '', details: '' },
  };
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
      ui.adding === key ? entryForm(api, targetNodeId, key, null, ui) : null,
      h(
        'ul',
        { class: 'cast-list' },
        ...entries.map((entry, index) => castEntry(api, targetNodeId, key, index, entry, ui)),
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
      'You curate the cast: rename anyone, fix notes, add threads to track. The model writes with these names.',
    ),
    h('div', { class: 'cast-grid' }, ...groups),
    state?.status === 'error'
      ? h(
          'div',
          { class: 'banner banner-error' },
          state.error,
          ' ',
          button('Retry', () => void updateBible(api, book, upTo), 'chip'),
        )
      : null,
  );

  return h(
    'details',
    { class: 'cast', open: opts.open === false ? undefined : true },
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
            void updateBible(api, book, upTo);
          },
          'chip',
          { title: 'Ask the model to re-read the story so far and refresh the cast' },
        ),
      ),
    ),
    body,
  );
}

function castEntry(
  api: AppApi,
  targetNodeId: string | null,
  group: GroupKey,
  index: number,
  entry: BibleEntry,
  ui: CastUIState,
): HTMLElement {
  const key = `${group}:${index}`;
  if (ui.editing === key && targetNodeId) {
    return entryForm(api, targetNodeId, group, index, ui, entry);
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
      button('Cancel', () => {
        ui.adding = null;
        ui.editing = null;
        api.refresh();
      }),
    ),
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
    at: pageNumberAt(api.nodes, pageNodeId),
    updatedAt: Date.now(),
  };
  return { ...recipe(structuredClone(base)), updatedAt: Date.now() };
}
