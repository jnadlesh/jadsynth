// Sample-precise scrub engine using AudioBufferSourceNode.
//
// On `prepareTrack(src)`, the audio file is fetched, decoded into an
// AudioBuffer, and a reversed copy is built so that backward scrubbing
// can play actual audio (instead of silence). On `startScrub(src, pos)`,
// a session begins: the engine creates a GainNode connected to the shared
// input, and during `updateScrub(velocity)` it adjusts an
// AudioBufferSourceNode's `playbackRate` in real time and swaps between
// forward/reverse buffer when direction changes (with a small crossfade
// to avoid a click). On `endScrub()`, audio fades and the session ends.

import { getAudioContext, getInputGain } from "./audio-graph";

type Cached = { buffer: AudioBuffer; reverse: AudioBuffer };

const bufferCache = new Map<string, Cached>();
const inFlight = new Map<string, Promise<void>>();

function reverseBuffer(ctx: AudioContext, buf: AudioBuffer): AudioBuffer {
  const rev = ctx.createBuffer(
    buf.numberOfChannels,
    buf.length,
    buf.sampleRate,
  );
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const src = buf.getChannelData(ch);
    const dst = rev.getChannelData(ch);
    const n = src.length;
    for (let i = 0; i < n; i++) {
      dst[i] = src[n - 1 - i];
    }
  }
  return rev;
}

export async function prepareTrack(src: string): Promise<void> {
  if (bufferCache.has(src)) return;
  if (inFlight.has(src)) return inFlight.get(src);

  const promise = (async () => {
    const ctx = getAudioContext();
    if (!ctx) throw new Error("no AudioContext");
    const res = await fetch(src);
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const arr = await res.arrayBuffer();
    const buffer = await ctx.decodeAudioData(arr);
    const reverse = reverseBuffer(ctx, buffer);
    bufferCache.set(src, { buffer, reverse });
    inFlight.delete(src);
  })();

  inFlight.set(src, promise);
  return promise;
}

export function isScrubReady(src: string): boolean {
  return bufferCache.has(src);
}

export function freeBuffersExcept(keepSrcs: string[]): void {
  const keep = new Set(keepSrcs);
  for (const src of [...bufferCache.keys()]) {
    if (!keep.has(src)) bufferCache.delete(src);
  }
}

interface Session {
  ctx: AudioContext;
  cached: Cached;
  gain: GainNode;
  source: AudioBufferSourceNode | null;
  direction: 1 | -1;
  rate: number;
  positionAtStart: number;
  ctxTimeAtStart: number;
  lastReportedPosition: number;
  duration: number;
  targetGain: number;
}

let active: Session | null = null;

const MIN_RATE = 0.0625;
const MAX_RATE = 4;
const RATE_CHANGE_RESTART_THRESHOLD = 0.6;
// Scrub audio is always attenuated relative to normal playback so sudden
// scratch transients can't blow out the listener's ears.
const SCRUB_VOLUME_ATTENUATION = 0.55;
const MAX_SCRUB_GAIN = 0.7;

function nowPosition(s: Session): number {
  if (!s.source) return s.lastReportedPosition;
  const elapsed = (s.ctx.currentTime - s.ctxTimeAtStart) * s.rate;
  return s.positionAtStart + elapsed * s.direction;
}

function clampPos(s: Session, pos: number): number {
  return Math.max(0, Math.min(s.duration - 0.05, pos));
}

function startSource(s: Session, pos: number, rate: number, dir: 1 | -1) {
  if (s.source) {
    try {
      s.source.stop();
    } catch {
      /* already stopped */
    }
    try {
      s.source.disconnect();
    } catch {
      /* not connected */
    }
  }

  const buf = dir === 1 ? s.cached.buffer : s.cached.reverse;
  const offset = dir === 1 ? pos : s.duration - pos;
  const safeOffset = Math.max(0, Math.min(buf.duration - 0.05, offset));

  const src = s.ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = Math.max(MIN_RATE, Math.min(MAX_RATE, Math.abs(rate)));
  src.connect(s.gain);
  src.start(0, safeOffset);

  s.source = src;
  s.direction = dir;
  s.rate = Math.abs(rate);
  s.positionAtStart = pos;
  s.ctxTimeAtStart = s.ctx.currentTime;
  s.lastReportedPosition = pos;
}

function computeScrubGain(userVolume: number): number {
  const v = Math.max(0, Math.min(1, userVolume));
  return Math.min(MAX_SCRUB_GAIN, v * SCRUB_VOLUME_ATTENUATION);
}

