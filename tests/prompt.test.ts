import { describe, expect, it } from 'vitest';
import {
  bibleMessages,
  briefMessages,
  buildContext,
  buildContextTo,
  chatMessages,
  directionText,
  endingsMessages,
  insertParagraphMessages,
  pageMessages,
  paragraphMessages,
  rewriteSpanMessages,
  STRUCTURED_SYSTEM_PROMPT,
  SUMMARY_SYSTEM_PROMPT,
  suggestionsMessages,
  summaryMessages,
  summaryText,
  SYSTEM_PROMPT,
  titlesMessages,
  TONE_GUIDANCE,
} from '../src/core/prompt';
import {
  attachSummary,
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
  it('produces title messages that ask for bare JSON with an example', () => {
    const messages = titlesMessages('seed text', { ...emptySeedOptions(), genre: 'noir' }, 5);
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toBe(STRUCTURED_SYSTEM_PROMPT);
    expect(messages[1]?.content).toContain('seed text');
    expect(messages[1]?.content).toContain('genre: noir');
    expect(messages[1]?.content).toContain('JSON array of 5 objects');
    expect(messages[1]?.content).toContain('{"title": "The Dead Letter"');
  });

  it('keeps the structured phases on the JSON-only system prompt', () => {
    const ctx = { seed: 's', title: 't', pages: ['p1'], lastDirection: null };
    expect(suggestionsMessages(ctx, 3)[0]?.content).toBe(STRUCTURED_SYSTEM_PROMPT);
    expect(endingsMessages(ctx, 3)[0]?.content).toBe(STRUCTURED_SYSTEM_PROMPT);
    expect(STRUCTURED_SYSTEM_PROMPT).not.toContain('Output ONLY the page text');
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

describe('emotion dials, rules and chapters', () => {
  it('compiles emotion dials into calibrated structural instructions', () => {
    const text = directionText({
      ...DEFAULT_TURN,
      emotions: { dread: 2, joy: -1, wonder: 3 },
    });
    expect(text).toContain('Dread: clearly');
    expect(text).toContain('creeping unease');
    expect(text).toContain('Joy: slightly');
    expect(text).toContain('Dim the joy');
    expect(text).toContain('Wonder: strongly');
    expect(text).toContain('opens the world wider');
  });

  it('zero dials are silent and invalid names are skipped', () => {
    const text = directionText({ ...DEFAULT_TURN, emotions: { dread: 0, nonsense: 3 } as never });
    expect(text).not.toContain('Dread');
    expect(text).not.toContain('nonsense');
  });

  it('injects chapter break and chapter close guidance', () => {
    expect(directionText({ ...DEFAULT_TURN, chapter: 'start' })).toContain('CHAPTER BREAK');
    expect(directionText({ ...DEFAULT_TURN, chapter: 'close' })).toContain(
      'BRING THIS CHAPTER TO A CLOSE',
    );
    expect(directionText(DEFAULT_TURN)).not.toContain('CHAPTER');
  });

  it('injects standing rules into page messages', () => {
    const ctx = { seed: 's', title: 't', pages: ['p1'], lastDirection: null };
    const messages = pageMessages(ctx, DEFAULT_TURN, 2, ['Don’t reveal the letter yet']);
    expect(messages[1]?.content).toContain('STANDING RULES');
    expect(messages[1]?.content).toContain('Don’t reveal the letter yet');
    const without = pageMessages(ctx, DEFAULT_TURN, 2, []);
    expect(without[1]?.content).not.toContain('STANDING RULES');
  });

  it('builds paragraph rewrite and insert messages around the page text', () => {
    const ctx = { seed: 's', title: 't', pages: ['p1'], lastDirection: null };
    const rewrite = paragraphMessages(
      ctx,
      3,
      'first para\n\nsecond para',
      'second para',
      'make it colder',
      ['stay past tense'],
    );
    expect(rewrite[0]?.content).toContain('SINGLE paragraph');
    expect(rewrite[1]?.content).toContain('second para');
    expect(rewrite[1]?.content).toContain('make it colder');
    expect(rewrite[1]?.content).toContain('stay past tense');
    const insert = insertParagraphMessages(ctx, 3, 'first para', 'a memory of the storm');
    expect(insert[1]?.content).toContain('a memory of the storm');
    expect(insert[1]?.content).toContain('Output ONLY the new paragraph');
  });

  it('asks the bible update for a bare JSON cast object', () => {
    const ctx = { seed: 's', title: 't', pages: ['p1'], lastDirection: null };
    const messages = bibleMessages(ctx, null);
    expect(messages[0]?.content).toBe(STRUCTURED_SYSTEM_PROMPT);
    expect(messages[1]?.content).toContain('"people"');
    expect(messages[1]?.content).toContain('"places"');
    expect(messages[1]?.content).toContain('"things"');
    expect(messages[1]?.content).toContain('Output ONLY the JSON object');
  });
});

describe('size targets, briefs and threads', () => {
  it('compiles precise size targets into calibrated instructions', () => {
    const words = directionText({ ...DEFAULT_TURN, sizeTarget: { kind: 'words', value: 320 } });
    expect(words).toContain('about 320 words');
    expect(words).not.toContain('150–400');
    const paragraphs = directionText({
      ...DEFAULT_TURN,
      sizeTarget: { kind: 'paragraphs', value: 3 },
    });
    expect(paragraphs).toContain('exactly 3 paragraphs');
    const chars = directionText({ ...DEFAULT_TURN, sizeTarget: { kind: 'chars', value: 1400 } });
    expect(chars).toContain('about 1400 characters');
  });

  it('injects the brief and cast into page prompts', () => {
    const ctx = {
      seed: 's',
      title: 't',
      pages: ['p1'],
      lastDirection: null,
      brief: 'A quiet gothic mystery.',
      cast: {
        people: [{ name: 'Elin', note: 'the keeper' }],
        places: [],
        things: [],
        threads: [{ name: "the letter's sender", note: 'unknown' }],
        at: 1,
        updatedAt: 1,
      },
    };
    const messages = pageMessages(ctx, DEFAULT_TURN, 2);
    expect(messages[1]?.content).toContain('THE BRIEF');
    expect(messages[1]?.content).toContain('A quiet gothic mystery.');
    expect(messages[1]?.content).toContain('THE CAST');
    expect(messages[1]?.content).toContain('Elin');
    expect(messages[1]?.content).toContain("the letter's sender");
  });

  it('injects the brief into title proposals', () => {
    const messages = titlesMessages('seed', emptySeedOptions(), 5, 'A quiet gothic mystery.');
    expect(messages[1]?.content).toContain('THE BRIEF');
  });

  it('asks the bible update for threads', () => {
    const ctx = { seed: 's', title: 't', pages: ['p1'], lastDirection: null };
    expect(bibleMessages(ctx, null)[1]?.content).toContain('"threads"');
    expect(bibleMessages(ctx, null)[1]?.content).toContain('open questions');
  });

  it('compiles diegetic document guidance', () => {
    const text = directionText({ ...DEFAULT_TURN, document: 'letter' });
    expect(text).toContain('diegetic LETTER');
    expect(text).toContain('salutation');
    expect(directionText({ ...DEFAULT_TURN, document: 'recipe' })).toContain('ingredients list');
    expect(directionText(DEFAULT_TURN)).not.toContain('DOCUMENT');
  });

  it('builds chat messages with the writing-partner system prompt', () => {
    const messages = chatMessages([{ role: 'user', content: 'hi' }]);
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('writing-partner');
    expect(messages[1]?.content).toBe('hi');
    const brief = briefMessages([{ role: 'user', content: 'a lighthouse book' }]);
    expect(brief[1]?.content).toContain('story brief');
  });
});

describe('span rewriting', () => {
  it('builds rewrite-span messages around the exact selection', () => {
    const ctx = { seed: 's', title: 't', pages: ['p1'], lastDirection: null };
    const messages = rewriteSpanMessages(
      ctx,
      3,
      'The fog rolled in and the light failed.',
      'the light failed',
      'make it ominous',
      ['stay past tense'],
    );
    expect(messages[1]?.content).toContain('EXACT SPAN');
    expect(messages[1]?.content).toContain('the light failed');
    expect(messages[1]?.content).toContain('make it ominous');
    expect(messages[1]?.content).toContain('stay past tense');
    expect(messages[1]?.content).toContain('Output ONLY the rewritten span');
  });
});

describe('rolling story summary', () => {
  it('surfaces the summary carried along the path in the context', () => {
    const { nodes, book } = fixture(3);
    const last = Object.values(nodes)
      .filter((n) => n.kind === 'page')
      .at(-1);
    if (!last) throw new Error('no pages');
    const withSummary = {
      ...nodes,
      [last.id]: attachSummary(last, 'The keeper finds a letter; a storm gathers.'),
    };
    const ctx = buildContextTo(withSummary, book, last.id);
    expect(ctx.summary).toBe('The keeper finds a letter; a storm gathers.');
  });

  it('sizes the fixed blocks first and gives the verbatim pages the remainder', () => {
    const { nodes, book } = fixture(12);
    const pages = Object.values(nodes)
      .filter((n) => n.kind === 'page')
      .sort((a, b) => a.createdAt - b.createdAt);
    const last = pages.at(-1);
    if (!last) throw new Error('no pages');
    const huge = 'word '.repeat(3000);
    const withSummary = { ...nodes, [last.id]: attachSummary(last, huge) };
    const ctx = buildContextTo(withSummary, book, last.id);
    expect(ctx.summary).toBe(huge);
    const words = ctx.pages.reduce((sum, p) => sum + p.split(/\s+/).length, 0);
    // A giant summary eats the budget; the recent pages keep the floor.
    expect(words).toBeLessThanOrEqual(500);
    expect(ctx.pages.length).toBeGreaterThan(0);
  });

  it('injects the summary block into page, suggestion and ending prompts', () => {
    const withSummary = {
      seed: 's',
      title: 't',
      pages: ['p1'],
      lastDirection: null,
      summary: 'Everything so far.',
    };
    expect(pageMessages(withSummary, DEFAULT_TURN, 2)[1]?.content).toContain(
      'STORY SO FAR (SUMMARY',
    );
    expect(pageMessages(withSummary, DEFAULT_TURN, 2)[1]?.content).toContain('Everything so far.');
    expect(suggestionsMessages(withSummary, 3)[1]?.content).toContain('STORY SO FAR (SUMMARY');
    expect(endingsMessages(withSummary, 3)[1]?.content).toContain('STORY SO FAR (SUMMARY');
    const without = { seed: 's', title: 't', pages: ['p1'], lastDirection: null };
    expect(pageMessages(without, DEFAULT_TURN, 2)[1]?.content).not.toContain(
      'STORY SO FAR (SUMMARY',
    );
  });

  it('builds summary messages that fold the previous summary into the new one', () => {
    const ctx = { seed: 's', title: 't', pages: ['p1'], lastDirection: null };
    const first = summaryMessages(ctx, null);
    expect(first[0]?.content).toBe(SUMMARY_SYSTEM_PROMPT);
    expect(first[1]?.content).toContain('No summary yet');
    expect(first[1]?.content).toContain('STORY SO FAR (oldest first)');
    const next = summaryMessages(ctx, 'The keeper finds a letter.');
    expect(next[1]?.content).toContain('PREVIOUS SUMMARY');
    expect(next[1]?.content).toContain('The keeper finds a letter.');
  });

  it('never feeds the ctx summary back into its own update (no circularity)', () => {
    const ctx = { seed: 's', title: 't', pages: ['p1'], lastDirection: null, summary: 'OLD' };
    const user = summaryMessages(ctx, 'PREVIOUS')[1]?.content ?? '';
    expect(user).toContain('PREVIOUS SUMMARY');
    expect(user).not.toContain('STORY SO FAR (SUMMARY');
  });

  it('formats summaryText as the long-term memory block', () => {
    expect(summaryText(undefined)).toBe('');
    expect(summaryText('   ')).toBe('');
    expect(summaryText('X happened.')).toContain('STORY SO FAR (SUMMARY');
    expect(summaryText('X happened.')).toContain('X happened.');
  });
});
