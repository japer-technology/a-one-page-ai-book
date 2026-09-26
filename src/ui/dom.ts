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
      if (value === null || value === undefined || value === false) {
        // `false` is a meaningful VALUE for ARIA/data state attributes: "false"
        // is not the same as absent. Dropping it silently made
        // `'aria-expanded': false` render no attribute at all.
        if (value === false && (key.startsWith('aria-') || key.startsWith('data-'))) {
          node.setAttribute(key, 'false');
        }
        continue;
      }
      if (key === 'class' || key === 'className') {
        node.className = String(value);
      } else if (key === 'dataset') {
        Object.assign(node.dataset, value as Record<string, string>);
      } else if (key === 'style') {
        // Accept both the declaration string every current caller passes and
        // the object form hyperscript users expect — `String({})` would emit
        // style="[object Object]" and silently drop every declaration.
        node.setAttribute(
          'style',
          typeof value === 'object'
            ? Object.entries(value as Record<string, string | number>)
                .map(([prop, val]) => `${prop}:${val}`)
                .join(';')
            : String(value),
        );
      } else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key === 'text') {
        node.textContent = String(value);
      } else if (key === 'list') {
        // HTMLInputElement.list is a READONLY property — assigning to it throws
        // in strict mode. The datalist linkage must go through the attribute.
        node.setAttribute('list', String(value));
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

let fieldSeq = 0;

/**
 * A small labeled control wrapper.
 *
 * This deliberately does NOT use a wrapping `<label>`: a label forwards every
 * click anywhere inside it (including on its own caption text and hint) to its
 * *first labelable descendant*. Controls that are composites — the segmented
 * page-length picker, the standing-rules chips — contain `<button>`s, so a
 * caption click would silently activate the first one and, for the rules
 * chips, delete the reader's standing rule. Naming is instead carried by
 * `aria-labelledby` (single form control) or `role="group"` (composite), which
 * keeps the accessible name without the accidental activation.
 */
export function field(
  label: string,
  control: HTMLElement,
  hint?: string | HTMLElement,
): HTMLElement {
  const labelId = `field-label-${++fieldSeq}`;
  const labelEl = h('span', { class: 'field-label', id: labelId, text: label });
  const isFormControl =
    control instanceof HTMLInputElement ||
    control instanceof HTMLSelectElement ||
    control instanceof HTMLTextAreaElement;
  if (
    isFormControl &&
    !control.hasAttribute('aria-label') &&
    !control.hasAttribute('aria-labelledby')
  ) {
    control.setAttribute('aria-labelledby', labelId);
  }
  return h(
    'div',
    isFormControl
      ? { class: 'field' }
      : { class: 'field', role: 'group', 'aria-labelledby': labelId },
    labelEl,
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

/** Cap session-scoped maps so long sessions can never balloon memory. */
export function pruneMap<K, V>(map: Map<K, V>, max: number): void {
  if (map.size <= max) return;
  const excess = map.size - max;
  let dropped = 0;
  for (const key of [...map.keys()]) {
    if (dropped >= excess) break;
    map.delete(key);
    dropped++;
  }
}

/** Re-exported so views keep one import site for their formatting helpers. */
export { fmtNumber, plural } from '../core/format';
