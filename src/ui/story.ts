/**
 * ui/story.ts — the rolling story summary: the book's compact long-term memory.
 *
 * Maintained in the background after each page (exactly like the living cast:
 * outside the staleness token so it can never invalidate in-flight page work),
 * stored ON the page node so every branch owns its own memory, and injected
 * into every generation prompt so long books never drift. The panel shows the
 * current memory and offers a manual refresh.
 */
import type { AppApi } from './ctx';
import { button, h, pruneMap, spinner } from './dom';
import { buildContextTo, summaryMessages } from '../core/prompt';
import { getNode, pathToRoot, summaryUpTo } from '../core/tree';
import type { Book } from '../core/types';

const busy = new Map<string, { status: 'busy' | 'error'; error: string }>();
/** The newest page awaiting a memory update per book (trailing-queue). */
const pendingSummary = new Map<string, string>();
/**
 * Per-book panel state. The view is rebuilt from scratch on every render — by
 * the shell, and by the panel's own refresh — so without this the reader's
 * expand was forgotten on the click that expanded it, and the memory they were
 * watching update snapped shut. The cast panel keeps the same record.
 */
const panelOpen = new Map<string, boolean>();

export function summaryBusy(bookId: string): { status: 'busy' | 'error'; error: string } | null {
  return busy.get(bookId) ?? null;
}

/**
 * Kick off a summary update for a page (fire-and-forget). Idempotent: a second
 * call while one is running is a no-op, and `parallel: true` keeps any
 * concurrent generation alive — a memory save is harmless and idempotent, so
 * it must never invalidate in-flight page work.
 *
 * `manual` is set by the memory panel's own buttons: an explicit refresh click
 * deserves a plain error toast; the automatic upkeep reports through the panel.
 */
export async function updateSummary(
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
    // The panel may be open on a turn node; fall back to the latest page.
    let pageNode = getNode(api.nodes, pageNodeId);
    if (pageNode && pageNode.kind !== 'page') {
      pageNode =
        [...pathToRoot(api.nodes, pageNodeId)].reverse().find((n) => n.kind === 'page') ?? null;
    }
    if (!pageNode || pageNode.kind !== 'page') {
      busy.delete(book.id);
      api.refresh();
      return;
    }
    const ctx = buildContextTo(api.nodes, book, pageNode.id);
    const previous = summaryUpTo(api.nodes, pageNode.id)?.summary ?? null;
    const raw = await api.generateText(summaryMessages(ctx, previous), {
      model: api.lib.settings.fastModel || api.lib.settings.endpoint.model,
      parallel: true,
      // Background: the rolling summary is requested as a page lands, right
      // before the view navigates on.
      background: true,
      quiet: !manual,
    });
    const clean = raw.trim();
    if (clean.length === 0) throw new Error('The model returned an empty summary');
    api.saveSummary(pageNode.id, clean);
    // This page IS the newest request: drop the trailing marker, or a later
    // update finishing would see it as pending and re-run this one.
    if (pendingSummary.get(book.id) === pageNode.id) pendingSummary.delete(book.id);
    busy.delete(book.id);
    api.refresh();
    // Trailing pass: a page that landed while this one ran was skipped by the
    // busy-guard, so the memory would otherwise lag one page behind forever.
    const trailing = pendingSummary.get(book.id);
    if (trailing && trailing !== pageNode.id) {
      pendingSummary.delete(book.id);
      void updateSummary(api, book, trailing);
    }
  } catch (err) {
    busy.delete(book.id);
    if (pendingSummary.get(book.id) === pageNodeId) pendingSummary.delete(book.id);
    busy.set(book.id, { status: 'error', error: api.genError(err) });
    api.refresh();
  }
}

/**
 * Fire-and-forget summary update when the setting allows it.
 *
 * The living-cast call already asks the model for the rolling summary in the
 * same JSON and saves it on the same page node, so with the cast updater on
 * this second call would be pure duplication: twice the model load, twice the
 * chance of a busy-server failure, and two different summaries racing for
 * `page.data.summary` (the cast panel's "story so far" and the memory panel
 * were then showing different texts). One owner per page — the cast call while
 * it is enabled, this one otherwise.
 */
export function maybeUpdateSummary(api: AppApi, book: Book, pageNodeId: string): void {
  if (!api.lib.settings.autoSummary) return;
  if (api.lib.settings.autoBible) return;
  if (!api.lib.settings.endpoint.model) return;
  pendingSummary.set(book.id, pageNodeId);
  void updateSummary(api, book, pageNodeId);
}

/**
 * The story-memory panel: the current rolling summary, its page stamp, a
 * manual refresh, and the error/retry state. Collapsed by default.
 */
export function renderStoryMemory(
  api: AppApi,
  book: Book,
  opts: { pageNodeId?: string | null; open?: boolean } = {},
): HTMLElement {
  pruneMap(panelOpen, 60);
  const upTo = opts.pageNodeId ?? book.frontierId;
  const latest = summaryUpTo(api.nodes, upTo);
  const state = busy.get(book.id);
  // The reader's own expand is remembered; an explicit `open` request counts
  // only for the first render of this book (as in the cast panel).
  const open = panelOpen.has(book.id) ? panelOpen.get(book.id) === true : opts.open === true;

  const details = h(
    'details',
    { class: 'memory', open: open ? true : undefined },
    h(
      'summary',
      { class: 'memory-summary' },
      h('span', { class: 'memory-title', text: '🧠 Story memory — the rolling summary' }),
      h('span', {
        class: 'memory-count',
        text: latest ? `as of page ${latest.pageNumber}` : 'not written yet',
      }),
      state?.status === 'busy'
        ? h('span', { class: 'memory-state' }, spinner(), ' updating…')
        : state?.status === 'error'
          ? h('span', { class: 'memory-state memory-state-error', text: 'update failed' })
          : null,
      h(
        'span',
        { class: 'memory-actions' },
        button(
          '↻ Update',
          (event) => {
            event.preventDefault();
            event.stopPropagation();
            void updateSummary(api, book, upTo, { manual: true });
          },
          'chip',
          { title: 'Ask the model to re-read the story so far and refresh the memory' },
        ),
      ),
    ),
    h(
      'div',
      { class: 'memory-body' },
      latest
        ? h('p', { class: 'memory-text', text: latest.summary })
        : h(
            'p',
            { class: 'memory-empty' },
            'After a page is kept, the model quietly folds the whole story into a compact memory so the book never forgets its beginning — even after hundreds of pages. Turn it on in Settings (“Keep the rolling story summary up to date”).',
          ),
      state?.status === 'error'
        ? h(
            'div',
            { class: 'banner banner-error' },
            state.error,
            ' ',
            button('Retry', () => void updateSummary(api, book, upTo, { manual: true }), 'chip'),
            h('p', {
              class: 'banner-hint',
              text: 'This is the optional story-memory upkeep — the pages you have written are unaffected. Retry, or pick a stronger model for upkeep in Settings.',
            }),
          )
        : null,
    ),
  );
  // Remember the reader's choice — the panel is re-created on every render.
  details.addEventListener('toggle', () => {
    panelOpen.set(book.id, details.open);
  });
  return details;
}
