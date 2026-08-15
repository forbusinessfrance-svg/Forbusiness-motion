/**
 * Easing and interpolation primitives.
 *
 * Everything here is a pure function of time. That is a hard requirement, not a
 * style preference: the offline renderer evaluates the timeline at arbitrary
 * sub-frame instants and out of order, so no animation may depend on integration
 * state or on the previous frame. Physics is therefore analytic (damped
 * oscillators in closed form) rather than stepped.
 */

/* ── Scalar helpers ──────────────────────────────────────────────────────── */

export const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Normalises `t` into 0..1 across [start, end], clamped at both ends. */
export const range = (t, start, end) => clamp((t - start) / (end - start));

/** Hermite smoothstep across [start, end]. */
export function smoothstep(t, start, end) {
  const x = range(t, start, end);
  return x * x * (3 - 2 * x);
}

/* ── Cinematic easing curves ─────────────────────────────────────────────── */

export const quintOut = (t) => 1 - Math.pow(1 - t, 5);

export const expoOut = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

/**
 * Cubic Bézier easing, matching the CSS `cubic-bezier()` definition.
 * Solved with Newton–Raphson and a bisection fallback, so it is exact enough to
 * be indistinguishable from an After Effects graph-editor curve.
 */
export function bezier(x1, y1, x2, y2) {
  const A = (a, b) => 1 - 3 * b + 3 * a;
  const B = (a, b) => 3 * b - 6 * a;
  const C = (a) => 3 * a;
  const calc = (t, a, b) => ((A(a, b) * t + B(a, b)) * t + C(a)) * t;
  const slope = (t, a, b) => 3 * A(a, b) * t * t + 2 * B(a, b) * t + C(a);

  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const d = slope(t, x1, x2);
      if (Math.abs(d) < 1e-6) break;
      const err = calc(t, x1, x2) - x;
      if (Math.abs(err) < 1e-7) return calc(t, y1, y2);
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 20; i++) {
      const err = calc(t, x1, x2) - x;
      if (Math.abs(err) < 1e-7) break;
      if (err > 0) hi = t;
      else lo = t;
      t = (lo + hi) / 2;
    }
    return calc(t, y1, y2);
  };
}

/** The house curves. Slow out, long tail — the Linear/Stripe motion signature. */
export const EASE = {
  /** Type and UI reveals. */
  reveal: bezier(0.16, 0.84, 0.24, 1),
  /** Long camera moves that must never announce themselves. */
  camera: bezier(0.22, 0.68, 0.12, 1),
  /** Objects entering the frame. */
  enter: bezier(0.2, 0.9, 0.25, 1),
};

/* ── Analytic physics ────────────────────────────────────────────────────── */

/**
 * Under-damped oscillator response to an impulse, evaluated in closed form.
 * Returns a signed displacement that starts at 0, swings, and decays to 0.
 *
 * @param {number} t        seconds since the impulse (values < 0 return 0)
 * @param {number} amp      peak displacement
 * @param {number} freq     oscillation frequency in Hz
 * @param {number} damping  decay rate; higher settles faster
 */
export function impulse(t, amp, freq, damping) {
  if (t <= 0) return 0;
  return amp * Math.exp(-damping * t) * Math.sin(2 * Math.PI * freq * t);
}

/**
 * Critically-damped step response: rises from 0 to 1 with no overshoot.
 * The natural choice for anything that must feel weighted but never bouncy.
 */
export function damped(t, rate = 12) {
  if (t <= 0) return 0;
  return 1 - (1 + rate * t) * Math.exp(-rate * t);
}

/* ── Deterministic noise ─────────────────────────────────────────────────── */

/** Hash-based value noise. Stable across runs — required for offline renders. */
export function hash(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

/** Smooth 1D value noise in −1..1. */
export function noise1(x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return (lerp(hash(i), hash(i + 1), u) - 0.5) * 2;
}

/** Fractal noise — three octaves is plenty for camera shake. */
export function fbm1(x, octaves = 3) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += noise1(x * freq + i * 37.4) * amp;
    freq *= 2.03;
    amp *= 0.5;
  }
  return sum;
}
