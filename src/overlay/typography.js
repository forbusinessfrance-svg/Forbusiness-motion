/**
 * The type layer.
 *
 * The logo and headline are drawn with Canvas2D at the master's native
 * resolution and composited over the render as screen-space sprites. Keeping
 * them out of the 3D pass is deliberate: type that goes through the accumulation
 * buffer picks up the sample jitter and softens, and at 4K the difference
 * between "sharp" and "very nearly sharp" is the whole impression.
 *
 * Sizing is width-anchored. Each string is set at a probe size, its *ink* extent
 * is measured, and the size is solved so the ink lands exactly on the measured
 * width from the reference. Cap height and leading then fall out of the font's
 * metrics rather than being asserted, so the type can never end up subtly
 * mis-proportioned against itself.
 *
 * Only the two headline lines are redrawn during their reveal (the tracking
 * animates). Once the type has settled, nothing is re-rasterised and nothing is
 * re-uploaded — the layer costs four textured quads a frame.
 */

import {
  CanvasTexture,
  DoubleSide,
  LinearFilter,
  Mesh,
  NoColorSpace,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector4,
} from '../../vendor/three.module.min.js';
import { BRAND } from '../config.js';

const DISPLAY_FAMILY = 'FBF Display';
const TEXT_FAMILY = 'FBF Text';

/* ─────────────────────────────────────────────────────────────────────────────
 * Font loading
 * ────────────────────────────────────────────────────────────────────────── */

let fontsReady = null;

/**
 * Loads the two Inter cuts. Resolves to `false` if the browser blocks them.
 *
 * The single-file build injects `__FBF_FONTS` with the two faces as data URIs,
 * so the bundle carries its own type and runs straight off `file://`, where a
 * relative font fetch would be blocked.
 */
