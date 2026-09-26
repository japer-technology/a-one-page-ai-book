/**
 * tests/import-export.test.ts — the import/export edges that used to damage a
 * reader's file, a book's EPUB or a PDF's words. One test per fixed bug, each
 * named after the user-visible symptom.
 */
import { describe, expect, it } from 'vitest';
import { normalizeLibrary, defaultLibrary } from '../src/core/schema';
import { compileBook } from '../src/core/compile';
import {
  makeBook,
  makePageNode,
  makePrologueNode,
  makeSeedNode,
  makeTitleNode,
  addNode,
} from '../src/core/tree';
import { DEFAULT_TURN } from '../src/core/types';
import type { Book, Library, StoryNode } from '../src/core/types';
import { epubBytes } from '../src/core/epub';
import { cp1252, pdfBytes } from '../src/core/pdf';
import { bookFileName } from '../src/core/compile';

/** A seed → title → prologue → page tree, as a whole library document. */
function libraryWith(prologueVersions: unknown, titles?: unknown): Library {
  const base = defaultLibrary();
  const seed = makeSeedNode('A keeper finds a letter.', {} as never);
  const withTitles = titles === undefined ? seed : { ...seed, data: { ...seed.data, titles } };
  const title = makeTitleNode(seed.id, { title: 'The Dead Letter', tagline: '' });
  const prologueBase = makePrologueNode(
    title.id,
    { ...DEFAULT_TURN, emotions: {} },
    'm',
    'Prologue.',
  );
  const prologue: StoryNode =
    prologueVersions === undefined
      ? prologueBase
      : {
          ...prologueBase,
          data: { ...prologueBase.data, versions: prologueVersions, chosenVersion: 1 } as never,
        };
  const page = makePageNode(title.id, { ...DEFAULT_TURN, emotions: {} }, 'm', 'Page one.');
  let nodes: Record<string, StoryNode> = {};
  for (const node of [withTitles as StoryNode, title, prologue, page]) nodes = addNode(nodes, node);
  return {
    ...base,
    nodes,
    books: [makeBook(seed.id, title.id, 'm')],
  };
}

describe('a document with junk in it must still open', () => {
  it('drops a prologue version whose text is not a string instead of breaking the book', () => {
    // Symptom this protects: a prologue with `versions: [{text: 42}]` imported
    // cleanly, then `countWords` threw in compileBook — the reader, the ending
    // view and EVERY export for that book failed, with no way back.
    const doc = libraryWith([
      { v: 1, text: 42, by: 'ai', at: 0 },
      { v: 2, text: 'A real prologue.', by: 'ai', at: 0 },
    ]);
    const lib = normalizeLibrary(JSON.parse(JSON.stringify(doc)));
    const book = lib.books[0] as Book;
    const prologue = Object.values(lib.nodes).find((n) => n.kind === 'prologue');
    expect(
      prologue && prologue.data.kind === 'prologue'
        ? prologue.data.versions.map((v) => v.text)
        : null,
    ).toEqual(['A real prologue.']);
    expect(() => compileBook(lib.nodes, book)).not.toThrow();
    const compiled = compileBook(lib.nodes, book);
    expect(compiled.pages.some((p) => p.kind === 'prologue')).toBe(true);
  });

  it('refuses a prologue with no usable version rather than storing a broken node', () => {
    const doc = libraryWith(['not an object', { text: null }]);
    expect(() => normalizeLibrary(JSON.parse(JSON.stringify(doc)))).toThrow(/prologue/i);
  });

  it('filters junk out of a seed title list', () => {
    // Symptom this protects: `titles: [null]` passed validation, and the
    // library's search haystack (`t.title`) then threw for EVERY book — the
    // shelf never painted again.
    const doc = libraryWith(undefined, [null, 'nope', { title: 'Low Tide', tagline: 'the sea' }]);
    const lib = normalizeLibrary(JSON.parse(JSON.stringify(doc)));
    const seed = Object.values(lib.nodes).find((n) => n.kind === 'seed');
    expect(seed && seed.data.kind === 'seed' ? seed.data.titles : null).toEqual([
      { title: 'Low Tide', tagline: 'the sea' },
    ]);
  });
});

