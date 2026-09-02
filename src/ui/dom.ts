/**
 * ui/dom.ts — a tiny hyperscript DOM builder. No framework: views return DOM
 * elements built with h(), and all user content is inserted as text nodes so
 * LLM output can never inject markup.
 */

export type Child = Node | string | number | null | undefined | false | Child[];

type Props = Record<string, unknown> & { class?: string; className?: string };

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class' || key === 'className') {
        node.className = String(value);
      } else if (key === 'dataset') {
        Object.assign(node.dataset, value as Record<string, string>);
      } else if (key === 'style') {
        node.setAttribute('style', String(value));
      } else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key === 'text') {
        node.textContent = String(value);
      } else if (key in node) {
        (node as unknown as Record<string, unknown>)[key] = value;
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }
  append(node, children);
  return node;
}

function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (Array.isArray(child)) {
      append(parent, child);
      continue;
    }
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(
      typeof child === 'string' || typeof child === 'number'
        ? document.createTextNode(String(child))
        : child,
    );
  }
}

export function mount(container: HTMLElement, ...children: Child[]): void {
  container.replaceChildren();
  append(container, children);
}

export function button(
  label: string,
  onClick: (event: MouseEvent) => void,
  kind: 'primary' | 'ghost' | 'danger' | 'chip' = 'ghost',
  opts: { title?: string; disabled?: boolean } = {},
): HTMLButtonElement {
  const btn = h('button', {
    class: `btn btn-${kind}`,
    type: 'button',
    text: label,
    title: opts.title ?? '',
    disabled: opts.disabled === true,
    onclick: onClick,
  });
  return btn;
}

/** A small labeled control wrapper. */
export function field(
  label: string,
  control: HTMLElement,
  hint?: string | HTMLElement,
): HTMLElement {
  return h(
    'label',
    { class: 'field' },
    h('span', { class: 'field-label', text: label }),
    control,
    hint ? h('span', { class: 'field-hint' }, typeof hint === 'string' ? hint : hint) : null,
  );
}

export function spinner(): HTMLElement {
  return h('span', { class: 'spinner', role: 'status', 'aria-label': 'working' });
}

export function fmtDate(ts: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(ts));
  } catch {
    return new Date(ts).toDateString();
  }
}

export function fmtNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}
