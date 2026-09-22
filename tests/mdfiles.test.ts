import { describe, expect, it } from 'vitest';
import { mdLibraryEntries } from '../src/core/mdfiles';
import { defaultLibrary } from '../src/core/schema';
import { finishBook, makeBook, makePageNode, makeSeedNode, makeTitleNode } from '../src/core/tree';
import { emptySeedOptions } from '../src/core/schema';
import { DEFAULT_TURN } from '../src/core/types';

describe('mdLibraryEntries', () => {
  it('produces a readable .md folder: README, index, one file per book', () => {
    const lib = defaultLibrary();
    const seed = makeSeedNode('A lighthouse keeper finds a letter.', emptySeedOptions());
    const title = makeTitleNode(seed.id, { title: 'The Dead Letter', tagline: 'salt and secrets' });
    const page = makePageNode(
      title.id,
      { ...DEFAULT_TURN, emotions: { dread: 2 } },
      'm',
      'The fog rolled in.\n\nShe turned the letter over.',
    );
    const book = finishBook(makeBook(seed.id, title.id, 'm'), page.id);
    book.tags = ['gothic'];
    lib.nodes = { [seed.id]: seed, [title.id]: title, [page.id]: page };
    lib.books = [book];
    const entries = mdLibraryEntries(lib);
    const names = entries.map((e) => e.name);
    expect(names).toContain('README.md');
    expect(names).toContain('index.md');
    const bookFile = entries.find((e) => e.name.startsWith('books/'));
    expect(bookFile).toBeDefined();
    expect(bookFile?.content).toContain('# The Dead Letter');
    expect(bookFile?.content).toContain('The fog rolled in.');
    expect(bookFile?.content).toContain('- Tags: gothic');
    expect(bookFile?.content).toContain('Mood map');
    expect(entries.find((e) => e.name === 'index.md')?.content).toContain('**The Dead Letter**');
  });
});
