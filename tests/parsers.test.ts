import { describe, expect, it } from 'vitest';
import {
  parseBible,
  parseJSONLoose,
  parseStringList,
  parseTitleOptions,
  stripCodeFence,
} from '../src/core/parsers';

describe('stripCodeFence', () => {
  it('removes json fences', () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripCodeFence('```\nhello\n```')).toBe('hello');
    expect(stripCodeFence('plain')).toBe('plain');
  });
});

describe('parseJSONLoose', () => {
  it('parses clean json', () => {
    expect(parseJSONLoose<{ a: number }>('{"a": 1}')).toEqual({ a: 1 });
  });

  it('extracts json from surrounding prose', () => {
    const text = 'Here are your titles:\n```json\n["one", "two"]\n```\nEnjoy!';
    expect(parseJSONLoose<string[]>(text)).toEqual(['one', 'two']);
  });

  it('finds the first balanced object when prose wraps it', () => {
    const text = 'Sure! {"title": "X", "tagline": "Y"} — hope you like it.';
    expect(parseJSONLoose<{ title: string }>(text)).toEqual({ title: 'X', tagline: 'Y' });
  });

  it('repairs trailing commas — the classic small-model defect', () => {
    const text = '[{"title": "A", "tagline": "t"},{"title": "B", "tagline": ""},]';
    expect(parseJSONLoose<Array<{ title: string }>>(text)).toEqual([
      { title: 'A', tagline: 't' },
      { title: 'B', tagline: '' },
    ]);
    // A trailing comma inside a fenced, prose-wrapped array too.
    const wrapped = 'Sure! Here you go:\n```json\n{"items": [1, 2, 3,]}\n```\nEnjoy!';
    expect(parseJSONLoose<{ items: number[] }>(wrapped)).toEqual({ items: [1, 2, 3] });
  });

  it('throws on garbage', () => {
    expect(() => parseJSONLoose('not json at all')).toThrow();
  });
});

describe('parseStringList', () => {
  it('handles json arrays, wrapped arrays, and bullet lists', () => {
    expect(parseStringList('["a", "b"]')).toEqual(['a', 'b']);
    expect(parseStringList('{"titles": ["a", "b"]}')).toEqual(['a', 'b']);
    expect(parseStringList('- a\n- b')).toEqual(['a', 'b']);
  });
});

describe('parseTitleOptions', () => {
  it('parses title/tagline objects', () => {
    const parsed = parseTitleOptions('[{"title":"A","tagline":"t"},{"title":"B","tagline":""}]');
    expect(parsed).toEqual([
      { title: 'A', tagline: 't' },
      { title: 'B', tagline: '' },
    ]);
  });

  it('tolerates plain strings', () => {
    expect(parseTitleOptions('["A", "B"]')).toEqual([
      { title: 'A', tagline: '' },
      { title: 'B', tagline: '' },
    ]);
  });

  it('salvages numbered and bulleted lists when the model ignored the JSON instruction', () => {
    const numbered =
      'Here are five suggestions:\n\n1. "The Dead Letter" — A story of salt\n2. **Low Tide** — The sea keeps\n3. The Wax Seal: some letters wait\n4. Lantern Light';
    expect(parseTitleOptions(numbered)).toEqual([
      { title: 'The Dead Letter', tagline: 'A story of salt' },
      { title: 'Low Tide', tagline: 'The sea keeps' },
      { title: 'The Wax Seal', tagline: 'some letters wait' },
      { title: 'Lantern Light', tagline: '' },
    ]);
  });

  it('returns an empty list for prose with no titles in it', () => {
    expect(parseTitleOptions('I cannot help with that request.')).toEqual([]);
  });
});

describe('parseBible', () => {
  it('parses a clean cast object', () => {
    const bible = parseBible(
      '{"people":[{"name":"Elin","note":"the keeper"}],"places":[{"name":"the lighthouse","note":"crumbling"}],"things":[{"name":"the letter","note":"sealed with wax"}]}',
      null,
    );
    expect(bible.people).toEqual([{ name: 'Elin', note: 'the keeper' }]);
    expect(bible.places[0]?.name).toBe('the lighthouse');
    expect(bible.things[0]?.note).toContain('wax');
  });

  it('tolerates fences, prose wrappers and string entries', () => {
    const raw =
      'Sure! Here you go:\n```json\n{"cast": {"people": ["Elin", {"name": "Mara", "note": "the stranger"}], "places": [], "things": []}}\n```';
    const bible = parseBible(raw, null);
    expect(bible.people.map((p) => p.name)).toContain('Elin');
    expect(bible.people.map((p) => p.name)).toContain('Mara');
  });

  it('deduplicates names case-insensitively and caps counts', () => {
    const people = Array.from({ length: 20 }, (_, i) => ({ name: `P${i}`, note: '' }));
    people.push({ name: 'p0', note: 'dupe' });
    const raw = JSON.stringify({ people, places: [], things: [] });
    const bible = parseBible(raw, null);
    expect(bible.people.length).toBeLessThanOrEqual(12);
    expect(bible.people[0]?.note).toBe('');
  });

  it('falls back to the previous cast instead of throwing on garbage', () => {
    const previous = {
      people: [{ name: 'Elin', note: 'the keeper' }],
      places: [],
      things: [],
      threads: [],
      at: 2,
      updatedAt: 1,
    };
    const bible = parseBible('I cannot help with that request.', previous);
    expect(bible.people[0]?.name).toBe('Elin');
  });

  it('never regresses a group to empty when the model drops it', () => {
    const previous = {
      people: [{ name: 'Elin', note: 'the keeper' }],
      places: [{ name: 'the island', note: '' }],
      things: [],
      threads: [],
      at: 1,
      updatedAt: 1,
    };
    const bible = parseBible('{"people": [], "places": [], "things": []}', previous);
    expect(bible.people[0]?.name).toBe('Elin');
    expect(bible.places[0]?.name).toBe('the island');
  });
});