export function startScrub(
  src: string,
  initialPos: number,
  startPlaying: boolean,
  userVolume = 1,
): boolean {
  const cached = bufferCache.get(src);
  if (!cached) return false;

  const ctx = getAudioContext();
  if (!ctx) return false;
  const input = getInputGain();
  if (!input) return false;

  if (active) {
    // Hard cleanup of any leftover session.
    if (active.source) {
      try {
        active.source.stop();
      } catch {
        /* already stopped */
      }
      try {
        active.source.disconnect();
      } catch {
        /* not connected */
      }
    }
    try {
      active.gain.disconnect();
    } catch {
      /* already disconnected */
    }
    active = null;
  }

  if (ctx.state === "suspended") ctx.resume().catch(() => {});

  const targetGain = computeScrubGain(userVolume);

  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(input);
  // Quick fade-in to avoid pop when joining the chain.
  const t0 = ctx.currentTime;
  gain.gain.linearRampToValueAtTime(targetGain, t0 + 0.015);

  active = {
    ctx,
    cached,
    gain,
    source: null,
    direction: 1,
    rate: 1,
    positionAtStart: initialPos,
    ctxTimeAtStart: t0,
    lastReportedPosition: initialPos,
    duration: cached.buffer.duration,
    targetGain,
  };

  if (startPlaying) {
    startSource(active, initialPos, 1, 1);
  }

  return true;
}

export function setScrubVolume(userVolume: number): void {
  if (!active) return;
  const target = computeScrubGain(userVolume);
  active.targetGain = target;
  const ctx = active.ctx;
  const t0 = ctx.currentTime;
  active.gain.gain.cancelScheduledValues(t0);
  active.gain.gain.setValueAtTime(active.gain.gain.value, t0);
  active.gain.gain.linearRampToValueAtTime(target, t0 + 0.05);
}

export function updateScrub(audioVelocity: number): void {
  if (!active) return;

  const pos = clampPos(active, nowPosition(active));
  active.lastReportedPosition = pos;

  const absV = Math.abs(audioVelocity);

  if (absV < MIN_RATE) {
    // Drag too slow — produce silence rather than droning at a fixed pitch.
    if (active.source) {
      try {
        active.source.stop();
      } catch {
        /* already stopped */
      }
      try {
        active.source.disconnect();
      } catch {
        /* not connected */
      }
      active.source = null;
    }
    active.positionAtStart = pos;
    active.ctxTimeAtStart = active.ctx.currentTime;
    return;
  }

  const newDir: 1 | -1 = audioVelocity >= 0 ? 1 : -1;
  const newRate = Math.min(MAX_RATE, absV);
  const directionChanged = active.source !== null && newDir !== active.direction;
  const bigRateChange =
    active.source !== null && Math.abs(newRate - active.rate) > RATE_CHANGE_RESTART_THRESHOLD;
  const wasIdle = active.source === null;

  if (directionChanged || bigRateChange || wasIdle) {
    startSource(active, pos, newRate, newDir);
  } else if (active.source) {
    // Smooth in-place rate ramp — avoids restarting the source for tiny changes.
    const now = active.ctx.currentTime;
    try {
      active.source.playbackRate.cancelScheduledValues(now);
      active.source.playbackRate.setTargetAtTime(newRate, now, 0.012);
    } catch {
      /* ignore */
    }
    active.positionAtStart = pos;
    active.ctxTimeAtStart = now;
    active.rate = newRate;
  }
}

export function getScrubPosition(): number | null {
  if (!active) return null;
  return clampPos(active, nowPosition(active));
}

export function getScrubDuration(): number | null {
  if (!active) return null;
  return active.duration;
}

export function endScrub(): number | null {
  if (!active) return null;

  const finalPos = clampPos(active, nowPosition(active));
  const ctx = active.ctx;
  const t0 = ctx.currentTime;
  const fadeDur = 0.025;

  active.gain.gain.cancelScheduledValues(t0);
  active.gain.gain.setValueAtTime(active.gain.gain.value, t0);
  active.gain.gain.linearRampToValueAtTime(0, t0 + fadeDur);

  const sourceToStop = active.source;
  const gainToDisconnect = active.gain;
  window.setTimeout(() => {
    if (sourceToStop) {
      try {
        sourceToStop.stop();
      } catch {
        /* already stopped */
      }
      try {
        sourceToStop.disconnect();
      } catch {
        /* not connected */
      }
    }
    try {
      gainToDisconnect.disconnect();
    } catch {
      /* already disconnected */
    }
  }, Math.ceil(fadeDur * 1000) + 10);

  active = null;
  return finalPos;
}
