/**
 * Sound design.
 *
 * Four events, no music, all synthesised — nothing is sampled, so the whole
 * soundtrack is a few hundred bytes of code and renders identically live or
 * offline:
 *
 *   · whoosh   — air over the flight as the dart crosses
 *   · impact   — a dry transient, a short body, and a low thump under it
 *   · pulse    — a small digital chime at the bullseye
 *   · settle   — a sub-bass swell that decays as the frame comes to rest
 *
 * The same scheduling function drives a live AudioContext for preview and an
 * OfflineAudioContext for the WAV master, so what you hear is what you export.
 */

import { TIMING } from '../config.js';

/** White noise, generated once per context. */
function noiseBuffer(ctx, seconds = 2) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  // Deterministic LCG: the WAV master is bit-identical between runs.
  let seed = 0x2f6e2b1;
  for (let i = 0; i < length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (seed / 0x3fffffff) - 1;
  }
  return buffer;
}

function noiseSource(ctx, buffer, when, duration) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.start(when);
  src.stop(when + duration);
  return src;
}

/**
 * Schedules the full soundtrack.
 *
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} destination
 * @param {number} originTime context time that corresponds to film time 0
 * @param {number} [from] film time to start scheduling from (events already
 *   past are skipped, so scrubbing never fires a stale impact)
 */
export function scheduleSoundDesign(ctx, destination, originTime, from = 0) {
  const noise = noiseBuffer(ctx);
  const T = TIMING;
  const at = (filmTime) => originTime + filmTime;
  const live = (filmTime) => filmTime >= from - 0.001;

  /* ── 1. Whoosh ─────────────────────────────────────────────────────────
   * Bandpassed air, sweeping up as the dart gets closer and nearer to the
   * microphone, cut dead at contact so the impact has the room to itself. */
  if (live(T.dart.launch)) {
    const start = at(T.dart.launch);
    const end = at(T.dart.impact);
    const duration = end - start;

    const src = noiseSource(ctx, noise, start, duration + 0.05);

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 1.15;
    band.frequency.setValueAtTime(380, start);
    band.frequency.exponentialRampToValueAtTime(2400, end);

    const shelf = ctx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 5200;
    shelf.gain.value = -8;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.075, start + duration * 0.72);
    gain.gain.exponentialRampToValueAtTime(0.22, end - 0.012);
    gain.gain.linearRampToValueAtTime(0.0, end + 0.008);

    src.connect(band).connect(shelf).connect(gain).connect(destination);
  }

  /* ── 2. Impact ─────────────────────────────────────────────────────────
   * Three layers: a 5 ms tick that carries the "point", a short filtered body
   * for the board, and a pitched thump for the weight. */
  if (live(T.dart.impact)) {
    const hit = at(T.dart.impact);

    // Tick.
    const tick = noiseSource(ctx, noise, hit, 0.05);
    const tickFilter = ctx.createBiquadFilter();
    tickFilter.type = 'highpass';
    tickFilter.frequency.value = 3800;
    const tickGain = ctx.createGain();
    tickGain.gain.setValueAtTime(0.0001, hit);
    tickGain.gain.exponentialRampToValueAtTime(0.5, hit + 0.0012);
    tickGain.gain.exponentialRampToValueAtTime(0.0006, hit + 0.028);
    tick.connect(tickFilter).connect(tickGain).connect(destination);

    // Body.
    const body = noiseSource(ctx, noise, hit, 0.2);
    const bodyFilter = ctx.createBiquadFilter();
    bodyFilter.type = 'lowpass';
    bodyFilter.frequency.setValueAtTime(2600, hit);
    bodyFilter.frequency.exponentialRampToValueAtTime(420, hit + 0.11);
    bodyFilter.Q.value = 0.7;
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0.0001, hit);
    bodyGain.gain.exponentialRampToValueAtTime(0.34, hit + 0.004);
    bodyGain.gain.exponentialRampToValueAtTime(0.0004, hit + 0.16);
    body.connect(bodyFilter).connect(bodyGain).connect(destination);

    // Thump.
    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(96, hit);
    thump.frequency.exponentialRampToValueAtTime(44, hit + 0.16);
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(0.0001, hit);
    thumpGain.gain.exponentialRampToValueAtTime(0.42, hit + 0.006);
    thumpGain.gain.exponentialRampToValueAtTime(0.0004, hit + 0.34);
    thump.connect(thumpGain).connect(destination);
    thump.start(hit);
    thump.stop(hit + 0.4);
  }

  /* ── 3. Digital pulse at the bullseye ─────────────────────────────────── */
  if (live(T.dart.impact + 0.02)) {
    const pulse = at(T.dart.impact + 0.02);
    for (const [freq, level, detune] of [
      [1180, 0.05, 0],
      [2360, 0.028, 6],
      [3540, 0.012, -5],
    ]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.detune.value = detune;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, pulse);
      gain.gain.exponentialRampToValueAtTime(level, pulse + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, pulse + 0.16);
      osc.connect(gain).connect(destination);
      osc.start(pulse);
      osc.stop(pulse + 0.2);
    }
  }

  /* ── 4. Sub-bass settle ────────────────────────────────────────────────
   * Felt rather than heard: it arrives under the impact and decays as the
   * frame comes to rest. */
  if (live(T.dart.impact + 0.04)) {
    const start = at(T.dart.impact + 0.04);
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(46, start);
    sub.frequency.exponentialRampToValueAtTime(34, start + 1.1);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.16, start + 0.09);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.5);
    sub.connect(gain).connect(destination);
    sub.start(start);
    sub.stop(start + 1.6);
  }
}

