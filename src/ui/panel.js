/**
 * The control surface.
 *
 * Plain DOM, deliberately outside the canvas: nothing here can ever leak into a
 * render or a capture. It exists to drive the film frame by frame, to fire the
 * exports, and — the part that earns its keep — to hold the reference still on
 * top of the render so the final frame can be checked against it directly.
 */

import { TIMING, FORMATS } from '../config.js';

const TEMPLATE = /* html */ `
  <div class="panel__row panel__row--transport">
    <button class="panel__btn panel__btn--play" data-action="play" title="Space">Play</button>
    <input class="panel__scrub" type="range" min="0" max="${TIMING.duration}" step="${1 / TIMING.fps}" value="0" />
    <span class="panel__time"><b data-time>0.000</b> / ${TIMING.duration.toFixed(2)}s</span>
    <span class="panel__frame" data-frame>f 0</span>
  </div>

  <div class="panel__row">
    <label class="panel__field">
      <span>Format</span>
      <select data-format>
        ${Object.keys(FORMATS)
          .map((key) => `<option value="${key}">${key}</option>`)
          .join('')}
      </select>
    </label>
    <label class="panel__field">
      <span>Sound</span>
      <button class="panel__btn" data-action="mute">On</button>
    </label>
    <label class="panel__field panel__field--grow">
      <span>Reference</span>
      <input type="range" data-ref-opacity min="0" max="100" value="0" />
      <button class="panel__btn" data-action="ref-mode" title="Toggle difference blend">Over</button>
    </label>
  </div>

  <div class="panel__row">
    <button class="panel__btn" data-action="still">Still PNG · master</button>
    <button class="panel__btn panel__btn--primary" data-action="sequence">Render PNG sequence</button>
    <button class="panel__btn" data-action="webm">WebM + sound</button>
    <button class="panel__btn" data-action="wav">WAV</button>
    <button class="panel__btn panel__btn--danger" data-action="cancel" hidden>Cancel</button>
  </div>

  <div class="panel__progress" hidden>
    <div class="panel__progress-bar"><i></i></div>
    <span data-progress-label></span>
  </div>

  <p class="panel__hint">
    <b>Space</b> play · <b>← →</b> step frame · <b>⇧ ← →</b> jump 10 · <b>R</b> restart ·
    <b>H</b> hide panel · drop the reference image here to compare
  </p>
`;

/**
 * @param {HTMLElement} host
 * @param {object} handlers
 */
export function createPanel(host, handlers) {
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = TEMPLATE;
  host.appendChild(panel);

  const q = (selector) => panel.querySelector(selector);
  const playButton = q('[data-action="play"]');
  const scrub = q('.panel__scrub');
  const timeLabel = q('[data-time]');
  const frameLabel = q('[data-frame]');
  const progress = q('.panel__progress');
  const progressBar = q('.panel__progress-bar i');
  const progressLabel = q('[data-progress-label]');
  const cancelButton = q('[data-action="cancel"]');
  const muteButton = q('[data-action="mute"]');
  const refOpacity = q('[data-ref-opacity]');
  const refMode = q('[data-action="ref-mode"]');

  let scrubbing = false;

  scrub.addEventListener('input', () => {
    scrubbing = true;
    handlers.onSeek(Number(scrub.value));
  });
  scrub.addEventListener('change', () => {
    scrubbing = false;
  });

  panel.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'play') handlers.onTogglePlay();
    if (action === 'still') handlers.onExportStill();
    if (action === 'sequence') handlers.onExportSequence();
    if (action === 'webm') handlers.onExportWebM();
    if (action === 'wav') handlers.onExportAudio();
    if (action === 'cancel') handlers.onCancel();
    if (action === 'mute') handlers.onToggleSound();
    if (action === 'ref-mode') handlers.onToggleReferenceMode();
  });

  q('[data-format]').addEventListener('change', (event) => {
    handlers.onFormat(event.target.value);
  });

  refOpacity.addEventListener('input', () => {
    handlers.onReferenceOpacity(Number(refOpacity.value) / 100);
  });

  return {
    element: panel,

    setTime(time, playing) {
      if (!scrubbing) scrub.value = String(time);
      timeLabel.textContent = time.toFixed(3);
      frameLabel.textContent = `f ${Math.round(time * TIMING.fps)}`;
      playButton.textContent = playing ? 'Pause' : 'Play';
      playButton.classList.toggle('is-playing', playing);
    },

    setSound(enabled) {
      muteButton.textContent = enabled ? 'On' : 'Off';
      muteButton.classList.toggle('is-off', !enabled);
    },

    setReferenceMode(mode) {
      refMode.textContent = mode === 'difference' ? 'Diff' : 'Over';
    },

    setReferenceLoaded() {
      if (Number(refOpacity.value) === 0) {
        refOpacity.value = '55';
        handlers.onReferenceOpacity(0.55);
      }
    },

    setBusy(busy) {
      progress.hidden = !busy;
      cancelButton.hidden = !busy;
      panel.classList.toggle('is-busy', busy);
    },

    setProgress(fraction, label) {
      progressBar.style.width = `${Math.round(fraction * 100)}%`;
      progressLabel.textContent = label;
    },

    toggle() {
      panel.classList.toggle('is-hidden');
    },
  };
}
