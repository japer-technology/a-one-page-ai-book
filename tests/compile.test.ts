import { describe, expect, it } from 'vitest';
import { compileBook, countWords, slugify, toMarkdown, toPlainText } from '../src/core/compile';
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

function bookFixture() {
  const seed = makeSeedNode('The seed sentence.', emptySeedOptions());
  const title = makeTitleNode(seed.id, {
    title: "The Lighthouse Keeper's Grandson",
    tagline: 'A story of salt and secrets',
  });
  const page1 = makePageNode(title.id, DEFAULT_TURN, 'm', 'First page.\nIt has two lines.');
  const turn = makeTurnNode(page1.id, DEFAULT_TURN);
  const page2 = makePageNode(
    turn.id,
    { ...DEFAULT_TURN, ending: true },
    'm',
    'Final page. The end.',
  );
  const nodes = {
    [seed.id]: seed,
    [title.id]: title,
    [page1.id]: page1,
    [turn.id]: turn,
    [page2.id]: page2,
  };
  const book = finishBook(makeBook(seed.id, title.id, 'm'), page2.id);
  return { nodes, book, page1, page2 };
}

describe('countWords', () => {
  it('counts whitespace-separated words', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('one two three')).toBe(3);
    expect(countWords('  spaced   out  ')).toBe(2);
  });
});

describe('slugify', () => {
  it('produces file-safe slugs', () => {
    expect(slugify("The Lighthouse Keeper's Grandson")).toBe('the-lighthouse-keepers-grandson');
    expect(slugify('!!!')).toBe('untitled-book');
  });
});

describe('compileBook', () => {
  it('compiles the chosen path in order with correct page numbers', () => {
    const { nodes, book } = bookFixture();
    const compiled = compileBook(nodes, book);
    expect(compiled.title).toBe("The Lighthouse Keeper's Grandson");
    expect(compiled.seed).toBe('The seed sentence.');
    expect(compiled.pages.map((p) => p.number)).toEqual([1, 2]);
    expect(compiled.pages[0]?.text).toBe('First page.\nIt has two lines.');
    expect(compiled.words).toBeGreaterThan(0);
  });

  it('exports plain text with the title and seed footer', () => {
    const { nodes, book } = bookFixture();
    const text = toPlainText(compileBook(nodes, book));
    expect(text).toContain("The Lighthouse Keeper's Grandson");
    expect(text).toContain('Final page. The end.');
    expect(text).toContain('Page Turn');
  });

  it('exports markdown', () => {
    const { nodes, book } = bookFixture();
    const md = toMarkdown(compileBook(nodes, book));
    expect(md).toContain("# The Lighthouse Keeper's Grandson");
    expect(md).toContain('> The seed sentence.');
  });
});
