/**
 * Application entry point.
 *
 * Wires the renderer, the stage, the type layer, the sound and the exports
 * together, and owns exactly one piece of state that matters: the current time.
 * Everything visible is a pure function of it, which is why scrubbing, playing
 * and offline rendering all go through the same code path and cannot drift
 * apart.
 */

import {
  WebGLRenderer,
  LinearSRGBColorSpace,
  NoToneMapping,
} from '../vendor/three.module.min.js';

import { FORMATS, QUALITY, TIMING, resolveLayout } from './config.js';
import { Stage } from './scene/stage.js';
import { Typography, loadFonts } from './overlay/typography.js';
import { FrameRenderer } from './render/frameRenderer.js';
import { AudioEngine, renderAudioMaster } from './audio/soundDesign.js';
import { Exporter, download } from './export/exporter.js';
import { createPanel } from './ui/panel.js';
import { clamp } from './core/easing.js';

/** Preview never renders wider than this; the master ignores it entirely. */
const PREVIEW_MAX_WIDTH = 1440;
/** Samples added per idle frame while a held frame converges. */
const REFINE_SAMPLES = 4;
const REFINE_LIMIT = 96;

class App {
  constructor() {
    this.stageElement = document.getElementById('stage');
    this.canvas = document.getElementById('view');
    this.referenceElement = document.getElementById('reference');

    this.time = 0;
    this.playing = false;
    this.lastFrameTime = 0;
    this.formatKey = '9:16';
    this.busy = false;
    this.referenceMode = 'over';
    this.previewSamples = QUALITY.preview;
  }

  async init() {
    const params = new URLSearchParams(location.search);
    this.formatKey = FORMATS[params.get('format')] ? params.get('format') : '9:16';

    this.renderer = new WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      alpha: false,
      // Required so a frame can still be read back after the draw call returns.
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(1);
    // Colour is managed by hand in the composite pass: the scene renders linear
    // into float, and the sRGB encode happens once, at the very end.
    this.renderer.outputColorSpace = LinearSRGBColorSpace;
    // No tone curve: white must encode as exactly 255, and the page is white.
    this.renderer.toneMapping = NoToneMapping;

    await loadFonts();

    this.typography = new Typography();
    // Two-pass layout: measure the type, then resolve the composition around it.
    this.typography.measureMetrics(resolveLayout(this.formatKey));
    this.layout = resolveLayout(this.formatKey, this.typography.metrics);

    this.stage = new Stage(this.renderer, this.layout);
    this.frameRenderer = new FrameRenderer(this.renderer, this.stage, this.typography);

    this.audio = new AudioEngine();
    this.exporter = new Exporter({
      frameRenderer: this.frameRenderer,
      canvas: this.canvas,
      onSizeChange: () => this.resize(true),
    });

    this.resize();
    window.addEventListener('resize', () => this.resize());

    // Headless / verification mode: render one frame at an exact size and stop.
    const still = params.get('still');
    if (still !== null) {
      const width = Number(params.get('w')) || this.layout.master[0];
      const height = Math.round(width / this.layout.aspect);
      const time = clamp(Number(still) || 0, 0, TIMING.duration);
      this.frameRenderer.setSize(width, height);
      this.frameRenderer.render(time, {
        samples: Number(params.get('samples')) || QUALITY.master,
        frameIndex: Math.round(time * TIMING.fps),
      });
      this.canvas.style.width = '100%';
      this.canvas.style.height = 'auto';
      document.body.dataset.ready = '1';
      return;
    }

    this.panel = createPanel(document.body, {
      onTogglePlay: () => this.togglePlay(),
      onSeek: (t) => this.seek(t),
      onFormat: (key) => this.setFormat(key),
      onToggleSound: () => this.toggleSound(),
      onToggleReferenceMode: () => this.toggleReferenceMode(),
      onReferenceOpacity: (value) => this.setReferenceOpacity(value),
      onExportStill: () => this.exportStill(),
      onExportSequence: () => this.exportSequence(),
      onExportWebM: () => this.exportWebM(),
      onExportAudio: () => this.exportAudio(),
      onCancel: () => this.exporter.cancel(),
    });
    this.panel.setSound(this.audio.enabled);

    this.bindKeys();
    this.bindReferenceDrop();

    document.body.dataset.ready = '1';
    this.seek(0);
    this.play();
    this.loop();
  }

  /* ── Sizing ─────────────────────────────────────────────────────────── */

