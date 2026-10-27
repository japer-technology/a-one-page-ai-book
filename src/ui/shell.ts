/**
 * ui/shell.ts — the permanent chrome: header, navigation, toast stack.
 * View content is rendered by main.ts and passed in; the shell owns nothing else.
 */
import type { AppApi, ToastKind, ViewName } from './ctx';
import { titleOf } from '../core/tree';
import { h, mount } from './dom';

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
  /** Lifetime handle, so a repeated (de-duplicated) toast can restart its clock. */
  timer?: ReturnType<typeof setTimeout>;
}

const NAV: Array<{ view: ViewName; label: string }> = [
  { view: 'library', label: 'Library' },
  { view: 'seed', label: 'New book' },
  { view: 'settings', label: 'Settings' },
];

export function renderShell(api: AppApi, viewContent: HTMLElement, toasts: Toast[]): void {
  const app = document.getElementById('app');
  if (!app) return;

  const book = api.book;
  const inBook =
    book && ['page', 'turn', 'theend', 'reader', 'archive', 'about'].includes(api.view);
  const writing = ['page', 'turn', 'theend'].includes(api.view);
  const activeView = api.view === 'titles' ? 'seed' : api.view;

  const nav = h(
    'nav',
    { class: 'nav', 'aria-label': 'Main navigation' },
    h(
      'button',
      { class: 'brand', type: 'button', onclick: () => api.navigate('library') },
      h('span', { class: 'brand-mark', 'aria-hidden': 'true', text: 'P' }),
      'Page Turn',
    ),
    h(
      'div',
      { class: 'nav-links' },
      ...NAV.map((item) =>
        h('button', {
          class: `nav-link${activeView === item.view ? ' active' : ''}`,
          'aria-current': activeView === item.view ? 'page' : undefined,
          type: 'button',
          text: item.label,
          onclick: () => api.navigate(item.view),
        }),
      ),
    ),
    h(
      'div',
      { class: 'nav-right' },
      h('button', {
        class: `nav-link${api.view === 'help' ? ' active' : ''}`,
        type: 'button',
        text: 'Help',
        'aria-current': api.view === 'help' ? 'page' : undefined,
        title: 'Help — the whole manual (? key)',
        onclick: () => api.navigate('help'),
      }),
      h(
        'span',
        {
          class: 'nav-working',
          id: 'nav-working',
          role: 'status',
          title: 'The local model is working on your request',
        },
        h('span', { class: 'spinner' }),
        ' Working…',
      ),
      h(
        'button',
        {
          class: 'model-chip',
          type: 'button',
          title: `Selected model: ${modelLabel(api)}. Open Settings to configure it.`,
          onclick: () => api.navigate('settings'),
        },
        h('span', { class: 'model-chip-label', text: 'MODEL' }),
        h('span', { class: 'model-chip-name', text: modelLabel(api) }),
      ),
    ),
  );

  const bookNav =
    inBook && book
      ? h(
          'section',
          { class: 'book-context', 'aria-label': 'Current book' },
          h(
            'div',
            { class: 'book-context-heading' },
            h('span', { class: 'eyebrow', text: 'Your workspace' }),
            h('p', { class: 'book-context-title', text: titleOf(api.nodes, book) }),
          ),
          h(
            'nav',
            { class: 'book-nav', 'aria-label': 'Book navigation' },
            h('button', {
              class: `nav-link${writing ? ' active' : ''}`,
              type: 'button',
              text: 'Write',
              'aria-current': writing ? 'page' : undefined,
              onclick: () => api.openBook(book.id),
            }),
            ...(
              [
                { view: 'reader', label: 'Read' },
                { view: 'archive', label: 'Story map' },
                { view: 'about', label: 'About' },
              ] as const
            ).map((item) =>
              h('button', {
                class: `nav-link${api.view === item.view ? ' active' : ''}`,
                type: 'button',
                text: item.label,
                'aria-current': api.view === item.view ? 'page' : undefined,
                onclick: () => api.navigate(item.view, { book: book.id }),
              }),
            ),
          ),
        )
      : null;
  const main = h('main', { class: 'main', id: 'main-content', tabIndex: -1 }, bookNav, viewContent);
  const skip = h('button', {
    class: 'skip-link',
    type: 'button',
    text: 'Skip to content',
    onclick: () => main.focus(),
  });
  const toastStack = h(
    'div',
    { class: 'toasts', id: 'toasts', role: 'status' },
    ...toasts.map(toastNode),
  );

  mount(app, skip, nav, main, toastStack);
}

function modelLabel(api: AppApi): string {
  // The endpoint's model is the one the app generates with; a book's saved
  // name is provenance, not the active model.
  const model = api.lib.settings.endpoint.model;
  return model ? model : 'Set up a model';
}

function toastNode(toast: Toast): HTMLElement {
  return h('div', { class: `toast toast-${toast.kind}`, text: toast.message });
}

/**
 * Update ONLY the toast stack in place. Toasts must never trigger a full
 * re-render: views hold live DOM references (form inputs, scan progress) that
 * a re-render would detach and reset.
 */
export function renderToastStack(toasts: Toast[]): void {
  const stack = document.getElementById('toasts');
  if (!stack) return;
  mount(stack, ...toasts.map(toastNode));
}
