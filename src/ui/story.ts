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
import { button, h, spinner } from './dom';
import { buildContextTo, summaryMessages } from '../core/prompt';
import { getNode, pathToRoot, summaryUpTo } from '../core/tree';
import type { Book } from '../core/types';

const busy = new Map<string, { status: 'busy' | 'error'; error: string }>();

export function summaryBusy(bookId: string): { status: 'busy' | 'error'; error: string } | null {
  return busy.get(bookId) ?? null;
}

/**
 * Kick off a summary update for a page (fire-and-forget). Idempotent: a second
 * call while one is running is a no-op, and `parallel: true` keeps any
 * concurrent generation alive — a memory save is harmless and idempotent, so
 * it must never invalidate in-flight page work.
 */
export async function updateSummary(api: AppApi, book: Book, pageNodeId: string): Promise<void> {
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
      model: api.lib.settings.fastModel || book.model || api.lib.settings.endpoint.model,
      parallel: true,
    });
    const clean = raw.trim();
    if (clean.length === 0) throw new Error('The model returned an empty summary');
    api.saveSummary(pageNode.id, clean);
    busy.delete(book.id);
    api.refresh();
  } catch (err) {
    busy.delete(book.id);
    busy.set(book.id, { status: 'error', error: api.genError(err) });
    api.refresh();
  }
}

/** Fire-and-forget summary update when the setting allows it. */
export function maybeUpdateSummary(api: AppApi, book: Book, pageNodeId: string): void {
  if (!api.lib.settings.autoSummary) return;
  if (!api.lib.settings.endpoint.model) return;
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
  const upTo = opts.pageNodeId ?? book.frontierId;
  const latest = summaryUpTo(api.nodes, upTo);
  const state = busy.get(book.id);

  return h(
    'details',
    { class: 'memory', open: opts.open ? true : undefined },
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
            void updateSummary(api, book, upTo);
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
            button('Retry', () => void updateSummary(api, book, upTo), 'chip'),
          )
        : null,
    ),
  );
}