  resize(preserveTime = false) {
    const layout = this.layout;
    const margin = window.innerWidth < 720 ? 0 : 48;
    const availableWidth = window.innerWidth - margin;
    const availableHeight = window.innerHeight - margin;

    let displayWidth = Math.min(availableWidth, availableHeight * layout.aspect);
    let displayHeight = displayWidth / layout.aspect;

    this.stageElement.style.width = `${Math.round(displayWidth)}px`;
    this.stageElement.style.height = `${Math.round(displayHeight)}px`;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const renderWidth = Math.min(PREVIEW_MAX_WIDTH, Math.round(displayWidth * dpr));
    const renderHeight = Math.round(renderWidth / layout.aspect);

    // First build seeds the type layer; from then on it follows the renderer.
    if (!this.typography.layout) this.typography.build(this.layout, renderWidth);
    this.frameRenderer.setSize(renderWidth, renderHeight);
    if (!preserveTime) this.frameRenderer.invalidate();
  }

  setFormat(key) {
    if (!FORMATS[key] || key === this.formatKey) return;
    this.formatKey = key;
    this.layout = resolveLayout(key, this.typography.metrics);
    this.stage.setLayout(this.layout);
    this.typography.build(this.layout, this.frameRenderer.width);
    this.resize();
    this.frameRenderer.invalidate();
    this.render();
  }

  /* ── Transport ──────────────────────────────────────────────────────── */

  play() {
    if (this.busy) return;
    this.playing = true;
    this.lastFrameTime = performance.now();
    this.audio.start(this.time);
  }

  pause() {
    this.playing = false;
    this.audio.stop();
  }

  togglePlay() {
    this.playing ? this.pause() : this.play();
  }

  seek(time) {
    this.time = clamp(time, 0, TIMING.duration);
    this.frameRenderer.invalidate();
    if (this.playing) {
      this.audio.start(this.time);
      this.lastFrameTime = performance.now();
    }
    this.render();
  }

  step(frames) {
    this.pause();
    this.seek(this.time + frames / TIMING.fps);
  }

  toggleSound() {
    this.audio.enabled = !this.audio.enabled;
    if (!this.audio.enabled) this.audio.stop();
    else if (this.playing) this.audio.start(this.time);
    this.panel?.setSound(this.audio.enabled);
  }

  /* ── Frame loop ─────────────────────────────────────────────────────── */

  loop() {
    requestAnimationFrame(() => this.loop());
    if (this.busy) return;

    if (this.playing) {
      const now = performance.now();
      const delta = Math.min(0.25, (now - this.lastFrameTime) / 1000);
      this.lastFrameTime = now;
      this.time += delta;
      if (this.time >= TIMING.duration) {
        this.time -= TIMING.duration;
        this.audio.start(this.time);
      }
      this.render();
    } else if (this.frameRenderer.sampleCount < REFINE_LIMIT) {
      // A held frame keeps integrating until it is cleaner than the master.
      this.render(true);
    }

    this.panel?.setTime(this.time, this.playing);
  }

  render(progressive = false) {
    const started = performance.now();
    this.frameRenderer.render(this.time, {
      samples: progressive ? REFINE_SAMPLES : this.previewSamples,
      progressive,
      frameIndex: Math.round(this.time * TIMING.fps),
    });
    if (!progressive) this._adaptSamples(performance.now() - started);
  }

  /**
   * Keeps playback at frame rate on whatever GPU is present by trading sample
   * count for time. Held frames converge progressively regardless, so this only
   * affects how much blur detail is integrated *while moving* — where it is the
   * least visible thing on screen.
   */
  _adaptSamples(elapsed) {
    this._renderCost = this._renderCost === undefined
      ? elapsed
      : this._renderCost * 0.85 + elapsed * 0.15;
    const budget = 1000 / TIMING.fps;
    if (this._renderCost > budget * 0.92 && this.previewSamples > 2) {
      this.previewSamples--;
      this._renderCost = budget * 0.6;
    } else if (this._renderCost < budget * 0.45 && this.previewSamples < QUALITY.preview) {
      this.previewSamples++;
      this._renderCost = budget * 0.6;
    }
  }

  /* ── Exports ────────────────────────────────────────────────────────── */

  async withBusy(label, task) {
    this.pause();
    this.busy = true;
    this.panel.setBusy(true);
    this.panel.setProgress(0, label);
    try {
      await task();
    } catch (error) {
      console.error(error);
      this.panel.setProgress(0, error.message || String(error));
      await new Promise((resolve) => setTimeout(resolve, 4000));
    } finally {
      this.busy = false;
      this.panel.setBusy(false);
      this.frameRenderer.invalidate();
      this.render();
    }
  }