/** Master chain: a touch of glue compression, then headroom. */
function createMaster(ctx) {
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -12;
  compressor.knee.value = 8;
  compressor.ratio.value = 3.2;
  compressor.attack.value = 0.002;
  compressor.release.value = 0.14;

  const gain = ctx.createGain();
  gain.gain.value = 0.9;

  compressor.connect(gain);
  return { input: compressor, output: gain };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Live playback
 * ────────────────────────────────────────────────────────────────────────── */

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
  }

  _ensure() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      this.master = createMaster(this.ctx);
      this.master.output.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  /** (Re)schedules the soundtrack for a playback starting at film time `from`. */
  start(from = 0) {
    if (!this.enabled) return;
    const ctx = this._ensure();
    this.stop();
    scheduleSoundDesign(ctx, this.master.input, ctx.currentTime - from, from);
  }

  stop() {
    if (!this.ctx || !this.master) return;
    // Rebuilding the master is the cleanest way to cancel everything scheduled.
    this.master.output.disconnect();
    this.master = createMaster(this.ctx);
    this.master.output.connect(this.ctx.destination);
  }

  dispose() {
    this.stop();
    this.ctx?.close();
    this.ctx = null;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Offline master
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Renders the soundtrack offline and returns a 24-bit WAV.
 * @param {number} [sampleRate]
 * @returns {Promise<Blob>}
 */
export async function renderAudioMaster(sampleRate = 48000) {
  const duration = TIMING.duration;
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Offline(2, Math.ceil(duration * sampleRate), sampleRate);
  const master = createMaster(ctx);
  master.output.connect(ctx.destination);
  scheduleSoundDesign(ctx, master.input, 0, 0);
  const buffer = await ctx.startRendering();
  return encodeWav(buffer);
}

/** 24-bit PCM WAV — delivery quality, and what an editor expects. */
function encodeWav(buffer) {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytesPerSample = 3;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const view = new DataView(new ArrayBuffer(44 + dataSize));

  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  const data = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const clamped = Math.max(-1, Math.min(1, data[c][i]));
      const value = Math.round(clamped * 8388607);
      view.setUint8(offset, value & 0xff);
      view.setUint8(offset + 1, (value >> 8) & 0xff);
      view.setUint8(offset + 2, (value >> 16) & 0xff);
      offset += 3;
    }
  }

  return new Blob([view.buffer], { type: 'audio/wav' });
}
