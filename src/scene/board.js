/**
 * The target.
 *
 * Two decisions carry the realism here:
 *
 * 1. The disc is a real surface of revolution with filleted edges, generated
 *    analytically. The fillets are what catch the key light and read as
 *    "machined object" rather than "extruded circle".
 *
 * 2. The rings are evaluated procedurally in the fragment shader from the
 *    object-space radius, antialiased with `fwidth`. No texture is involved, so
 *    the edges stay mathematically sharp at 4K — and combined with the
 *    renderer's sample jitter they resolve cleaner than any bitmap could.
 *
 * The impact ripple lives in this same shader. Driving it from the surface's own
 * radius means it is perfectly registered to the board under any camera move,
 * with correct lighting and no coplanar-geometry fighting.
 */

import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshPhysicalMaterial,
  Color,
  Vector3,
} from '../../vendor/three.module.min.js';
import { BOARD } from '../config.js';

/* ─────────────────────────────────────────────────────────────────────────────
 * Geometry: a filleted disc revolved around +Z
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * @param {object} o
 * @param {number} o.radius      outer radius
 * @param {number} o.thickness   total thickness
 * @param {number} o.bevel       fillet radius on both edges
 * @param {number} [o.segments]  radial subdivisions around the axis
 */
function buildDiscGeometry({ radius: R, thickness: h, bevel: b, segments = 512 }) {
  /** Profile in (r, z) with its 2D normal, walked front-centre → rim → back-centre. */
  const profile = [];
  const push = (r, z, nr, nz) => profile.push({ r, z, nr, nz });

  const halfH = h / 2;
  const faceSteps = 20;
  const filletSteps = 14;

  // Front face.
  for (let i = 0; i <= faceSteps; i++) {
    // Bias samples outward: the interesting shading is near the rim.
    const t = Math.pow(i / faceSteps, 1.35);
    push(t * (R - b), halfH, 0, 1);
  }
  // Front fillet: tangent to the face at 90°, tangent to the wall at 0°.
  for (let i = 1; i <= filletSteps; i++) {
    const a = (Math.PI / 2) * (1 - i / filletSteps);
    const nr = Math.cos(a);
    const nz = Math.sin(a);
    push(R - b + b * nr, halfH - b + b * nz, nr, nz);
  }
  // Side wall.
  push(R, -halfH + b, 1, 0);
  // Back fillet.
  for (let i = 1; i <= filletSteps; i++) {
    const a = (Math.PI / 2) * (i / filletSteps);
    const nr = Math.cos(a);
    const nz = -Math.sin(a);
    push(R - b + b * nr, -halfH + b + b * nz, nr, nz);
  }
  // Back face.
  for (let i = 1; i <= 4; i++) {
    push((R - b) * (1 - i / 4), -halfH, 0, -1);
  }

  const rows = profile.length;
  const cols = segments + 1;
  const positions = new Float32Array(rows * cols * 3);
  const normals = new Float32Array(rows * cols * 3);
  const uvs = new Float32Array(rows * cols * 2);

  for (let ri = 0; ri < rows; ri++) {
    const p = profile[ri];
    for (let ci = 0; ci < cols; ci++) {
      const a = (ci / segments) * Math.PI * 2;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const i3 = (ri * cols + ci) * 3;
      positions[i3] = p.r * cos;
      positions[i3 + 1] = p.r * sin;
      positions[i3 + 2] = p.z;
      normals[i3] = p.nr * cos;
      normals[i3 + 1] = p.nr * sin;
      normals[i3 + 2] = p.nz;
      const i2 = (ri * cols + ci) * 2;
      uvs[i2] = ci / segments;
      uvs[i2 + 1] = 1 - ri / (rows - 1);
    }
  }

  const indices = [];
  for (let ri = 0; ri < rows - 1; ri++) {
    for (let ci = 0; ci < segments; ci++) {
      const a = ri * cols + ci;
      const bIdx = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices.push(a, c, bIdx);
      indices.push(bIdx, c, d);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Material
 * ────────────────────────────────────────────────────────────────────────── */

function createBoardMaterial(radius) {
  const m = BOARD.material;
  const material = new MeshPhysicalMaterial({
    color: new Color(m.inkColor),
    roughness: m.roughness,
    metalness: 0.0,
    clearcoat: m.clearcoat,
    clearcoatRoughness: m.clearcoatRoughness,
    specularIntensity: m.specularIntensity,
    envMapIntensity: m.envIntensity,
  });

  const stops = BOARD.rings.map((r) => r.to);

  material.userData.uniforms = {
    uRadius: { value: radius },
    uInk: { value: new Color(m.inkColor) },
    uPaper: { value: new Color(m.paperColor) },
    uBlue: { value: new Color(m.blueColor) },
    uRoughRing: { value: m.roughness },
    uRoughBlue: { value: m.blueRoughness },
    uStops: { value: new Float32Array(stops) },
    /** x: radius, y: width, z: opacity, w: surface displacement amplitude */
    uRipple: { value: [0, 0.05, 0, 0] },
    /** Emissive bloom at the bullseye right after the hit. */
    uGlow: { value: 0 },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, material.userData.uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec2 vLocalXY;
         varying vec3 vRadialView;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vLocalXY = position.xy;
         // View-space outward direction, carried down for the ripple's normal
         // perturbation — the fragment stage has no model-view matrix.
         vRadialView = normalize(mat3(modelViewMatrix) * vec3(position.xy, 0.0001));`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec2 vLocalXY;
         varying vec3 vRadialView;
         uniform float uRadius;
         uniform vec3 uInk;
         uniform vec3 uPaper;
         uniform vec3 uBlue;
         uniform float uRoughRing;
         uniform float uRoughBlue;
         uniform float uStops[6];
         uniform vec4 uRipple;
         uniform float uGlow;

         // Radial cross-section of the shock wave: a single smooth crest.
         float rippleProfile(float d) {
           float x = clamp(d, -1.0, 1.0);
           return exp(-x * x * 9.0) * cos(x * 3.14159265);
         }`
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         float rN = length(vLocalXY) / uRadius;
         float aa = max(fwidth(rN) * 0.72, 1e-5);
         vec3 ringColor = uBlue;
         ringColor = mix(ringColor, uInk,   smoothstep(uStops[0] - aa, uStops[0] + aa, rN));
         ringColor = mix(ringColor, uPaper, smoothstep(uStops[1] - aa, uStops[1] + aa, rN));
         ringColor = mix(ringColor, uInk,   smoothstep(uStops[2] - aa, uStops[2] + aa, rN));
         ringColor = mix(ringColor, uPaper, smoothstep(uStops[3] - aa, uStops[3] + aa, rN));
         ringColor = mix(ringColor, uInk,   smoothstep(uStops[4] - aa, uStops[4] + aa, rN));
         // The rim and back sit at r >= the last stop, so they resolve to ink
         // automatically — no face masking needed.
         diffuseColor.rgb = ringColor;`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         roughnessFactor = mix(uRoughBlue, uRoughRing,
           smoothstep(uStops[0] - aa, uStops[0] + aa, rN));`
      )
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
         if (uRipple.z > 0.001) {
           float d = (rN - uRipple.x) / uRipple.y;
           // Slope of the crest, used to tilt the shading normal outward.
           float slope = rippleProfile(d + 0.04) - rippleProfile(d - 0.04);
           normal = normalize(normal - normalize(vRadialView) * slope * uRipple.w * uRipple.z);
         }`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         if (uRipple.z > 0.001) {
           float d = (rN - uRipple.x) / uRipple.y;
           float crest = max(0.0, rippleProfile(d));
           totalEmissiveRadiance += uBlue * crest * uRipple.z;
         }
         if (uGlow > 0.001) {
           float core = exp(-pow(rN / (uStops[0] * 0.9), 2.0) * 3.4);
           totalEmissiveRadiance += uBlue * core * uGlow;
         }`
      );
  };

  // Force a unique program so the patched shader is not shared with other materials.
  material.customProgramCacheKey = () => 'fbf-board-v1';

  return material;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Board
 * ────────────────────────────────────────────────────────────────────────── */

export class Board {
  /** @param {number} radius outer radius in world units */
  constructor(radius) {
    this.radius = radius;
    this.thickness = BOARD.thickness * radius;
    this.bevel = BOARD.bevel * radius;

    this.geometry = buildDiscGeometry({
      radius,
      thickness: this.thickness,
      bevel: this.bevel,
    });
    this.material = createBoardMaterial(radius);
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'board';

    this.uniforms = this.material.userData.uniforms;
  }

  /** The bullseye, in the board's local space: dead centre of the front face. */
  get faceCenterLocal() {
    return new Vector3(0, 0, this.thickness / 2);
  }

  /**
   * @param {object} state frame state from the timeline
   */
  update(state) {
    const { ripple, glow } = state.impact;

    if (ripple > 0 && ripple < 1) {
      // The wave races out and thins as it goes, the way surface energy does.
      // Kept narrow and faint on purpose: past a certain width it stops reading
      // as a wave travelling across a surface and starts reading as a glow.
      const r = 0.024 + Math.pow(ripple, 0.6) * 0.4;
      const width = 0.05 + ripple * 0.075;
      const fadeIn = Math.min(1, ripple / 0.06);
      const fadeOut = Math.pow(1 - ripple, 1.9);
      const opacity = fadeIn * fadeOut * 0.34;
      this.uniforms.uRipple.value = [r, width, opacity, 0.7];
    } else {
      this.uniforms.uRipple.value = [0, 0.05, 0, 0];
    }

    if (glow > 0 && glow < 1) {
      // Sharp attack, quick decay — a pulse, never a flare.
      const attack = Math.min(1, glow / 0.12);
      const decay = Math.pow(1 - glow, 2.2);
      this.uniforms.uGlow.value = attack * decay * 0.5;
    } else {
      this.uniforms.uGlow.value = 0;
    }
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