  exportStill() {
    return this.withBusy('Rendering still…', async () => {
      await this.exporter.exportStill(this.time, this.layout.master);
    });
  }

  exportSequence() {
    return this.withBusy('Rendering master…', async () => {
      const result = await this.exporter.exportSequence(this.layout.master, (p) => {
        const perFrame = p.elapsed / p.frame;
        const remaining = Math.round(perFrame * (p.total - p.frame));
        this.panel.setProgress(
          p.frame / p.total,
          `${p.frame} / ${p.total} frames · ${this.layout.master.join('×')} · ~${remaining}s left`
        );
      });
      this.panel.setProgress(1, result.cancelled ? 'Cancelled.' : `Done — ${result.total} frames.`);
      await new Promise((resolve) => setTimeout(resolve, 2500));
    });
  }

  exportWebM() {
    return this.withBusy('Recording…', async () => {
      const audioContext = this.audio.enabled ? this.audio._ensure() : null;
      if (audioContext) this.audio.start(0);

      const height = 1920;
      const width = Math.round(height * this.layout.aspect);
      const result = await this.exporter.exportWebM([width, height], {
        audioContext,
        audioSource: this.audio.master?.output,
        onProgress: (p) => {
          this.panel.setProgress(p.frame / p.total, `${p.frame} / ${p.total} frames · real time`);
        },
      });
      this.audio.stop();

      download(result.blob, 'forbusinessfrance_leads.webm');
      this.panel.setProgress(
        1,
        result.dropped > 0
          ? `Saved — ${result.dropped} frames could not hold 60 fps. Use the PNG sequence for the master.`
          : 'Saved.'
      );
      await new Promise((resolve) => setTimeout(resolve, 3000));
    });
  }

  exportAudio() {
    return this.withBusy('Rendering audio…', async () => {
      const blob = await renderAudioMaster();
      download(blob, 'forbusinessfrance_leads.wav');
      this.panel.setProgress(1, 'Saved.');
      await new Promise((resolve) => setTimeout(resolve, 1500));
    });
  }

  /* ── Reference comparison ───────────────────────────────────────────── */

  bindReferenceDrop() {
    const prevent = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
      document.body.addEventListener(type, prevent);
    }
    document.body.addEventListener('dragover', () => document.body.classList.add('is-dropping'));
    document.body.addEventListener('dragleave', () => document.body.classList.remove('is-dropping'));
    document.body.addEventListener('drop', (event) => {
      document.body.classList.remove('is-dropping');
      const file = event.dataTransfer?.files?.[0];
      if (!file || !file.type.startsWith('image/')) return;
      this.referenceElement.src = URL.createObjectURL(file);
      this.panel?.setReferenceLoaded();
    });
  }

  setReferenceOpacity(value) {
    this.referenceElement.style.opacity = String(value);
  }

  toggleReferenceMode() {
    this.referenceMode = this.referenceMode === 'over' ? 'difference' : 'over';
    this.referenceElement.style.mixBlendMode =
      this.referenceMode === 'difference' ? 'difference' : 'normal';
    this.panel?.setReferenceMode(this.referenceMode);
  }

  /* ── Keyboard ───────────────────────────────────────────────────────── */

  bindKeys() {
    window.addEventListener('keydown', (event) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
        return;
      }
      const jump = event.shiftKey ? 10 : 1;
      switch (event.code) {
        case 'Space':
          event.preventDefault();
          this.togglePlay();
          break;
        case 'ArrowRight':
          event.preventDefault();
          this.step(jump);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          this.step(-jump);
          break;
        case 'KeyR':
          this.seek(0);
          this.play();
          break;
        case 'KeyH':
          this.panel?.toggle();
          break;
        case 'KeyE':
          this.exportStill();
          break;
        case 'KeyM':
          this.toggleSound();
          break;
        case 'End':
          this.step(0);
          this.seek(TIMING.duration);
          break;
        case 'Home':
          this.seek(0);
          break;
        default:
          break;
      }
    });
  }
}

const app = new App();
// Exposed for tooling: headless verification drives the film through this.
window.__app = app;
app.init().catch((error) => {
  console.error(error);
  document.body.innerHTML = `<pre class="fatal">${error.stack || error}</pre>`;
});
