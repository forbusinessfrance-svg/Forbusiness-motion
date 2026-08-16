/**
 * FORBUSINESSFRANCE — "Des leads qui convertissent."
 * Single source of truth for the whole production.
 *
 * ── UNIT SYSTEM ────────────────────────────────────────────────────────────
 * Every layout number below is expressed in *W units*: a fraction of the frame
 * width. This is what makes the composition resolution-independent and lets the
 * same numbers drive the 9:16 delivery master and the 3:4 reference-match crop.
 *
 * The world-space unit of the 3D scene is also 1.0 = frame width, so a board
 * radius of 0.275 in this file is 0.275 world units and covers 27.5% of the
 * frame width at z = 0. Screen layout and 3D layout share one coordinate space.
 *
 * All values were measured off the reference still and are the source of truth
 * for fidelity. Nothing else in the codebase hardcodes a position.
 */

/* ─────────────────────────────────────────────────────────────────────────────
 * BRAND
 * ────────────────────────────────────────────────────────────────────────── */

export const BRAND = {
  /** Electric blue — headline accent, bullseye, impact energy. */
  blue: '#1B2CFF',
  /** Near-black used for type and the logotype. Never pure #000. */
  ink: '#0A0A0B',
  paper: '#FFFFFF',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * DELIVERY FORMATS
 * ────────────────────────────────────────────────────────────────────────── */

export const FORMATS = {
  /** Delivery master. */
  '9:16': {
    aspect: 9 / 16,
    /** Distance from the top of the frame to the top of the logo mark. */
    blockTop: 0.34,
    master: [2160, 3840],
  },
  /** Reference-match crop: identical to the source still's 3:4 framing. */
  '3:4': {
    aspect: 3 / 4,
    blockTop: 0.0663,
    master: [1620, 2160],
  },
};

/* ─────────────────────────────────────────────────────────────────────────────
 * LAYOUT — measured from the reference still
 * ────────────────────────────────────────────────────────────────────────── */

const LAYOUT_BASE = {
  /** Logo mark (the stacked "B" glyph). */
  mark: {
    left: 0.0527,
    width: 0.0313,
    height: 0.0425,
  },
  /**
   * Logotype "ForBusinessfrance.fr." — the trailing period is blue.
   *
   * Type is *width-anchored*: the engine solves the point size that makes the
   * string span its measured width, and the cap height falls out of the font's
   * own metrics. Horizontal extents are the part of the reference that can be
   * measured unambiguously, and they are what sets the composition's rhythm —
   * so they are the constraint, and everything vertical follows from them.
   */
  logotype: {
    left: 0.1088,
    width: 0.2976,
    tracking: -0.012,
    weight: 700,
    text: 'ForBusinessfrance.fr.',
    /** The final period carries the accent colour. */
    accentFrom: 20,
  },
  /** Headline block. */
  headline: {
    left: 0.0578,
    /** Gap between the bottom of the logo mark and the headline's cap height. */
    gapFromMark: 0.214,
    /** Line 2 spans the full measure, margin to margin — the size anchor. */
    measure: 0.894,
    tracking: -0.022,
    /** Baseline-to-baseline, as a multiple of the size. Tight, display-style. */
    leadingEm: 0.945,
    weight: 800,
    line1: 'Des leads',
    line2: 'qui convertissent.',
    /** Fallbacks in W units, used before the font has loaded. */
    fallbackCapHeight: 0.0778,
    fallbackLeading: 0.101,
  },
  /** 3D board. */
  board: {
    centerX: 0.4975,
    /** Distance from the second baseline down to the bullseye. */
    offsetFromBaseline: 0.3333,
    radius: 0.275,
  },
};

/**
 * Resolves the format-independent measurements into absolute W-unit positions.
 *
 * @param {keyof typeof FORMATS} formatKey
 * @param {{capHeight?: number, leading?: number, logoCapHeight?: number}} [metrics]
 *   Real type metrics in W units, supplied by the type engine once the font has
 *   loaded. The board hangs off the second baseline, so it moves with the type
 *   rather than drifting away from it.
 */
export function resolveLayout(formatKey = '9:16', metrics = {}) {
  const format = FORMATS[formatKey];
  const L = LAYOUT_BASE;

  const capHeight = metrics.capHeight ?? L.headline.fallbackCapHeight;
  const leading = metrics.leading ?? L.headline.fallbackLeading;

  const markTop = format.blockTop;
  const markBottom = markTop + L.mark.height;
  const capTop = markBottom + L.headline.gapFromMark;
  const baseline1 = capTop + capHeight;
  const baseline2 = baseline1 + leading;
  const boardCenterY = baseline2 + L.board.offsetFromBaseline;

  return {
    format: formatKey,
    aspect: format.aspect,
    /** Frame height in W units. */
    height: 1 / format.aspect,
    master: format.master,

    mark: { ...L.mark, top: markTop },
    logotype: {
      ...L.logotype,
      /** Baseline sits optically centred on the mark. */
      baseline:
        markTop + L.mark.height * 0.5 + (metrics.logoCapHeight ?? 0.0221) * 0.5,
    },
    headline: {
      ...L.headline,
      capHeight,
      leading,
      capTop,
      baseline1,
      baseline2,
    },
    board: {
      ...L.board,
      centerY: boardCenterY,
    },
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * BOARD — geometry + orientation
 *
 * Ring stops are normalised radii (0 = bullseye, 1 = outer edge). Colours
 * alternate ink / paper outward from the blue centre, matching the reference.
 * ────────────────────────────────────────────────────────────────────────── */

export const BOARD = {
  /** Outer radius as a multiple of the layout radius (always 1 — kept for clarity). */
  rings: [
    { to: 0.15, color: 'blue' },
    { to: 0.32, color: 'ink' },
    { to: 0.475, color: 'paper' },
    { to: 0.645, color: 'ink' },
    { to: 0.8, color: 'paper' },
    { to: 1.0, color: 'ink' },
  ],
  /** Disc thickness, as a fraction of the radius. */
  thickness: 0.14,
  /** Fillet radius on the front and back edges, as a fraction of the radius. */
  bevel: 0.026,

  /**
   * Orientation, in degrees. The board leans back at the top (−X) and turns its
   * left edge away (+Y), so the face normal points up-and-right toward camera
   * and the side wall reads along the lower-left arc — exactly as referenced.
   */
  tiltX: -12.0,
  tiltY: 24.0,
  rollZ: -8.0,

  material: {
    // Near-black and near-white albedos. The rings must read as *print* — the
    // separation in the reference is absolute, and any mid-grey reads as a
    // shaded object rather than a printed one.
    inkColor: 0x0b0c0e,
    paperColor: 0xf6f6f8,
    blueColor: 0x1b2cff,
    roughness: 0.255,
    /** Bullseye reads slightly wetter than the printed rings. */
    blueRoughness: 0.185,
    // Restrained specular: the white rings are carried by diffuse, the black
    // ones almost entirely by reflection, so this value *is* the black level.
    clearcoat: 0.3,
    clearcoatRoughness: 0.16,
    specularIntensity: 0.5,
    envIntensity: 1.55,
  },
};

/* ─────────────────────────────────────────────────────────────────────────────
 * DART — anatomy + flight
 * ────────────────────────────────────────────────────────────────────────── */

export const DART = {
  /** Total length as a multiple of the board radius. */
  length: 1.5,
  /** Component lengths, normalised to sum to 1. */
  parts: {
    point: 0.208,
    barrel: 0.362,
    stem: 0.152,
    flight: 0.278,
  },
  barrelRadius: 0.04,
  /** Knurl grooves cut into the barrel. */
  grooves: 15,
  flight: {
    /** Wing span, as a multiple of the dart length. */
    span: 0.124,
    wings: 4,
    /** Roll of the whole flight assembly, degrees. */
    roll: 24,
  },

  /**
   * Resting attitude: where the dart sits once planted, expressed as the screen
   * angle of its axis (degrees, CCW from +X) and how far that axis tips out of
   * the screen plane toward camera.
   */
  screenAngle: 50.0,
  depthAngle: 26.0,

  /**
   * The throw comes in low and from the right, then steepens onto the resting
   * axis as it arrives. Keeping the entry shallow is what stops the dart from
   * crossing the headline on its way in — in the reference the type is never
   * touched, and the type layer composites over the render, so a dart that
   * crossed it would be occluded by it.
   */
  launchScreenAngle: 26.0,
  launchDepthAngle: 30.0,
  /** Where the throw starts, in board radii. */
  launchDistance: 3.8,
  /**
   * Shapes the approach: the distance still to run falls as (1 - p)^n, so
   * values below 1 keep the dart accelerating right up to contact.
   */
  approachExponent: 0.62,

  material: {
    steelColor: 0xcbcfd6,
    pointColor: 0x9fa4ac,
    plasticColor: 0x0e0e10,
    flightColor: 0x090a0c,
    steelRoughness: 0.23,
  },
};

/* ─────────────────────────────────────────────────────────────────────────────
 * TIMELINE — 7.00 s
 * ────────────────────────────────────────────────────────────────────────── */

export const TIMING = {
  duration: 7.0,
  fps: 60,

  logo: { start: 0.15, end: 0.9 },
  line1: { start: 0.55, end: 1.5 },
  line2: { start: 0.67, end: 1.62 },
  board: { start: 1.15, end: 2.4 },

  /** Dart leaves frame-right and crosses to the bullseye. */
  dart: { launch: 2.44, impact: 2.98 },

  /** Post-impact physics. */
  shake: { duration: 0.19 },
  wobble: { duration: 0.46 },
  ripple: { duration: 0.58 },
  glow: { duration: 0.34 },
  sparkle: { duration: 0.55 },
  sweep: { start: 3.04, duration: 0.34 },

  /** One continuous, almost invisible push-in that lands on the reference framing. */
  push: { start: 0.0, end: 6.4 },
};

/* ─────────────────────────────────────────────────────────────────────────────
 * CAMERA
 * ────────────────────────────────────────────────────────────────────────── */

export const CAMERA = {
  /** Long lens: near-orthographic perspective, the way product shots are lensed. */
  fov: 22,
  /** Framing at t = end. The push-in starts this much wider. */
  pushBack: 1.034,
  /** Lateral parallax offset at t = 0, eased to zero. */
  driftX: -0.0075,
  driftY: 0.0045,

  /** Thin-lens aperture radius in world units. Drives the accumulation DOF. */
  aperture: 0.0026,
  /** Focus breathing: focal plane starts this far in front of the bullseye. */
  focusOffsetStart: 0.075,

  shake: { amplitude: 0.0038, rotation: 0.0022, frequency: 34 },
};

/* ─────────────────────────────────────────────────────────────────────────────
 * RENDER QUALITY
 * ────────────────────────────────────────────────────────────────────────── */

export const QUALITY = {
  /** Accumulation samples per output frame. More = smoother blur/DOF/AA. */
  preview: 5,
  master: 20,
  /** Shutter angle in degrees. 180° is the cinema standard. */
  shutter: 180,
  /** Film grain strength, applied after tone response. Barely there by design. */
  grain: 0.0042,
  shadow: {
    resolution: 1024,
    blur: 1.7,
    darkness: 0.95,
    opacity: 0.62,
  },
};
