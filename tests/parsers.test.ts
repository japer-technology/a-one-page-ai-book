import { describe, expect, it } from 'vitest';
import {
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
});
