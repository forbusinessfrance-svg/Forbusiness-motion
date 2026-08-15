/**
 * The timeline.
 *
 * `sample(t)` is the single source of animated truth: given a time in seconds it
 * returns the complete state of the film. It is pure — no accumulation, no
 * frame-to-frame state — so the offline renderer can evaluate it 20× per output
 * frame at arbitrary sub-frame instants and get physically consistent results.
 *
 * Values are normalised or expressed in W units. Turning them into transforms is
 * the scene's job, which keeps the choreography readable in one place.
 */

import { TIMING, CAMERA } from '../config.js';
import {
  clamp,
  range,
  lerp,
  EASE,
  expoOut,
  quintOut,
  impulse,
  damped,
  fbm1,
} from './easing.js';

const T = TIMING;

/**
 * @param {number} time seconds
 * @returns {object} the full state of the film at `time`
 */
export function sample(time) {
  const t = clamp(time, 0, T.duration);

  /* ── Type ──────────────────────────────────────────────────────────────
   * Opacity leads, movement follows, and the movement is small enough that
   * you register the arrival rather than the travel. */

  const logoP = expoOut(range(t, T.logo.start, T.logo.end));
  const logotypeP = expoOut(range(t, T.logo.start + 0.07, T.logo.end + 0.07));

  const line = (span) => {
    const p = range(t, span.start, span.end);
    const eased = EASE.reveal(p);
    return {
      /** 0..1 — how much of the line is out from behind its mask. */
      reveal: eased,
      opacity: clamp(range(t, span.start, span.start + (span.end - span.start) * 0.45)),
      /**
       * Vertical travel still to go, in W units. Sized against the line box:
       * roughly half a cap height, which is enough for the letters to be
       * visibly cut by the mask edge on the way up rather than merely fading.
       */
      rise: (1 - eased) * 0.038,
      /** Extra letter-spacing in em, settling to the solved value. */
      tracking: (1 - quintOut(p)) * 0.0085,
    };
  };

  /* ── Board entrance ──────────────────────────────────────────────────── */

  const boardP = EASE.enter(range(t, T.board.start, T.board.end));
  /**
   * The 3D layer resolves out of the page fast — under half a second — while the
   * scale keeps easing for another second. A slow dissolve would leave a
   * translucent ghost of the board on screen, which is the single most reliable
   * way to make a render look like a web page animating.
   */
  const sceneOpacity = expoOut(range(t, T.board.start, T.board.start + 0.32));

  /* ── Dart flight ─────────────────────────────────────────────────────── */

  /**
   * Linear in time. The stage converts this into a position along the
   * trajectory by arc length, which is the only way to control how the dart
   * actually *accelerates*: the curve's own parameter covers wildly uneven
   * distances, so easing it directly would have the dart drifting into the
   * board instead of driving into it.
   */
  const flightP = range(t, T.dart.launch, T.dart.impact);
  const inFlight = t >= T.dart.launch && t < T.dart.impact;
  const landed = t >= T.dart.impact;

  /* ── Impact ──────────────────────────────────────────────────────────── */

  const since = t - T.dart.impact;
  const hit = since >= 0;

  /** Penetration: the point buries itself in ~25 ms and stops dead. */
  const bury = hit ? damped(since, 130) : 0;

  /** The shaft keeps going for an instant, then springs back and settles. */
  const dartPitch = hit ? impulse(since, 0.0295, 8.4, 13.5) : 0;
  const dartYaw = hit ? impulse(since, 0.0092, 11.7, 16.0) : 0;
  /** A whisper of axial recoil as the barrel unloads. */
  const dartRecoil = hit ? impulse(since, 0.0042, 15.0, 22.0) : 0;

  /** The board takes the energy too — half the amplitude, higher frequency. */
  const boardWobbleA = hit ? impulse(since, 0.0104, 10.8, 12.5) : 0;
  const boardWobbleB = hit ? impulse(since, 0.0061, 14.3, 15.5) : 0;
  const boardPush = hit ? impulse(since, 0.0035, 12.0, 16.5) : 0;

  /** Camera shake: two decorrelated noise streams, gone in under 200 ms. */
  const shakeEnv = hit ? Math.exp(-since * 19) * (1 - range(since, T.shake.duration * 0.8, T.shake.duration)) : 0;
  const shakeX = shakeEnv * fbm1(since * CAMERA.shake.frequency) * CAMERA.shake.amplitude;
  const shakeY = shakeEnv * fbm1(since * CAMERA.shake.frequency + 91.3) * CAMERA.shake.amplitude * 0.78;
  const shakeRoll = shakeEnv * fbm1(since * CAMERA.shake.frequency * 0.6 + 210.7) * CAMERA.shake.rotation;

  /* ── Energy at the centre ────────────────────────────────────────────── */

  const rippleP = hit ? range(since, 0, T.ripple.duration) : 0;
  const glowP = hit ? range(since, 0, T.glow.duration) : 0;
  const sparkleP = hit ? range(since, 0, T.sparkle.duration) : 0;
  const sweepP = range(t, T.sweep.start, T.sweep.start + T.sweep.duration);

  /* ── Camera ──────────────────────────────────────────────────────────── */

  const pushP = EASE.camera(range(t, T.push.start, T.push.end));

  return {
    t,

    logo: {
      opacity: logoP,
      typeOpacity: logotypeP,
      rise: (1 - logoP) * 0.0092,
      typeRise: (1 - logotypeP) * 0.0092,
    },

    line1: line(T.line1),
    line2: line(T.line2),

    scene: {
      opacity: sceneOpacity,
    },

    board: {
      /** Settles onto 1.0 — the reference scale — and stays there. */
      scale: lerp(0.955, 1, boardP) + boardPush * 0.35,
      rise: (1 - boardP) * 0.019,
      wobbleA: boardWobbleA,
      wobbleB: boardWobbleB,
      push: boardPush,
    },

    dart: {
      visible: inFlight || landed,
      /** 0 = launch, 1 = point touching the bullseye. Linear in time. */
      progress: inFlight ? flightP : landed ? 1 : 0,
      inFlight,
      landed,
      bury,
      pitch: dartPitch,
      yaw: dartYaw,
      recoil: dartRecoil,
    },

    impact: {
      active: hit,
      since: hit ? since : -1,
      ripple: rippleP,
      glow: glowP,
      sparkle: sparkleP,
      sweep: sweepP > 0 && sweepP < 1 ? sweepP : -1,
      shakeX,
      shakeY,
      shakeRoll,
    },

    camera: {
      /** 1.034 → 1.000: the whole film is one slow, unnoticeable push-in. */
      distance: lerp(CAMERA.pushBack, 1, pushP),
      driftX: lerp(CAMERA.driftX, 0, pushP) + shakeX,
      driftY: lerp(CAMERA.driftY, 0, pushP) + shakeY,
      roll: shakeRoll,
      /** Focus creeps back onto the bullseye as the camera settles. */
      focusOffset: lerp(CAMERA.focusOffsetStart, 0, EASE.camera(range(t, 0.8, 6.4))),
      /** Screen-space parallax applied to the type layer — a fraction of the 3D move. */
      typeScale: lerp(0.9955, 1, pushP),
    },
  };
}
