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
import { buildContext, pageMessages } from '../core/prompt';
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

/** Generate a page with the app's endpoint settings, attach it, re-render. Returns the node, or null. */
export async function generatePage(
  api: AppApi,
  book: Book,
  direction: TurnInput,
  targetPageNumber: number,
  key: string,
  label: string,
  target: GenTarget,
): Promise<StoryNode | null> {
  const token = api.beginGen();
  genStates.set(key, { token, status: 'busy', label, stream: '', error: '' });
  api.refresh();
  try {
    const context = buildContext(api.nodes, book);
    const messages = pageMessages(context, direction, targetPageNumber);
    const text = await api.generateText(messages, {
      model: book.model,
      onToken: (piece) => {
        const state = genStates.get(key);
        if (state) state.stream += piece;
      },
    });
    if (api.staleGen(token)) {
      genStates.delete(key);
      return null;
    }
    let node: StoryNode;
    if (target.kind === 'new') {
      node = api.attachPage(book, target.parentId, direction, text, book.model);
    } else {
      api.appendVersion(target.pageId, text, 'ai', book.model);
      node =
        api.nodes[target.pageId] ??
        ((): never => {
          throw new Error('versioned page vanished');
        })();
    }
    genStates.delete(key);
    api.refresh();
    return node;
  } catch (err) {
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
