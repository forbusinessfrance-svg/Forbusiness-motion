/**
 * Procedural studio environment.
 *
 * Black glossy surfaces on a white page are almost entirely *reflection* — what
 * you read as "premium plastic" is the shape of the softboxes bending across the
 * form. So the lighting rig here is a real environment map, built in code as an
 * equirectangular HDR and pre-filtered through PMREM, rather than a handful of
 * point lights. It is what separates a photographic render from a shaded one.
 *
 * Rig: a large overhead diffuser, a broad frontal fill that wraps the rings, a
 * hard key at upper-front-left for the specular streaks on the metal, a cool rim
 * behind-right to detach the silhouette, and a soft floor bounce.
 */

import {
  DataTexture,
  RGBAFormat,
  FloatType,
  LinearFilter,
  EquirectangularReflectionMapping,
  PMREMGenerator,
} from '../../vendor/three.module.min.js';

/** Softbox definitions in spherical coordinates (degrees). */
const PANELS = [
  // Key: upper front left. Tight enough to read as a distinct highlight.
  { azimuth: -46, elevation: 38, radius: 26, softness: 0.55, intensity: 5.6, tint: [1, 0.995, 0.985] },
  // Broad frontal fill — this is what opens up the black rings.
  { azimuth: 8, elevation: 12, radius: 62, softness: 0.95, intensity: 1.5, tint: [1, 1, 1] },
  // Rim: behind and to the right, slightly cool, detaches the edge.
  { azimuth: 132, elevation: 30, radius: 34, softness: 0.7, intensity: 3.1, tint: [0.94, 0.96, 1] },
  // Kicker under the front left, keeps the lower rim from going dead.
  { azimuth: -70, elevation: -22, radius: 40, softness: 0.9, intensity: 0.85, tint: [1, 1, 1] },
];

const DEG = Math.PI / 180;

/** Overall diffuse level of the set. Tuned against the reference's ring values. */
const AMBIENT_GAIN = 1.72;

function panelDirection(azimuth, elevation) {
  const a = azimuth * DEG;
  const e = elevation * DEG;
  const c = Math.cos(e);
  return [Math.sin(a) * c, Math.sin(e), Math.cos(a) * c];
}

/**
 * Builds the equirectangular HDR as raw float data.
 * @param {number} width
 * @param {number} height
 */
function buildEquirect(width, height) {
  const data = new Float32Array(width * height * 4);
  const panels = PANELS.map((p) => ({ ...p, dir: panelDirection(p.azimuth, p.elevation) }));

  for (let y = 0; y < height; y++) {
    // v = 0 at the zenith.
    const phi = ((y + 0.5) / height) * Math.PI;
    const sinPhi = Math.sin(phi);
    const dirY = Math.cos(phi);

    for (let x = 0; x < width; x++) {
      const theta = ((x + 0.5) / width) * Math.PI * 2 - Math.PI;
      const dirX = sinPhi * Math.sin(theta);
      const dirZ = sinPhi * Math.cos(theta);

      // Base gradient: bright ceiling, luminous horizon, white floor bounce.
      // AMBIENT_GAIN sets the diffuse level of the whole set — it is what makes
      // the white rings read as printed white rather than as shaded grey. The
      // panels below are deliberately left out of it so raising the fill never
      // blows the speculars.
      const up = dirY * 0.5 + 0.5;
      let r = (0.3 + Math.pow(up, 1.35) * 0.92) * AMBIENT_GAIN;
      let g = r;
      let b = r + Math.pow(up, 2.4) * 0.03 * AMBIENT_GAIN;

      // A little extra light straight ahead so the front of the disc is open.
      const front = Math.max(0, dirZ);
      const frontal = Math.pow(front, 2.0) * 0.22 * AMBIENT_GAIN;
      r += frontal;
      g += frontal;
      b += frontal;

      for (const p of panels) {
        const dot = dirX * p.dir[0] + dirY * p.dir[1] + dirZ * p.dir[2];
        const angle = Math.acos(Math.min(1, Math.max(-1, dot))) / DEG;
        if (angle > p.radius) continue;
        // Smooth falloff toward the edge of the panel — a real softbox has no hard rim.
        const edge = 1 - angle / p.radius;
        const falloff = Math.pow(edge, 1 + p.softness * 3);
        const v = falloff * p.intensity;
        r += v * p.tint[0];
        g += v * p.tint[1];
        b += v * p.tint[2];
      }

      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 1;
    }
  }
  return data;
}

/**
 * Creates the pre-filtered environment. Call once; the result is reused for the
 * whole session and disposed with the renderer.
 *
 * @param {import('../../vendor/three.module.min.js').WebGLRenderer} renderer
 * @returns {import('../../vendor/three.module.min.js').Texture}
 */
export function createStudioEnvironment(renderer) {
  const width = 512;
  const height = 256;

  const texture = new DataTexture(buildEquirect(width, height), width, height, RGBAFormat, FloatType);
  texture.mapping = EquirectangularReflectionMapping;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  const pmrem = new PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const target = pmrem.fromEquirectangular(texture);

  texture.dispose();
  pmrem.dispose();

  return target.texture;
}
