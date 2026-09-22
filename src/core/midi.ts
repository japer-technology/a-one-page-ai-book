/**
 * core/midi.ts — the score of your book. The mood map (one emotion dial per
 * page) becomes a playable Standard MIDI File (format 0), dependency-free.
 * Each emotion maps to a base pitch; the dial's value sets velocity and
 * octave. Pure bytes in, bytes out.
 */
import type { CompiledBook } from './compile';
import type { EmotionName } from './types';

const BASE_NOTE: Record<EmotionName, number> = {
  dread: 40, // low E
  menace: 43,
  tension: 45,
  sadness: 47,
  mystery: 50,
  romance: 52,
  warmth: 55,
  humor: 57,
  wonder: 60,
  joy: 64, // high E
};

export interface ScoreNote {
  note: number;
  velocity: number;
  durationMs: number;
  label: string;
}

/** The mood map as a sequence of notes. */
export function scoreNotes(compiled: CompiledBook): ScoreNote[] {
  const notes: ScoreNote[] = [];
  for (const page of compiled.pages) {
    if (!page.mood) continue;
    const base = BASE_NOTE[page.mood.label as EmotionName] ?? 55;
    const value = page.mood.value;
    notes.push({
      note: Math.max(21, Math.min(108, base + (value > 0 ? 12 : value < 0 ? -12 : 0))),
      velocity: 60 + Math.min(67, Math.abs(value) * 22),
      durationMs: 900,
      label: `${page.kind === 'prologue' ? 'Prologue' : `Page ${page.number}`}: ${page.mood.label} ${value > 0 ? '+' : ''}${value}`,
    });
  }
  return notes;
}

// ---- MIDI encoding ----------------------------------------------------------

function vlq(value: number): number[] {
  const bytes: number[] = [value & 0x7f];
  while ((value >>= 7) > 0) bytes.unshift((value & 0x7f) | 0x80);
  return bytes;
}

export function midiBytes(compiled: CompiledBook): Uint8Array {
  const notes = scoreNotes(compiled);
  const ticksPerQuarter = 480;
  const noteTicks = 400; // ~0.83s per note at 120bpm
  const header = [
    0x4d,
    0x54,
    0x68,
    0x64,
    0,
    0,
    0,
    6,
    0,
    0,
    0,
    1,
    (ticksPerQuarter >> 8) & 0xff,
    ticksPerQuarter & 0xff,
  ];

  const track: number[] = [];
  const event = (delta: number, bytes: number[]) => {
    track.push(...vlq(delta), ...bytes);
  };
  event(0, [0xff, 0x51, 0x03, 0x07, 0xa1, 0x20]); // tempo 500000 µs/qn = 120bpm
  for (const n of notes) {
    event(0, [0x90, n.note, n.velocity]);
    event(noteTicks, [0x80, n.note, 0]);
  }
  event(0, [0xff, 0x2f, 0x00]); // end of track

  const trackHeader = [0x4d, 0x54, 0x72, 0x6b];
  const trackLen = track.length;
  const bytes = [
    ...header,
    ...trackHeader,
    (trackLen >> 24) & 0xff,
    (trackLen >> 16) & 0xff,
    (trackLen >> 8) & 0xff,
    trackLen & 0xff,
    ...track,
  ];
  return new Uint8Array(bytes);
}
