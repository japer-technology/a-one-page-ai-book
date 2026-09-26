/**
 * tests/regressions2.test.ts — one test per bug fixed in the second deep pass
 * (API management, logging/diagnostics, file management).
 */
import { describe, expect, it } from 'vitest';
import { normalizeBaseUrl, redactUrl, llmPorts, CANDIDATES } from '../src/llm/endpoints';
import {
  compileBook,
  toPlainText,
  toMarkdown,
  toDirectorCut,
  bookFileName,
} from '../src/core/compile';
import { epubBytes } from '../src/core/epub';
import { pdfBytes } from '../src/core/pdf';
import { defaultLibrary, normalizeLibrary } from '../src/core/schema';
import { redactedLibrary } from '../src/store/files';
import {
  makeBook,
  makeEndingNode,
  makePageNode,
  makeSeedNode,
  makeTitleNode,
  makeTurnNode,
  addNode,
} from '../src/core/tree';
import { DEFAULT_TURN } from '../src/core/types';
import type { Book, Library, StoryNode } from '../src/core/types';

/** seed → title → turn → page → ending, finished. */
function finishedBook(endingNote: string): {
  nodes: Record<string, StoryNode>;
  book: Book;
  lib: Library;
} {
  const seed = makeSeedNode('A keeper finds a letter.', {} as never);
  const title = makeTitleNode(seed.id, { title: 'The Dead Letter', tagline: '' });
  const turn = makeTurnNode(title.id, { ...DEFAULT_TURN, emotions: {} });
  const page = makePageNode(turn.id, { ...DEFAULT_TURN, emotions: {} }, 'm', 'Page text.');
  const ending = makeEndingNode(page.id, endingNote);
  let nodes: Record<string, StoryNode> = {};
  for (const node of [seed, title, turn, page, ending]) nodes = addNode(nodes, node);
  const book: Book = {
    ...makeBook(seed.id, title.id, 'm'),
    frontierId: ending.id,
    status: 'finished',
  };
  const lib: Library = { ...defaultLibrary(), books: [book], nodes, meta: { updatedAt: 1 } };
  return { nodes, book, lib };
}

describe('normalizeBaseUrl (API management)', () => {
  it('drops repeated/upper-case /v1 segments but keeps deeper paths', () => {
    expect(normalizeBaseUrl('http://h:1/v1/v1')).toBe('http://h:1');
    expect(normalizeBaseUrl('http://h:1/V1')).toBe('http://h:1');
    expect(normalizeBaseUrl('http://h:1/proxy/path/v1/')).toBe('http://h:1/proxy/path');
  });

  it('redactUrl strips userinfo and query for logs', () => {
    expect(redactUrl('http://user:pass@10.0.0.9:1234/v1')).toBe('http://10.0.0.9:1234');
    expect(redactUrl('http://h:1/?key=abc')).toBe('http://h:1');
  });

  it('llmPorts never emits port 0 for a portless entry', () => {
    expect(CANDIDATES.every((c) => new URL(c.baseUrl).port !== '')).toBe(true);
    expect(llmPorts().every((p) => p > 0 && p < 65536)).toBe(true);
  });
});

describe('ending note in exports', () => {
  it('keeps the reader’s closing note in txt/md/director’s cut', () => {
    const { nodes, book } = finishedBook('CLOSING-NOTE-MARKER-12345');
    const compiled = compileBook(nodes, book);
    expect(compiled.endingNote).toBe('CLOSING-NOTE-MARKER-12345');
    expect(toPlainText(compiled)).toContain('CLOSING-NOTE-MARKER-12345');
    expect(toMarkdown(compiled)).toContain('CLOSING-NOTE-MARKER-12345');
    expect(toDirectorCut(compiled)).toContain('CLOSING-NOTE-MARKER-12345');
  });

  it('keeps the closing note in EPUB and PDF', () => {
    const { nodes, book } = finishedBook('CLOSING-NOTE-MARKER-12345');
    const compiled = compileBook(nodes, book);
    const epub = new TextDecoder().decode(epubBytes(compiled));
    expect(epub).toContain('ending.xhtml');
    expect(epub).toContain('CLOSING-NOTE-MARKER-12345');
    // PDF streams are latin1-encoded text operators; the note's words survive.
    const pdf = new TextDecoder('latin1').decode(pdfBytes(compiled));
    expect(pdf).toContain('CLOSING-NOTE-MARKER-12345');
  });
});

describe('export filenames', () => {
  it('disambiguate same-titled books with the book id', () => {
    const a = { ...compileBook(...finishArgs('Same Title', 'book-aaaaaaaa')), id: 'book-aaaaaaaa' };
    const b = { ...compileBook(...finishArgs('Same Title', 'book-bbbbbbbb')), id: 'book-bbbbbbbb' };
    expect(bookFileName(a, 'md')).not.toBe(bookFileName(b, 'md'));
    expect(bookFileName(a, 'md')).toBe('same-title-book-aaa.md');
  });

  function finishArgs(title: string, id: string) {
    const seed = makeSeedNode('s', {} as never);
    const t = makeTitleNode(seed.id, { title, tagline: '' });
    const turn = makeTurnNode(t.id, { ...DEFAULT_TURN, emotions: {} });
    const page = makePageNode(turn.id, { ...DEFAULT_TURN, emotions: {} }, 'm', 'text');
    let nodes: Record<string, StoryNode> = {};
    for (const n of [seed, t, turn, page]) nodes = addNode(nodes, n);
    const book = { ...makeBook(seed.id, t.id, 'm'), frontierId: page.id, id };
    return [nodes, book] as [Record<string, StoryNode>, Book];
  }
});

describe('portable library export redaction', () => {
  it('strips the API key and credentialed URL from the exported document', () => {
    const { lib } = finishedBook('note');
    lib.settings.endpoint = {
      name: 'x',
      baseUrl: 'http://user:urlpassword@10.0.0.9:1234',
      vendor: 'openai-compat',
      model: 'm',
      temperature: 0.9,
      apiKey: 'sk-SUPER-SECRET',
    };
    const exported = JSON.stringify(redactedLibrary(lib));
    expect(exported).not.toContain('sk-SUPER-SECRET');
    expect(exported).not.toContain('urlpassword');
    expect(exported).toContain('http://10.0.0.9:1234');
    // The books themselves survive.
    expect(exported).toContain('The Dead Letter');
  });

  it('imports with a meta revision', () => {
    const { lib } = finishedBook('note');
    const normalized = normalizeLibrary(JSON.parse(JSON.stringify(lib)));
    expect(normalized.meta.updatedAt).toBe(1);
  });
});

describe('library document revision', () => {
  it('normalize defaults the meta stamp for pre-revision documents', () => {
    const raw = {
      schemaVersion: 1,
      books: [],
      nodes: {},
      settings: {},
    };
    expect(normalizeLibrary(raw).meta.updatedAt).toBe(0);
  });
});
