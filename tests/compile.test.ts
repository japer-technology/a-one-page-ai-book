import { describe, expect, it } from 'vitest';
import {
  compileBook,
  countWords,
  joinParagraphs,
  moodLine,
  moodOf,
  paragraphsOf,
  slugify,
  toDirectorCut,
  toMarkdown,
  toPlainText,
} from '../src/core/compile';
import {
  attachBible,
  finishBook,
  makeBook,
  makePageNode,
  makePrologueNode,
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

describe('paragraph helpers', () => {
  it('splits on blank lines and rejoins losslessly', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\nThird line.\n\n\nFourth.';
    const paras = paragraphsOf(text);
    expect(paras).toEqual(['First paragraph.', 'Second paragraph.\nThird line.', 'Fourth.']);
    expect(joinParagraphs(paras)).toBe(
      'First paragraph.\n\nSecond paragraph.\nThird line.\n\nFourth.',
    );
  });

  it('treats a single block as one paragraph', () => {
    expect(paragraphsOf('One block.')).toEqual(['One block.']);
  });
});

describe('cast in exports', () => {
  it('appends the cast appendix to markdown and plain text when present', () => {
    const { nodes, book, page1 } = bookFixture();
    const bible = {
      people: [{ name: 'Elin', note: 'the keeper' }],
      places: [],
      things: [],
      threads: [],
      relations: [],
      summary: '',
      at: 1,
      updatedAt: 1,
    };
    const paged = attachBible(page1, bible);
    const compiled = compileBook({ ...nodes, [page1.id]: paged }, book);
    expect(compiled.cast?.people[0]?.name).toBe('Elin');
    expect(toMarkdown(compiled)).toContain('## The cast');
    expect(toMarkdown(compiled)).toContain('**Elin** — the keeper');
    expect(toPlainText(compiled)).toContain('THE CAST');
  });

  it('omits the cast appendix when there is none', () => {
    const { nodes, book } = bookFixture();
    const compiled = compileBook(nodes, book);
    expect(toMarkdown(compiled)).not.toContain('The cast');
  });
});

describe('mood map', () => {
  it('derives the dominant emotion dial per page', () => {
    expect(moodOf({ ...DEFAULT_TURN, emotions: { dread: 2, joy: 1 } })).toEqual({
      icon: '🕳️',
      label: 'dread',
      value: 2,
    });
    expect(moodOf({ ...DEFAULT_TURN, emotions: { joy: -2 } })?.label).toBe('joy');
    expect(moodOf(DEFAULT_TURN)).toBeNull();
  });

  it('prints the mood map line in exports', () => {
    const { nodes, book, page1 } = bookFixture();
    const directed = {
      ...page1,
      data: { ...page1.data, direction: { ...DEFAULT_TURN, emotions: { dread: 2 } } },
    };
    const compiled = compileBook({ ...nodes, [page1.id]: directed }, book);
    expect(moodLine(compiled)).toContain('Mood map');
    expect(moodLine(compiled)).toContain('🕳️');
    expect(toMarkdown(compiled)).toContain('Mood map');
  });
});

describe('prologue and commentary edition', () => {
  it('compiles the prologue as page zero, before page one', () => {
    const { nodes, book } = bookFixture();
    const prologue = makePrologueNode(
      book.chosenTitleId,
      DEFAULT_TURN,
      'm',
      'It began long before the letter.',
    );
    const compiled = compileBook({ ...nodes, [prologue.id]: prologue }, book);
    expect(compiled.pages[0]?.kind).toBe('prologue');
    expect(compiled.pages[0]?.text).toContain('long before');
    expect(compiled.pages[1]?.number).toBe(1);
    expect(moodLine(compiled)).not.toContain('0');
  });

  it('interleaves directions into the director’s cut', () => {
    const { nodes, book } = bookFixture();
    const compiled = compileBook(nodes, book);
    const cut = toDirectorCut(compiled);
    expect(cut).toContain("Director's Commentary");
    expect(cut).toContain('Directed:');
  });
});
