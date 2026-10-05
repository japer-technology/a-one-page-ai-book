import { describe, expect, it } from 'vitest';
import { midiBytes, scoreNotes } from '../src/core/midi';
import type { CompiledBook } from '../src/core/compile';

function book(): CompiledBook {
  return {
    title: 'T',
    seed: 's',
    words: 4,
    id: 'b1',
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

  it('plays each note for as long as the score says it lasts', () => {
    // The file used to write 400 ticks (0.42 s at 120 bpm) while the score —
    // and the in-app player — declared 900 ms, so an exported score played
    // 2.16× faster than the preview it was exported from.
    const bytes = midiBytes(book());
    const ticksPerQuarter = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).getUint16(12, false);
    const tempoUs = 500000; // the tempo event the file writes
    // Read the delta-time VLQ before the first note-off (0x80).
    let i = 18;
    let noteOffTicks = 0;
    while (i < bytes.length) {
      let value = 0;
      let byte = 0;
      do {
        byte = bytes[i++] ?? 0;
        value = (value << 7) | (byte & 0x7f);
      } while ((byte & 0x80) !== 0);
      const status = bytes[i] ?? 0;
      if (status === 0x80) {
        noteOffTicks = value;
        break;
      }
      i += status === 0x90 ? 2 : 0;
    }
    const millis = (noteOffTicks * tempoUs) / ticksPerQuarter / 1000;
    expect(Math.round(millis)).toBe(scoreNotes(book())[0]!.durationMs);
  });
});
