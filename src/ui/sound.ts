/**
 * ui/sound.ts — an ambient mood soundscape, generated live with WebAudio.
 *
 * No audio files, no network: two detuned oscillators through a slow low-pass
 * filter and a breathing LFO. The page's dominant emotion dial retunes the
 * pad (pitch, filter, brightness) so the room itself tells you where the
 * story is. Starts only after a user gesture (the toggle), per autoplay rules.
 */

export interface MoodTone {
  icon: string;
  label: string;
  value: number;
}

interface PadState {
  ctx: AudioContext;
  oscA: OscillatorNode;
  oscB: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  lfo: OscillatorNode;
  lfoGain: GainNode;
}

let pad: PadState | null = null;
let enabled = false;
let currentMood: MoodTone | null = null;

/** Is the soundscape running? */
export function ambienceOn(): boolean {
  return enabled;
}

/** Start (or stop) the ambient pad. Must be called from a user gesture. */
export function toggleAmbience(): boolean {
  if (enabled) {
    stopAmbience();
    return false;
  }
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return false;
    const ctx = new Ctx();
    const oscA = ctx.createOscillator();
    const oscB = ctx.createOscillator();
    oscA.type = 'sine';
    oscB.type = 'triangle';
    oscA.frequency.value = 110;
    oscB.frequency.value = 110.7;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    filter.Q.value = 0.6;
    const gain = ctx.createGain();
    gain.gain.value = 0.0;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.028;
    lfo.connect(lfoGain);
    lfoGain.connect(gain.gain);
    oscA.connect(filter);
    oscB.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    oscA.start();
    oscB.start();
    lfo.start();
    pad = { ctx, oscA, oscB, filter, gain, lfo, lfoGain };
    enabled = true;
    gain.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 1.5);
    if (currentMood) applyMood(currentMood);
    return true;
  } catch {
    return false;
  }
}

export function stopAmbience(): void {
  if (!pad) return;
  const state = pad;
  pad = null;
  enabled = false;
  try {
    state.gain.gain.linearRampToValueAtTime(0.0001, state.ctx.currentTime + 0.6);
    window.setTimeout(() => {
      state.oscA.stop();
      state.oscB.stop();
      state.lfo.stop();
      void state.ctx.close();
    }, 900);
  } catch {
    // already stopped
  }
}

/** Retune the pad toward the page's dominant emotion. */
export function setAmbienceMood(mood: MoodTone | null): void {
  currentMood = mood;
  if (!enabled || !pad) return;
  applyMood(mood);
}

function applyMood(mood: MoodTone | null): void {
  if (!pad) return;
  const now = pad.ctx.currentTime;
  const base = mood
    ? ((
        {
          dread: { freq: 82, filter: 260 },
          menace: { freq: 98, filter: 300 },
          tension: { freq: 110, filter: 380 },
          mystery: { freq: 130, filter: 520 },
          sadness: { freq: 123, filter: 420 },
          romance: { freq: 146, filter: 700 },
          warmth: { freq: 164, filter: 900 },
          joy: { freq: 196, filter: 1200 },
          wonder: { freq: 174, filter: 1100 },
          humor: { freq: 155, filter: 950 },
        } as Record<string, { freq: number; filter: number }>
      )[mood.label] ?? { freq: 130, filter: 500 })
    : { freq: 130, filter: 500 };
  const intensity = mood ? Math.abs(mood.value) / 3 : 0.4;
  pad.oscA.frequency.linearRampToValueAtTime(base.freq, now + 2.5);
  pad.oscB.frequency.linearRampToValueAtTime(base.freq * 1.006, now + 2.5);
  pad.filter.frequency.linearRampToValueAtTime(base.filter * (0.7 + intensity), now + 2.5);
  pad.gain.gain.linearRampToValueAtTime(0.035 + intensity * 0.02, now + 2.5);
}