describe('EPUB metadata', () => {
  // Built ONCE: `makeBook` mints a fresh book id, and the EPUB identifier is
  // the book's own id (not a clock stamp), so re-exporting must not change it.
  const seed = makeSeedNode('s', {} as never);
  const title = makeTitleNode(seed.id, { title: 'T', tagline: '' });
  const page = makePageNode(title.id, { ...DEFAULT_TURN, emotions: {} }, 'm', 'Text.');
  let epubNodes: Record<string, StoryNode> = {};
  for (const node of [seed, title, page]) epubNodes = addNode(epubNodes, node);
  const epubBook: Book = { ...makeBook(seed.id, title.id, 'm'), frontierId: page.id };
  function epubFor(): string {
    return new TextDecoder().decode(epubBytes(compileBook(epubNodes, epubBook)));
  }

  it('writes a dcterms:modified without fractional seconds', () => {
    // EPUB 3 requires exactly YYYY-MM-DDThh:mm:ssZ; toISOString() always adds
    // milliseconds, which failed validation on EVERY export.
    const text = epubFor();
    const modified = /<meta property="dcterms:modified">([^<]+)<\/meta>/.exec(text)?.[1] ?? '';
    expect(modified).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('does not repeat the book id from the clock', () => {
    const first = epubFor();
    const second = epubFor();
    const idOf = (text: string) =>
      /<dc:identifier id="bookid">([^<]+)<\/dc:identifier>/.exec(text)?.[1] ?? '';
    expect(idOf(first)).not.toBe('');
    expect(idOf(first)).toBe(idOf(second));
  });
});

describe('PDF text encoding', () => {
  it('keeps the WinAnsi letters that used to be deleted mid-word', () => {
    // Symptom this protects: "cœur œuvre Škoda" printed as "cur uvre koda".
    const bytes = cp1252('cœur œuvre Škoda Ÿ Ž');
    const text = new TextDecoder('cp1252').decode(bytes);
    expect(text).toBe('cœur œuvre Škoda Ÿ Ž');
  });

  it('still drops what CP1252 genuinely cannot hold', () => {
    expect(new TextDecoder('latin1').decode(cp1252('emoji 🕳️ done'))).toBe('emoji  done');
  });

  it('puts The End before the cast appendix, like every other export', () => {
    const seed = makeSeedNode('s', {} as never);
    const title = makeTitleNode(seed.id, { title: 'T', tagline: '' });
    const page = makePageNode(title.id, { ...DEFAULT_TURN, emotions: {} }, 'm', 'Text.');
    let nodes: Record<string, StoryNode> = {};
    for (const node of [seed, title, page]) nodes = addNode(nodes, node);
    const book: Book = { ...makeBook(seed.id, title.id, 'm'), frontierId: page.id };
    const compiled = {
      ...compileBook(nodes, book),
      endingNote: 'Goodbye.',
      cast: {
        people: [{ name: 'Elin', note: 'keeper' }],
        places: [],
        things: [],
        threads: [],
        relations: [],
        summary: '',
        at: 1,
        updatedAt: 0,
      },
    };
    const text = new TextDecoder('latin1').decode(pdfBytes(compiled));
    const end = text.indexOf('The End');
    const cast = text.indexOf('The cast');
    expect(end).toBeGreaterThan(-1);
    expect(cast).toBeGreaterThan(-1);
    expect(end).toBeLessThan(cast);
  });
});

describe('export filenames', () => {
  it('names a book file with the book id, so same-titled books cannot collide', () => {
    const seed = makeSeedNode('s', {} as never);
    const title = makeTitleNode(seed.id, { title: 'Untitled', tagline: '' });
    const page = makePageNode(title.id, { ...DEFAULT_TURN, emotions: {} }, 'm', 'Text.');
    let nodes: Record<string, StoryNode> = {};
    for (const node of [seed, title, page]) nodes = addNode(nodes, node);
    const book: Book = { ...makeBook(seed.id, title.id, 'm'), frontierId: page.id };
    const compiled = compileBook(nodes, book);
    expect(bookFileName(compiled, 'md')).toContain(compiled.id.slice(0, 8));
  });
});