export function loadFonts(base = '') {
  if (fontsReady) return fontsReady;
  const embedded = globalThis.__FBF_FONTS;
  const displaySource = embedded?.display ?? `${base}fonts/InterDisplay-ExtraBold.woff2`;
  const textSource = embedded?.text ?? `${base}fonts/Inter-Bold.woff2`;

  fontsReady = (async () => {
    try {
      const display = new FontFace(
        DISPLAY_FAMILY,
        `url(${displaySource}) format('woff2')`,
        { weight: '800', style: 'normal', display: 'block' }
      );
      const text = new FontFace(
        TEXT_FAMILY,
        `url(${textSource}) format('woff2')`,
        { weight: '700', style: 'normal', display: 'block' }
      );
      await Promise.all([display.load(), text.load()]);
      document.fonts.add(display);
      document.fonts.add(text);
      await document.fonts.ready;
      return true;
    } catch (error) {
      console.warn('[typography] font load failed, falling back to system type', error);
      return false;
    }
  })();
  return fontsReady;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Measuring
 * ────────────────────────────────────────────────────────────────────────── */

const probeCanvas =
  typeof document !== 'undefined' ? document.createElement('canvas') : null;
const probe = probeCanvas ? probeCanvas.getContext('2d') : null;

/** True when the engine honours `ctx.letterSpacing`; otherwise we space by hand. */
const HAS_LETTER_SPACING = (() => {
  if (!probe) return false;
  probe.letterSpacing = '4px';
  const ok = probe.letterSpacing === '4px';
  probe.letterSpacing = '0px';
  return ok;
})();

function setFont(ctx, family, weight, sizePx, trackingEm) {
  ctx.font = `${weight} ${sizePx}px "${family}", "Helvetica Neue", Arial, sans-serif`;
  if (HAS_LETTER_SPACING) {
    ctx.letterSpacing = `${trackingEm * sizePx}px`;
  }
}

/**
 * Ink extents of a string: how far the glyphs actually reach either side of the
 * alignment point. Trailing letter-spacing is excluded by construction, which is
 * why this is measured rather than taken from `metrics.width`.
 */
function measureInk(ctx, text, family, weight, sizePx, trackingEm) {
  setFont(ctx, family, weight, sizePx, trackingEm);
  if (HAS_LETTER_SPACING) {
    const m = ctx.measureText(text);
    return {
      left: m.actualBoundingBoxLeft,
      right: m.actualBoundingBoxRight,
      width: m.actualBoundingBoxLeft + m.actualBoundingBoxRight,
      ascent: m.actualBoundingBoxAscent,
      descent: m.actualBoundingBoxDescent,
    };
  }
  // Manual tracking: walk the glyphs and accumulate advances.
  let x = 0;
  let ascent = 0;
  let descent = 0;
  let left = 0;
  let right = 0;
  for (let i = 0; i < text.length; i++) {
    const m = ctx.measureText(text[i]);
    if (i === 0) left = m.actualBoundingBoxLeft;
    right = x + m.actualBoundingBoxRight;
    ascent = Math.max(ascent, m.actualBoundingBoxAscent);
    descent = Math.max(descent, m.actualBoundingBoxDescent);
    x += m.width + trackingEm * sizePx;
  }
  return { left, right, width: left + right, ascent, descent };
}

/**
 * Advance width — where the *next* glyph's origin lands. Ink extents are wrong
 * for this: they stop at the last glyph's outline and would tuck the following
 * character under its side bearing.
 */
function measureAdvance(ctx, text, family, weight, sizePx, trackingEm) {
  setFont(ctx, family, weight, sizePx, trackingEm);
  if (HAS_LETTER_SPACING) {
    // Engine letter-spacing is applied after every glyph, the trailing one included.
    return ctx.measureText(text).width;
  }
  let x = 0;
  for (const ch of text) x += ctx.measureText(ch).width + trackingEm * sizePx;
  return x;
}

/** Draws a string honouring the tracking, with or without engine support. */
function fillTracked(ctx, text, x, y, family, weight, sizePx, trackingEm) {
  setFont(ctx, family, weight, sizePx, trackingEm);
  if (HAS_LETTER_SPACING) {
    ctx.fillText(text, x, y);
    return;
  }
  let cursor = x;
  for (const ch of text) {
    ctx.fillText(ch, cursor, y);
    cursor += ctx.measureText(ch).width + trackingEm * sizePx;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Sprite
 * ────────────────────────────────────────────────────────────────────────── */

const SPRITE_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying float vWorldY;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldY = world.y;
    gl_Position = projectionMatrix * viewMatrix * world;
  }`;

const SPRITE_FRAGMENT = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uOpacity;
  uniform vec2 uClip;
  varying vec2 vUv;
  varying float vWorldY;
  void main() {
    vec4 c = texture2D(uMap, vUv);
    // Screen-space mask: the reveal edge stays put while the type slides up
    // through it, which is what makes it read as a mask rather than a fade.
    float mask = step(uClip.x, vWorldY) * step(vWorldY, uClip.y);
    gl_FragColor = vec4(c.rgb, c.a * uOpacity * mask);
    if (gl_FragColor.a <= 0.0) discard;
  }`;

class Sprite {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = NoColorSpace;
    this.texture.flipY = false;
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.generateMipmaps = false;

    this.material = new ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      // The overlay camera has its Y axis flipped so layout coordinates can run
      // top-down; that inverts the winding, so face culling has to come off.
      side: DoubleSide,
      uniforms: {
        uMap: { value: this.texture },
        uOpacity: { value: 1 },
        uClip: { value: new Vector2(-1e3, 1e3) },
      },
      vertexShader: SPRITE_VERTEX,
      fragmentShader: SPRITE_FRAGMENT,
    });

    this.mesh = new Mesh(new PlaneGeometry(1, 1), this.material);
    /** Rect in W units: x, y, width, height (y grows downward). */
    this.rect = new Vector4(0, 0, 1, 1);
  }

  /** Places the quad from its W-unit rect. */
  place(offsetY = 0) {
    const r = this.rect;
    this.mesh.position.set(r.x + r.z / 2, r.y + r.w / 2 + offsetY, 0);
    this.mesh.scale.set(r.z, r.w, 1);
  }

  context(pixelsPerUnit, padding = 0) {
    const r = this.rect;
    const w = Math.max(1, Math.round((r.z + padding * 2) * pixelsPerUnit));
    const h = Math.max(1, Math.round((r.w + padding * 2) * pixelsPerUnit));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.textBaseline = 'alphabetic';
    return ctx;
  }

  commit() {
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Typography
 * ────────────────────────────────────────────────────────────────────────── */

export class Typography {
  constructor() {
    this.scene = new Scene();
    this.camera = new OrthographicCamera(0, 1, 0, 1, -1, 1);

    this.mark = new Sprite();
    this.logotype = new Sprite();
    this.line1 = new Sprite();
    this.line2 = new Sprite();

    for (const s of [this.mark, this.logotype, this.line1, this.line2]) {
      this.scene.add(s.mesh);
    }

    this.layout = null;
    this.pixelsPerUnit = 1080;
    this.metrics = null;
    this._lastTracking = [NaN, NaN];
  }

  /**
   * Solves type metrics from the reference's measured widths.
   * @returns {{capHeight:number, leading:number, logoCapHeight:number}} in W units
   */
  measureMetrics(layoutBase) {
    if (!probe) return {};
    const h = layoutBase.headline;
    const l = layoutBase.logotype;

    // Everything is measured at a large probe size and scaled into W units.
    // Measuring at the solved size directly would ask the engine for metrics at
    // a fraction of a pixel, where they quantise into nonsense.
    const probeSize = 400;

    const inkLine2 = measureInk(probe, h.line2, DISPLAY_FAMILY, h.weight, probeSize, h.tracking);
    const size = (probeSize * h.measure) / inkLine2.width;
    const scale = size / probeSize;

    const caps = measureInk(probe, 'H', DISPLAY_FAMILY, h.weight, probeSize, 0);
    const desc = measureInk(probe, 'qp', DISPLAY_FAMILY, h.weight, probeSize, 0);
    const inkLine1 = measureInk(probe, h.line1, DISPLAY_FAMILY, h.weight, probeSize, h.tracking);

    const inkLogo = measureInk(probe, l.text, TEXT_FAMILY, l.weight, probeSize, l.tracking);
    const logoSize = (probeSize * l.width) / inkLogo.width;
    const logoCaps = measureInk(probe, 'F', TEXT_FAMILY, l.weight, probeSize, 0);

    this.metrics = {
      size,
      capHeight: caps.ascent * scale,
      descent: desc.descent * scale,
      leading: size * h.leadingEm,
      /** Where line 1 ends — reported so the composition can be checked. */
      line1Width: inkLine1.width * scale,
      logoSize,
      logoCapHeight: (logoCaps.ascent * logoSize) / probeSize,
    };
    return this.metrics;
  }

  /**
   * Rebuilds every sprite for a new layout or output resolution.
   * @param {ReturnType<import('../config.js').resolveLayout>} layout
   * @param {number} widthPx render width in device pixels
   */
  build(layout, widthPx) {
    this.layout = layout;
    this.pixelsPerUnit = widthPx;

    this.camera.left = 0;
    this.camera.right = 1;
    this.camera.top = 0;
    this.camera.bottom = layout.height;
    this.camera.updateProjectionMatrix();

    if (!this.metrics) this.measureMetrics(layout);

    this._buildMark();
    this._buildLogotype();
    this._buildLine('line1', layout.headline.line1, layout.headline.baseline1, layout.headline.tracking);
    this._buildLine('line2', layout.headline.line2, layout.headline.baseline2, layout.headline.tracking);
    this._lastTracking = [layout.headline.tracking, layout.headline.tracking];
  }

  /**
   * The mark: two stacked lobes sharing a left edge — the stylised B.
   */
  _buildMark() {
    const m = this.layout.mark;
    const s = this.mark;
    s.rect.set(m.left, m.top, m.width, m.height);
    s.place();

    const ppu = this.pixelsPerUnit;
    const ctx = s.context(ppu);
    const w = m.width * ppu;
    const h = m.height * ppu;
    const gap = h * 0.115;
    const lobe = (h - gap) / 2;
    const radius = lobe * 0.42;

    ctx.fillStyle = BRAND.ink;
    roundedRect(ctx, 0, 0, w * 0.855, lobe, radius);
    ctx.fill();
    roundedRect(ctx, 0, lobe + gap, w, lobe, radius);
    ctx.fill();
    s.commit();
  }

  _buildLogotype() {
    const l = this.layout.logotype;
    const s = this.logotype;
    const size = this.metrics.logoSize;
    const ascent = this.metrics.logoCapHeight;
    const descent = size * 0.24;

    // A little air around the ink so antialiased edges are never clipped.
    const pad = size * 0.08;
    const top = l.baseline - ascent * 1.18;
    const height = ascent * 1.18 + descent;
    s.rect.set(l.left - pad, top, l.width * 1.02 + pad * 2, height);
    s.place();

    const ppu = this.pixelsPerUnit;
    const ctx = s.context(ppu);
    const baselineY = (l.baseline - top) * ppu;
    const sizePx = size * ppu;

    const black = l.text.slice(0, l.accentFrom);
    const accent = l.text.slice(l.accentFrom);

    // Align the ink's left edge to the margin, not the glyph origin.
    const ink = measureInk(ctx, l.text, TEXT_FAMILY, l.weight, sizePx, l.tracking);
    const x = pad * ppu + ink.left;

    ctx.fillStyle = BRAND.ink;
    fillTracked(ctx, black, x, baselineY, TEXT_FAMILY, l.weight, sizePx, l.tracking);

    const advance = measureAdvance(ctx, black, TEXT_FAMILY, l.weight, sizePx, l.tracking);
    ctx.fillStyle = BRAND.blue;
    fillTracked(ctx, accent, x + advance, baselineY, TEXT_FAMILY, l.weight, sizePx, l.tracking);
    s.commit();
  }

  /**
   * A headline line. The sprite box is the line's optical box: the mask edge
   * that the reveal slides through is the bottom of this box.
   */
  _buildLine(key, text, baseline, tracking) {
    const h = this.layout.headline;
    const s = this[key];
    const size = this.metrics.size;
    const cap = this.metrics.capHeight;
    const descent = this.metrics.descent;

    const pad = size * 0.06;
    const top = baseline - cap * 1.14;
    const height = cap * 1.14 + descent * 1.12;
    // Generous width: negative tracking only ever shrinks the ink.
    s.rect.set(h.left - pad, top, h.measure * 1.04 + pad * 2, height);
    s.place();

    const ppu = this.pixelsPerUnit;
    const ctx = s.context(ppu);
    const sizePx = size * ppu;
    const baselineY = (baseline - top) * ppu;

    const ink = measureInk(ctx, text, DISPLAY_FAMILY, h.weight, sizePx, tracking);
    const x = pad * ppu + ink.left;

    // "qui convertissent." is blue with a black full stop; "Des leads" is black.
    const isBlue = key === 'line2';
    if (isBlue && text.endsWith('.')) {
      const body = text.slice(0, -1);
      ctx.fillStyle = BRAND.blue;
      fillTracked(ctx, body, x, baselineY, DISPLAY_FAMILY, h.weight, sizePx, tracking);
      const advance = measureAdvance(ctx, body, DISPLAY_FAMILY, h.weight, sizePx, tracking);
      ctx.fillStyle = BRAND.ink;
      fillTracked(ctx, '.', x + advance, baselineY, DISPLAY_FAMILY, h.weight, sizePx, tracking);
    } else {
      ctx.fillStyle = isBlue ? BRAND.blue : BRAND.ink;
      fillTracked(ctx, text, x, baselineY, DISPLAY_FAMILY, h.weight, sizePx, tracking);
    }
    s.commit();
  }

  /** @param {object} state frame state from the timeline */
  update(state) {
    const layout = this.layout;
    if (!layout) return;

    const scale = state.camera.typeScale;
    // The type layer parallaxes with the camera, but at a fraction of the 3D
    // move — enough to feel connected, never enough to soften the glyphs.
    const centreY = layout.height / 2;
    this.camera.left = 0.5 - 0.5 / scale;
    this.camera.right = 0.5 + 0.5 / scale;
    this.camera.top = centreY - centreY / scale;
    this.camera.bottom = centreY + centreY / scale;
    this.camera.updateProjectionMatrix();

    this.mark.material.uniforms.uOpacity.value = state.logo.opacity;
    this.mark.place(state.logo.rise);
    this.logotype.material.uniforms.uOpacity.value = state.logo.typeOpacity;
    this.logotype.place(state.logo.typeRise);

    this._updateLine('line1', state.line1);
    this._updateLine('line2', state.line2);
  }

  _updateLine(key, s) {
    const sprite = this[key];
    const base = sprite.rect;
    sprite.material.uniforms.uOpacity.value = s.opacity;
    // The mask is the line's own box, held still in screen space.
    sprite.material.uniforms.uClip.value.set(base.y, base.y + base.w);
    sprite.place(s.rise);

    // Re-rasterise only while the tracking is still settling.
    const index = key === 'line1' ? 0 : 1;
    const tracking = this.layout.headline.tracking + s.tracking;
    if (Math.abs(tracking - this._lastTracking[index]) > 0.0002) {
      this._lastTracking[index] = tracking;
      const baseline =
        key === 'line1' ? this.layout.headline.baseline1 : this.layout.headline.baseline2;
      const text = key === 'line1' ? this.layout.headline.line1 : this.layout.headline.line2;
      this._buildLine(key, text, baseline, tracking);
      sprite.place(s.rise);
    }
  }

  /**
   * Composites the type over whatever is already in the target.
   * @param {import('../../vendor/three.module.min.js').WebGLRenderer} renderer
   */
  render(renderer) {
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.scene, this.camera);
    renderer.autoClear = autoClear;
  }

  dispose() {
    for (const s of [this.mark, this.logotype, this.line1, this.line2]) s.dispose();
  }
}

function roundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}
