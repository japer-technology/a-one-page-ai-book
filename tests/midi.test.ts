import { describe, expect, it } from 'vitest';
import { midiBytes, scoreNotes } from '../src/core/midi';
import type { CompiledBook } from '../src/core/compile';

function book(): CompiledBook {
  return {
    title: 'T',
    seed: 's',
    words: 4,
    endingNote: '',
    pages: [
      { number: 1, text: 'a', words: 1, mood: { icon: '🕳️', label: 'dread', value: 2 } },
      { number: 2, text: 'b', words: 1, mood: { icon: '☀️', label: 'joy', value: 1 } },
      { number: 3, text: 'c', words: 1 },
    ],
  };
}

describe('scoreNotes', () => {
  it('maps moods to pitched notes with velocity', () => {
    const notes = scoreNotes(book());
    expect(notes).toHaveLength(2);
    expect(notes[0]!.label).toContain('dread +2');
    expect(notes[0]!.note).toBeLessThan(notes[1]!.note); // dread low, joy high
    expect(notes[1]!.velocity).toBeGreaterThan(60);
  });
});

describe('midiBytes', () => {
  it('emits a format-0 MIDI file with note events', () => {
    const bytes = midiBytes(book());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('MThd');
    expect(view.getUint16(8, false)).toBe(0);
    expect(view.getUint16(10, false)).toBe(1); // one track
    expect(String.fromCharCode(...bytes.subarray(14, 18))).toBe('MTrk');
    // note-on event (0x90) present
    let hasNoteOn = false;
    let hasEOT = false;
    for (let i = 18; i < bytes.length; i++) {
      if (bytes[i] === 0x90) hasNoteOn = true;
      if (bytes[i] === 0xff && bytes[i + 1] === 0x2f) hasEOT = true;
    }
    expect(hasNoteOn).toBe(true);
    expect(hasEOT).toBe(true);
  });
});
