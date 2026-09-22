/**
 * ui/genpage.ts — the one generation ritual, shared by the page and turn views:
 *
 *   token → busy state → stream tokens live → attach to tree → refresh.
 *
 * The busy UI streams the model's output into the page as it is written —
 * generation should feel like watching a hand move across paper.
 */
import type { AppApi } from './ctx';
import { button, h, spinner } from './dom';
import { audit } from './audit';
import { buildContext, pageMessages } from '../core/prompt';
import { chapterCountUpTo, pageNumberAt } from '../core/tree';
import { maybeUpdateBible } from './cast';
import { maybeUpdateSummary } from './story';
import type { Book, StoryNode, TurnInput } from '../core/types';

export interface GenState {
  token: number;
  status: 'busy' | 'error';
  label: string;
  stream: string;
  error: string;
}

export const genStates = new Map<string, GenState>();

export type GenTarget = { kind: 'new'; parentId: string } | { kind: 'version'; pageId: string };

/** Generate a page with the app's endpoint settings, attach it, re-render. Returns the node, or null.
 * `chapterNumber` is the chapter this page opens if the direction starts a new
 * chapter; when omitted it is derived from the tree (a new page opens one past
 * the parent chain, a rewrite keeps the page's own chapter). */
export async function generatePage(
  api: AppApi,
  book: Book,
  direction: TurnInput,
  targetPageNumber: number,
  key: string,
  label: string,
  target: GenTarget,
  chapterNumber?: number,
): Promise<StoryNode | null> {
  const token = api.beginGen();
  audit(`generatePage start key=${key} token=${token} target=${target.kind}`);
  genStates.set(key, { token, status: 'busy', label, stream: '', error: '' });
  api.refresh();
  try {
    const context = buildContext(api.nodes, book);
    // The chapter number is a property of the tree, never of the page number:
    // a new page opens one chapter past the parent chain; a rewrite keeps the
    // page's own chapter.
    const resolvedChapter =
      chapterNumber ??
      (target.kind === 'new'
        ? chapterCountUpTo(api.nodes, target.parentId) + 1
        : chapterCountUpTo(api.nodes, target.pageId));
    const messages = pageMessages(
      context,
      direction,
      targetPageNumber,
      book.rules,
      resolvedChapter,
    );
    const model = book.model || api.lib.settings.endpoint.model;
    const text = await api.generateText(messages, {
      model,
      onToken: (piece) => {
        const state = genStates.get(key);
        if (state) state.stream += piece;
      },
    });
    audit(`generatePage got text len=${text.length} stale=${api.staleGen(token)}`);
    if (api.staleGen(token)) {
      genStates.delete(key);
      return null;
    }
    let node: StoryNode;
    if (target.kind === 'new') {
      node = api.attachPage(book, target.parentId, direction, text, model);
    } else {
      api.appendVersion(target.pageId, text, 'ai', model);
      node =
        api.nodes[target.pageId] ??
        ((): never => {
          throw new Error('versioned page vanished');
        })();
    }
    genStates.delete(key);
    // The cast follows the story: update it in the background after each page.
    maybeUpdateBible(api, book, node.id);
    // The memory too: fold the story into the rolling summary in the background.
    maybeUpdateSummary(api, book, node.id);
    api.refresh();
    return node;
  } catch (err) {
    audit(`generatePage error stale=${api.staleGen(token)} err=${String(err)}`);
    genStates.delete(key);
    if (api.staleGen(token)) {
      // Cancelled (cancel button or navigation) or superseded by a newer
      // generation — leave no stuck "busy" panel behind.
      api.refresh();
      return null;
    }
    genStates.set(key, { token, status: 'error', label, stream: '', error: api.genError(err) });
    api.refresh();
    return null;
  }
}

/** The busy/error panel. Streams tokens into the pre as they arrive. */
export function renderGenPanel(api: AppApi, key: string, onRetry: () => void): HTMLElement {
  const state = genStates.get(key) ?? {
    token: 0,
    status: 'error' as const,
    label: 'Generation state lost',
    stream: '',
    error: 'Internal error',
  };
  const pre = h('pre', { class: 'gen-stream', text: state.stream || '' });
  const meta = h('p', { class: 'gen-meta', text: state.label });

  if (state.status === 'busy') {
    const tick = setInterval(() => {
      if (!pre.isConnected) {
        clearInterval(tick);
        return;
      }
      const fresh = genStates.get(key);
      if (fresh && fresh.stream !== pre.textContent) pre.textContent = fresh.stream;
      if (fresh?.status === 'error' && pre.isConnected) {
        // The view re-rendered elsewhere; stop here.
        clearInterval(tick);
      }
    }, 150);
    return h(
      'div',
      { class: 'gen-panel' },
      h('div', { class: 'busy-row' }, spinner(), ' ', meta),
      pre,
      h(
        'div',
        { class: 'row gap' },
        button('Cancel', () => api.abortGeneration(), 'ghost'),
      ),
    );
  }

  return h(
    'div',
    { class: 'gen-panel' },
    h('div', { class: 'banner banner-error' }, state.error),
    button('Retry', () => onRetry(), 'primary'),
  );
}

/**
 * Parallel candidate fan-out: ask the model for `count` alternative versions
 * of the same page at once, stream each into its own panel, and attach the
 * finished ones as new versions of the page node. Returns how many landed.
 * A failed candidate can be retried by re-calling with a fresh count of 1
 * after deleting its error state.
 */
export async function generateCandidates(
  api: AppApi,
  book: Book,
  page: StoryNode,
  count: number,
): Promise<number> {
  if (page.data.kind !== 'page') return 0;
  const direction = page.data.direction;
  const context = buildContext(api.nodes, book);
  const messages = pageMessages(
    context,
    direction,
    pageNumberAt(api.nodes, page.id),
    book.rules,
    chapterCountUpTo(api.nodes, page.id),
  );
  const model = book.model || api.lib.settings.endpoint.model;
  const token = api.beginGen();
  const keys = Array.from({ length: count }, (_, i) => `cand:${page.id}:${i}`);
  for (const [i, key] of keys.entries()) {
    genStates.set(key, {
      token,
      status: 'busy',
      label: `Candidate ${i + 1} of ${count} — writing an alternative…`,
      stream: '',
      error: '',
    });
  }
  api.refresh();

  const run = async (key: string): Promise<number> => {
    try {
      const text = await api.generateText(messages, {
        model,
        parallel: true,
        onToken: (piece) => {
          const state = genStates.get(key);
          if (state) state.stream += piece;
        },
      });
      if (api.staleGen(token)) {
        genStates.delete(key);
        return 0;
      }
      const cleaned = text.trim();
      if (cleaned.length === 0) throw new Error('The model returned an empty page');
      genStates.delete(key);
      api.appendVersion(page.id, cleaned, 'ai', model);
      return 1;
    } catch (err) {
      genStates.delete(key);
      if (api.staleGen(token)) return 0;
      genStates.set(key, {
        token,
        status: 'error',
        label: 'Candidate failed',
        stream: '',
        error: api.genError(err),
      });
      return 0;
    }
  };

  const results = await Promise.allSettled(keys.map((key) => run(key)));
  const attached = results.reduce(
    (sum, result) => sum + (result.status === 'fulfilled' ? result.value : 0),
    0,
  );
  api.refresh();
  return attached;
}
