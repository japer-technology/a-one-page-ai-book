/**
 * ui/views/titles.ts — the title phase: propose 5, browse, regenerate,
 * edit, pick. EVERY title is remembered (they all live on the seed node),
 * so later the book can be re-entered from any of them.
 */
import type { AppApi } from '../ctx';
import { button, h, spinner } from '../dom';
import { parseTitleOptions } from '../../core/parsers';
import { titlesMessages } from '../../core/prompt';
import { getNode } from '../../core/tree';
import type { SeedOptions, TitleOption } from '../../core/types';

// Session-scoped view state: survives re-renders, dies with the page.
const selection = new Map<string, { index: number; edited: string }>();
const busy = new Map<string, { token: number; error: string | null }>();

export function renderTitles(api: AppApi): HTMLElement {
  const seedId = api.params.seed ?? '';
  const seedNode = seedId ? getNode(api.nodes, seedId) : null;
  if (!seedNode || seedNode.data.kind !== 'seed') {
    api.toast('That seed is gone. Start a new one.', 'error');
    return h(
      'div',
      { class: 'view' },
      button('← Library', () => api.navigate('library')),
    );
  }
  const seed = seedNode.data;
  const sel = selection.get(seedId) ?? { index: -1, edited: '' };
  selection.set(seedId, sel);

  const state = busy.get(seedId);
  if (state && state.error === null) {
    return h(
      'div',
      { class: 'view view-titles' },
      h(
        'header',
        { class: 'view-head' },
        h('h1', { text: 'Proposing titles…' }),
        h('p', { class: 'lede', text: seed.text }),
      ),
      h('div', { class: 'busy-row' }, spinner(), ' asking your local LLM for titles'),
    );
  }

  const cards = seed.titles.map((option, index) => titleCard(api, option, index, sel));
  const error = state?.error
    ? h(
        'div',
        { class: 'banner banner-error' },
        state.error,
        ' ',
        retry(api, seedId, seed.text, seed.options),
      )
    : null;

  return h(
    'div',
    { class: 'view view-titles' },
    h(
      'header',
      { class: 'view-head' },
      h('h1', { text: 'Choose a title' }),
      h('p', { class: 'lede', text: `Seed: “${seed.text}”` }),
    ),
    error,
    h(
      'div',
      { class: 'title-list' },
      ...(cards.length > 0 ? cards : [h('p', { text: 'No titles yet.' })]),
    ),
    h(
      'div',
      { class: 'row gap' },
      button('🎲 Propose 5 more', () => generate(api, seedId, seed.text, seed.options, true)),
      button(
        sel.index >= 0 && (sel.edited || seed.titles[sel.index]?.title)
          ? '✔ Use this title →'
          : 'Select a title above',
        () => {
          const chosen = seed.titles[sel.index];
          if (!chosen) return;
          const option: TitleOption =
            sel.edited.trim().length > 0
              ? { title: sel.edited.trim(), tagline: chosen.tagline }
              : chosen;
          api.pickTitle(seedId, option);
          api.navigate('page', { auto: '1' });
        },
        sel.index >= 0 ? 'primary' : 'ghost',
        { disabled: sel.index < 0 },
      ),
    ),
  );
}

function titleCard(
  api: AppApi,
  option: TitleOption,
  index: number,
  sel: { index: number; edited: string },
): HTMLElement {
  const selected = sel.index === index;
  const editing = selected && sel.edited.length > 0;

  const card = h(
    'article',
    {
      class: `title-card${selected ? ' selected' : ''}`,
      onclick: () => {
        sel.index = index;
        sel.edited = '';
        api.refresh();
      },
    },
    h(
      'div',
      { class: 'title-text' },
      h('h2', { text: editing ? sel.edited : option.title }),
      option.tagline ? h('p', { class: 'book-tagline', text: option.tagline }) : null,
    ),
  );

  const edit = h('input', {
    class: 'input title-edit',
    type: 'text',
    placeholder: 'Edit the title…',
    value: sel.edited,
    oninput: (event: Event) => {
      sel.edited = (event.target as HTMLInputElement).value;
      if (sel.index === index) {
        const heading = card.querySelector('h2');
        if (heading) heading.textContent = sel.edited || option.title;
      }
    },
  });

  if (selected) {
    card.appendChild(h('div', { class: 'row gap' }, edit));
  }
  return card;
}

async function generate(
  api: AppApi,
  seedId: string,
  text: string,
  options: SeedOptions,
  append: boolean,
): Promise<void> {
  const token = api.beginGen();
  busy.set(seedId, { token, error: null });
  api.refresh();
  try {
    const raw = await api.generateText(titlesMessages(text, options, 5));
    if (api.staleGen(token)) return;
    const parsed = parseTitleOptions(raw);
    if (parsed.length === 0) throw new Error('The model returned no titles');
    api.appendTitles(seedId, parsed.slice(0, 5));
    busy.delete(seedId);
    const sel = selection.get(seedId);
    if (sel && !append) {
      sel.index = 0;
      sel.edited = '';
    }
    api.refresh();
  } catch (err) {
    if (api.staleGen(token)) return;
    busy.set(seedId, { token, error: api.genError(err) });
    api.refresh();
  }
}

function retry(api: AppApi, seedId: string, text: string, options: SeedOptions): HTMLElement {
  return button('Retry', () => void generate(api, seedId, text, options, true));
}

// Auto-start the first batch when the view opens with an empty title list.
export function maybeAutoGenerate(api: AppApi): void {
  const seedId = api.params.seed ?? '';
  const seedNode = seedId ? getNode(api.nodes, seedId) : null;
  if (
    seedNode &&
    seedNode.data.kind === 'seed' &&
    seedNode.data.titles.length === 0 &&
    !busy.has(seedId)
  ) {
    void generate(api, seedId, seedNode.data.text, seedNode.data.options, false);
  }
}
