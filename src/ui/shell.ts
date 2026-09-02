/**
 * ui/shell.ts — the permanent chrome: header, navigation, toast stack.
 * View content is rendered by main.ts and passed in; the shell owns nothing else.
 */
import type { AppApi, ToastKind, ViewName } from './ctx';
import { h, mount } from './dom';

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

const NAV: Array<{ view: ViewName; label: string }> = [
  { view: 'library', label: 'Library' },
  { view: 'seed', label: 'New book' },
  { view: 'settings', label: 'Settings' },
];

export function renderShell(api: AppApi, viewContent: HTMLElement, toasts: Toast[]): void {
  const app = document.getElementById('app');
  if (!app) return;

  const nav = h(
    'nav',
    { class: 'nav' },
    h(
      'button',
      { class: 'brand', type: 'button', onclick: () => api.navigate('library') },
      '📖 Page Turn',
    ),
    h(
      'div',
      { class: 'nav-links' },
      ...NAV.map((item) =>
        h('button', {
          class: `nav-link${api.view === item.view ? ' active' : ''}`,
          type: 'button',
          text: item.label,
          onclick: () => api.navigate(item.view),
        }),
      ),
    ),
    h(
      'div',
      { class: 'nav-right' },
      h(
        'button',
        {
          class: 'model-chip',
          type: 'button',
          title: 'Open Settings to change the model',
          onclick: () => api.navigate('settings'),
        },
        `⚙ ${modelLabel(api)}`,
      ),
    ),
  );

  const main = h('main', { class: 'main' }, viewContent);
  const toastStack = h(
    'div',
    { class: 'toasts', id: 'toasts', role: 'status' },
    ...toasts.map(toastNode),
  );

  mount(app, nav, main, toastStack);
}

function modelLabel(api: AppApi): string {
  const model = api.book?.model ?? api.lib.settings.endpoint.model;
  return model ? model : 'no model';
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
