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

/**
 * How long one note sounds, in milliseconds. The in-app player (`ui/sound.ts`)
 * and the exported file both read it from here: they used to disagree by 2.16×,
 * because the file wrote 400 ticks (0.42 s at 120 bpm) while the score declared
 * 900 ms — so a score exported to .mid played more than twice as fast as the
 * preview it was exported from.
 */
const NOTE_MS = 900;

/** The tempo the file declares: 500 000 µs per quarter note = 120 bpm. */
const TEMPO_US_PER_QUARTER = 500000;

const TICKS_PER_QUARTER = 480;

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
      durationMs: NOTE_MS,
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
  const ticksPerQuarter = TICKS_PER_QUARTER;
  // The score's own note length, converted into ticks at the declared tempo —
  // never a second, hand-maintained guess at what "one note" means.
  const noteTicks = Math.round((NOTE_MS * ticksPerQuarter * 1000) / TEMPO_US_PER_QUARTER);
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
  event(0, [
    0xff,
    0x51,
    0x03,
    (TEMPO_US_PER_QUARTER >> 16) & 0xff,
    (TEMPO_US_PER_QUARTER >> 8) & 0xff,
    TEMPO_US_PER_QUARTER & 0xff,
  ]); // 500000 µs/qn = 120bpm
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
