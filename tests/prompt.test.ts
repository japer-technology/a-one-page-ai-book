import { describe, expect, it } from 'vitest';
import {
  buildContext,
  directionText,
  endingsMessages,
  pageMessages,
  suggestionsMessages,
  SYSTEM_PROMPT,
  titlesMessages,
  TONE_GUIDANCE,
} from '../src/core/prompt';
import {
  finishBook,
  makeBook,
  makePageNode,
  makeSeedNode,
  makeTitleNode,
  makeTurnNode,
} from '../src/core/tree';
import { emptySeedOptions } from '../src/core/schema';
import { DEFAULT_TURN } from '../src/core/types';
import type { StoryNode } from '../src/core/types';

function fixture(pages = 3) {
  const seed = makeSeedNode('A seed.', emptySeedOptions());
  const title = makeTitleNode(seed.id, { title: 'T', tagline: '' });
  const nodes: Record<string, StoryNode> = { [seed.id]: seed, [title.id]: title };
  let parent = title.id;
  for (let i = 1; i <= pages; i++) {
    const page = makePageNode(
      parent,
      i === 1 ? DEFAULT_TURN : { ...DEFAULT_TURN, direction: `beat ${i}` },
      'm',
      `Page ${i}. `.repeat(20),
    );
    nodes[page.id] = page;
    parent = page.id;
    if (i < pages) {
      const turn = makeTurnNode(page.id, { ...DEFAULT_TURN, direction: `beat ${i + 1}` });
      nodes[turn.id] = turn;
      parent = turn.id;
    }
  }
  const last = Object.values(nodes)
    .filter((n) => n.kind === 'page')
    .at(-1);
  const book = makeBook(seed.id, title.id, 'm');
  return { nodes, book: last ? finishBook(book, last.id) : book };
}

describe('buildContext', () => {
  it('keeps the seed, title and recent pages within budget', () => {
    const { nodes, book } = fixture(5);
    const ctx = buildContext(nodes, book);
    expect(ctx.seed).toBe('A seed.');
    expect(ctx.title).toBe('T');
    expect(ctx.pages.length).toBeGreaterThan(0);
    expect(ctx.pages.length).toBeLessThanOrEqual(5);
    const words = ctx.pages.reduce((sum, p) => sum + p.split(/\s+/).length, 0);
    expect(words).toBeLessThanOrEqual(2600);
  });

  it('surfaces the last direction', () => {
    const { nodes, book } = fixture(3);
    const ctx = buildContext(nodes, book);
    expect(ctx.lastDirection?.direction).toBe('beat 3');
  });
});

describe('prompt assembly', () => {
  it('produces title messages that ask for JSON', () => {
    const messages = titlesMessages('seed text', { ...emptySeedOptions(), genre: 'noir' }, 5);
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('ONE page');
    expect(messages[1]?.content).toContain('seed text');
    expect(messages[1]?.content).toContain('genre: noir');
    expect(messages[1]?.content).toContain('JSON array of 5 objects');
  });

  it('includes the story so far and the direction in page messages', () => {
    const ctx = { seed: 's', title: 't', pages: ['p1', 'p2'], lastDirection: null };
    const messages = pageMessages(
      ctx,
      { ...DEFAULT_TURN, direction: 'the storm hits', tone: 'darker' },
      3,
    );
    expect(messages[1]?.content).toContain('p1');
    expect(messages[1]?.content).toContain('the storm hits');
    expect(messages[1]?.content).toContain('Tilt darker');
    expect(messages[1]?.content).toContain('page 3');
  });

  it('adds ending instructions when the turn ends the story', () => {
    const ctx = { seed: 's', title: 't', pages: ['p1'], lastDirection: null };
    const messages = pageMessages(ctx, { ...DEFAULT_TURN, ending: true }, 2);
    expect(messages[1]?.content).toContain('ENDING PAGE');
  });

  it('asks for a JSON array in suggestions and endings', () => {
    const ctx = { seed: 's', title: 't', pages: ['p1'], lastDirection: null };
    expect(suggestionsMessages(ctx, 3)[1]?.content).toContain('JSON array of strings');
    expect(endingsMessages(ctx, 3)[1]?.content).toContain('JSON array');
  });
});

describe('calibration language', () => {
  it('maps every tone to structural guidance', () => {
    for (const guidance of Object.values(TONE_GUIDANCE)) {
      expect(guidance.length).toBeGreaterThan(20);
    }
    expect(TONE_GUIDANCE.darker).toContain('withhold');
    expect(TONE_GUIDANCE['more-plain']).toContain('shorter words');
  });

  it('compiles direction text for empty directions', () => {
    const text = directionText(DEFAULT_TURN);
    expect(text).toContain('150–400 words');
    expect(text).not.toContain('ENDING');
  });

  it('keeps the system prompt stable in spirit', () => {
    expect(SYSTEM_PROMPT).toContain('exactly ONE page');
    expect(SYSTEM_PROMPT).toContain('Output ONLY the page text');
  });
});
