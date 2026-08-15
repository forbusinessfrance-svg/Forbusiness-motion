/**
 * Export.
 *
 * Two paths, for two different jobs:
 *
 * · **PNG sequence + WAV** — the master. Frames are rendered offline, one at a
 *   time, at full 2160×3840 with the full sample budget, and written straight to
 *   a folder you pick. Nothing is dropped, nothing is compressed, and the render
 *   is allowed to take as long as it takes. This is the path to hand to an
 *   editor or to mux with ffmpeg.
 *
 * · **WebM** — the review copy. Captured in real time with the soundtrack
 *   attached, so it plays anywhere immediately. Paced against the wall clock,
 *   because MediaRecorder timestamps by wall clock: if the machine can't hold
 *   the frame rate the export reports it rather than silently retiming.
 */

import { TIMING, QUALITY } from '../config.js';

const pad = (n, width = 4) => String(n).padStart(width, '0');

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('canvas encode failed'))),
      type,
      quality
    );
  });
}

/** Lets the browser breathe between frames so the UI can report progress. */
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

export class Exporter {
  /**
   * @param {object} deps
   * @param {import('../render/frameRenderer.js').FrameRenderer} deps.frameRenderer
   * @param {HTMLCanvasElement} deps.canvas
   * @param {() => void} deps.onSizeChange called after the export restores the preview size
   */
  constructor({ frameRenderer, canvas, onSizeChange }) {
    this.frameRenderer = frameRenderer;
    this.canvas = canvas;
    this.onSizeChange = onSizeChange;
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
  }

  /** Total frames in the film. */
  get frameCount() {
    return Math.round(TIMING.duration * TIMING.fps);
  }

  /**
   * Renders a single frame at master resolution and downloads it.
   * @param {number} time
   * @param {[number, number]} size
   */
  async exportStill(time, size, filename = `forbusinessfrance_${Math.round(time * 1000)}ms.png`) {
    const previous = [this.frameRenderer.width, this.frameRenderer.height];
    this.frameRenderer.setSize(size[0], size[1]);
    this.frameRenderer.render(time, { samples: QUALITY.master, frameIndex: Math.round(time * TIMING.fps) });
    const blob = await canvasToBlob(this.canvas);
    download(blob, filename);
    this.frameRenderer.setSize(previous[0], previous[1]);
    this.onSizeChange?.();
  }

  /**
   * Master render: a numbered PNG sequence written to a folder of your choosing.
   * @param {[number, number]} size
   * @param {(progress: {frame:number,total:number,elapsed:number}) => void} onProgress
   */
  async exportSequence(size, onProgress) {
    if (!window.showDirectoryPicker) {
      throw new Error(
        'PNG sequence export needs the File System Access API (Chrome or Edge). ' +
          'Use the WebM export in this browser, or run the master render in Chrome.'
      );
    }

    const directory = await window.showDirectoryPicker({ mode: 'readwrite' });
    this.cancelled = false;

    const previous = [this.frameRenderer.width, this.frameRenderer.height];
    this.frameRenderer.setSize(size[0], size[1]);

    const total = this.frameCount;
    const started = performance.now();

    try {
      for (let frame = 0; frame < total; frame++) {
        if (this.cancelled) break;

        const time = frame / TIMING.fps;
        this.frameRenderer.render(time, { samples: QUALITY.master, frameIndex: frame });

        const blob = await canvasToBlob(this.canvas);
        const handle = await directory.getFileHandle(`fbf_${pad(frame)}.png`, { create: true });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();

        onProgress?.({ frame: frame + 1, total, elapsed: (performance.now() - started) / 1000 });
        await nextTick();
      }
    } finally {
      this.frameRenderer.setSize(previous[0], previous[1]);
      this.onSizeChange?.();
    }

    return { cancelled: this.cancelled, total };
  }

  /**
   * Review copy: a real-time WebM with the soundtrack muxed in.
   *
   * @param {[number, number]} size
   * @param {object} options
   * @param {AudioContext} [options.audioContext]
   * @param {AudioNode} [options.audioSource] master bus to record
   * @param {() => void} [options.onStart] called when recording actually begins
   */
  async exportWebM(size, { audioContext, audioSource, onProgress, onStart } = {}) {
    if (!window.MediaRecorder) throw new Error('MediaRecorder is not available in this browser.');

    const previous = [this.frameRenderer.width, this.frameRenderer.height];
    this.frameRenderer.setSize(size[0], size[1]);
    this.cancelled = false;

    const stream = this.canvas.captureStream(0);
    const [track] = stream.getVideoTracks();

    let audioDestination = null;
    if (audioContext && audioSource) {
      audioDestination = audioContext.createMediaStreamDestination();
      audioSource.connect(audioDestination);
      for (const audioTrack of audioDestination.stream.getAudioTracks()) {
        stream.addTrack(audioTrack);
      }
    }

    const mimeType = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp9',
      'video/webm',
    ].find((type) => MediaRecorder.isTypeSupported(type));

    const chunks = [];
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 48_000_000,
      audioBitsPerSecond: 256_000,
    });
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };

    const finished = new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    });

    const total = this.frameCount;
    const frameDuration = 1000 / TIMING.fps;
    let dropped = 0;

    recorder.start();
    onStart?.();
    const started = performance.now();

    for (let frame = 0; frame < total; frame++) {
      if (this.cancelled) break;

      this.frameRenderer.render(frame / TIMING.fps, {
        samples: QUALITY.preview,
        frameIndex: frame,
      });
      track.requestFrame();
      onProgress?.({ frame: frame + 1, total, elapsed: (performance.now() - started) / 1000 });

      // Pace against the wall clock; MediaRecorder timestamps by it.
      const target = started + (frame + 1) * frameDuration;
      const slack = target - performance.now();
      if (slack > 1) {
        await new Promise((resolve) => setTimeout(resolve, slack));
      } else {
        dropped++;
        await nextTick();
      }
    }

    recorder.stop();
    const blob = await finished;
    if (audioDestination) audioSource.disconnect(audioDestination);

    this.frameRenderer.setSize(previous[0], previous[1]);
    this.onSizeChange?.();

    return { blob, dropped, total };
  }
}
