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

  it('treats JSON that parsed as the answer, even when it wraps nothing', () => {
    // `{"suggestions": []}` used to fall through to the line salvage and come
    // back as one bogus idea reading the raw JSON — and in the conflict path
    // that same fallback displayed `{"conflicts":[]}` as a continuity
    // contradiction.
    expect(parseStringList('{"suggestions": []}')).toEqual([]);
    expect(parseStringList('{"conflicts": []}')).toEqual([]);
    expect(parseStringList('{"error": "cannot help with that"}')).toEqual([]);
  });

  it('never offers a refusal as an idea', () => {
    // The apostrophe forms of the refusal clause ("I'm not able…") were
    // unreachable, so exactly the phrasings a small model writes came through
    // as seed ideas and suggestions.
    expect(parseStringList("I'm not able to write this page.")).toEqual([]);
    expect(parseStringList("I'm unable to write that.")).toEqual([]);
    expect(parseStringList("I'm sorry, I don't feel comfortable writing that.")).toEqual([]);
    expect(parseStringList('I must decline to write this content.')).toEqual([]);
    expect(parseStringList('I cannot fulfill this request.')).toEqual([]);
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

  it('treats JSON that parsed as the answer, even when it holds no titles', () => {
    // Re-reading the JSON text as a line list split `{"titles` at its colon and
    // offered the reader a title card reading `{"titles` — which the book, its
    // filename and its EPUB metadata would then be named after.
    expect(parseTitleOptions('{"titles": []}')).toEqual([]);
    expect(parseTitleOptions('```json\n{"titles": []}\n```')).toEqual([]);
  });

  it('accepts the single {title, tagline} object a small model returns', () => {
    expect(
      parseTitleOptions('{"title": "The Dead Letter", "tagline": "salt and secrets"}'),
    ).toEqual([{ title: 'The Dead Letter', tagline: 'salt and secrets' }]);
  });

  it('drops refusals returned in the JSON shape too', () => {
    // The refusal filter was only applied to line-salvaged lists — the same
    // sentence inside the asked-for JSON became a pickable title card.
    expect(
      parseTitleOptions('[{"title": "I cannot help with that request.", "tagline": ""}]'),
    ).toEqual([]);
  });

  it('keeps titles that merely begin with an apology or a refusal-shaped phrase', () => {
    // The filter's over-match dropped these: any line starting "I'm sorry"
    // followed by "but", or any "I apology…" line, was silently discarded from
    // the salvage path while the same title survived in JSON.
    expect(parseTitleOptions("I'm Sorry, But I Love You — a rom-com")).toEqual([
      { title: "I'm Sorry, But I Love You", tagline: 'a rom-com' },
    ]);
    expect(parseTitleOptions('I Cannot Help Falling in Love')).toEqual([
      { title: 'I Cannot Help Falling in Love', tagline: '' },
    ]);
    expect(parseTitleOptions('I Apologize in Advance — a confession')).toEqual([
      { title: 'I Apologize in Advance', tagline: 'a confession' },
    ]);
  });
});

describe('parseBible', () => {
  it('parses a clean cast object with relations and summary', () => {
    const bible = parseBible(
      '{"people":[{"name":"Elin","note":"the keeper"}],"places":[{"name":"the lighthouse","note":"crumbling"}],"things":[{"name":"the letter","note":"sealed with wax"}],"relations":[{"from":"Elin","to":"Mara","kind":"sisters"}],"summary":"A keeper finds a letter."}',
      null,
    );
    expect(bible.people).toEqual([{ name: 'Elin', note: 'the keeper' }]);
    expect(bible.places[0]?.name).toBe('the lighthouse');
    expect(bible.things[0]?.note).toContain('wax');
    expect(bible.relations).toEqual([{ from: 'Elin', to: 'Mara', kind: 'sisters' }]);
    expect(bible.summary).toBe('A keeper finds a letter.');
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

  it('never truncates reader-added entries even when the group is over its cap', () => {
    // The reader can add a 13th person (the panel has no cap of its own); the
    // merge used to slice the combined list back to the cap from the TAIL —
    // exactly where the reader's newest entry sat, so the next background
    // update deleted it.
    const people = Array.from({ length: 12 }, (_, i) => ({ name: `Person ${i + 1}`, note: '' }));
    people.push({ name: 'Hermes QA Ghost', note: 'added by the reader' });
    const previous = {
      people,
      places: [],
      things: [],
      threads: [],
      relations: [],
      summary: '',
      at: 1,
      updatedAt: 1,
    };
    const reply = JSON.stringify({
      people: Array.from({ length: 12 }, (_, i) => ({
        name: `Person ${i + 1}`,
        note: 'refreshed',
      })),
    });
    const bible = parseBible(reply, previous);
    expect(bible.people.map((p) => p.name)).toContain('Hermes QA Ghost');
    expect(bible.people.find((p) => p.name === 'Person 1')?.note).toBe('refreshed');
    // …and a reply that omits the whole group must not truncate it either.
    const omitted = parseBible(JSON.stringify({ places: [] }), previous);
    expect(omitted.people.map((p) => p.name)).toContain('Hermes QA Ghost');
  });

  it('falls back to the previous cast instead of throwing on garbage', () => {
    const previous = {
      people: [{ name: 'Elin', note: 'the keeper' }],
      places: [],
      things: [],
      threads: [],
      relations: [],
      summary: '',
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
      relations: [],
      summary: '',
      at: 1,
      updatedAt: 1,
    };
    const bible = parseBible('{"people": [], "places": [], "things": []}', previous);
    expect(bible.people[0]?.name).toBe('Elin');
    expect(bible.places[0]?.name).toBe('the island');
  });
});

describe('parseBible keeps the reader\u2019s curation', () => {
  it('keeps a previous entry the model did not mention', () => {
    const previous = {
      people: [
        { name: 'Elin Marr', note: 'the keeper' },
        { name: 'QA Ghost', note: 'added by the reader' },
      ],
      places: [],
      things: [],
      threads: [],
      relations: [],
      summary: '',
    } as never;
    const next = parseBible('{"people":[{"name":"Elin Marr","note":"rewritten note"}]}', previous);
    expect(next.people.map((p) => p.name)).toEqual(['Elin Marr', 'QA Ghost']);
    expect(next.people[0]?.note).toBe('rewritten note');
  });

  it('matches names case-insensitively so a rename is not duplicated', () => {
    const previous = {
      people: [{ name: 'Elin Marr', note: '' }],
      places: [],
      things: [],
      threads: [],
      relations: [],
      summary: '',
    } as never;
    const next = parseBible(
      '{"people":[{"name":"elin marr","note":"lowercase from the model"}]}',
      previous,
    );
    expect(next.people).toHaveLength(1);
  });
});

describe('refusal and JSON-fragment salvage', () => {
  it('still line-salvages when the JSON is only a fragment of the reply', () => {
    // parseJSONLoose also finds balanced slices inside prose; a reply that
    // mixes prose with a list-less object must still reach the line salvage —
    // an early return used to drop the real verdict/ideas that followed.
    const mixed = parseStringList(
      '{"conflicts": []}\nThe gun was destroyed on page 2 — using it now is inconsistent with that.',
    );
    expect(mixed).toContain(
      'The gun was destroyed on page 2 — using it now is inconsistent with that.',
    );
    const ideas = parseStringList('Here are ideas: {"count": 0}\n1. First idea\n2. Second idea');
    expect(ideas).toContain('First idea');
    expect(ideas).toContain('Second idea');
  });

  it('keeps a title whose refused action is followed by a bare pronoun', () => {
    // "I can't help it" et al. are titles, not refusals; the pronoun only
    // counts as a refusal target after help/assist ("I can't help YOU").
    const json = [
      { title: "I Can't Help It", tagline: '' },
      { title: 'I Cannot Do It', tagline: '' },
      { title: "I Won't Write You a Poem", tagline: '' },
    ];
    expect(parseTitleOptions(JSON.stringify(json)).map((t) => t.title)).toEqual([
      "I Can't Help It",
      'I Cannot Do It',
      "I Won't Write You a Poem",
    ]);
    // …while a refusal to help a person still drops.
    expect(
      parseTitleOptions('[{"title":"I cannot help you with that request.","tagline":""}]'),
    ).toEqual([]);
  });

  it('drops hedged refusals', () => {
    expect(parseStringList("I'm sorry, but I don't think I can help with that.")).toEqual([]);
    expect(parseStringList("I'm afraid I can't help with that.")).toEqual([]);
    expect(parseStringList("I won't be able to write this page.")).toEqual([]);
  });
});

describe('refusal detection — round-3 gaps', () => {
  const refusals = [
    "I don't feel comfortable with that request.",
    "I'm not comfortable with that.",
    'I am not comfortable with that.',
    "Unfortunately, I can't help with that.",
    "Apologies, but I can't write that.",
    'My apologies, I cannot help with that.',
    "I'm sorry. I can't help with that.",
    "Sorry. I can't help with that.",
    "I'm not going to be able to write this page.",
    "I'd rather not write about that.",
    'I refuse to write that scene.',
    "I couldn't possibly write that.",
    'I must decline this request.',
    'I cannot and will not write that.',
    "I can't in good conscience write that.",
    'I cannot help generate titles.',
    'I cannot write something like that.',
    'I cannot participate in this.',
    "I'm not at liberty to write that.",
  ];
  it.each(refusals)('drops %s', (line) => {
    expect(parseStringList(line)).toEqual([]);
  });

  const titles = [
    "I Can't Help It",
    'I Cannot Do It',
    "I Won't Write You a Poem",
    "I Can't Help the Way I Feel",
    "I Won't Write Your Name",
    'I Cannot Help Falling in Love',
    "I'm Sorry, But I Love You",
    'Sorry, Wrong Number',
    "I Can't Stand the Rain",
    "I Won't Back Down",
  ];
  it.each(titles)('keeps %s', (line) => {
    expect(parseStringList(line)).toEqual([line]);
  });

  it('does not split hyphenated titles on the hyphen', () => {
    expect(parseTitleOptions('1. The Man-Eating Plant\n2. Low Tide').map((t) => t.title)).toEqual([
      'The Man-Eating Plant',
      'Low Tide',
    ]);
    expect(
      parseTitleOptions('1. The Man-Eating Plant - a botanical horror').map((t) => t.title),
    ).toEqual(['The Man-Eating Plant']);
    expect(parseTitleOptions('Mr. Penumbra’s 24-Hour Bookstore').map((t) => t.title)).toEqual([
      'Mr. Penumbra’s 24-Hour Bookstore',
    ]);
  });

  it('keeps short period-terminated titles and parses curly-quoted arrays', () => {
    expect(parseTitleOptions('1. The Dead Letter.\n2. Low Tide.').map((t) => t.title)).toEqual([
      'The Dead Letter',
      'Low Tide',
    ]);
    expect(parseTitleOptions('[“The Dead Letter”, “Low Tide”]').map((t) => t.title)).toEqual([
      'The Dead Letter',
      'Low Tide',
    ]);
  });
});
