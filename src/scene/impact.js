/**
 * Impact energy.
 *
 * Two elements only, both parented to the board so they inherit its exact
 * orientation and its post-impact wobble:
 *
 *   · a short blue bloom in the air at the bullseye
 *   · a handful of lit dust motes thrown off the surface
 *
 * The surface ripple is not here — it lives in the board's own material, where
 * it is guaranteed to sit on the surface rather than near it.
 *
 * Everything is evaluated from a single progress uniform on the GPU, so the
 * particles are as deterministic as the rest of the film: the same frame number
 * always produces the same image, whether it is rendered live or offline.
 */

import {
  AdditiveBlending,
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  PlaneGeometry,
  Points,
  ShaderMaterial,
  Color,
} from '../../vendor/three.module.js';
import { BOARD } from '../config.js';

/* ─────────────────────────────────────────────────────────────────────────────
 * Air glow
 * ────────────────────────────────────────────────────────────────────────── */

function createGlow(radius) {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    uniforms: {
      uColor: { value: new Color(BOARD.material.blueColor) },
      uStrength: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uStrength;
      varying vec2 vUv;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        if (d > 1.0) discard;
        // Tight core, long soft shoulder — reads as light in air, not a sprite.
        float core = exp(-d * d * 12.0);
        float halo = pow(max(0.0, 1.0 - d), 3.2) * 0.32;
        gl_FragColor = vec4(uColor * (core + halo) * uStrength, 1.0);
      }`,
  });

  const mesh = new Mesh(new PlaneGeometry(radius * 2, radius * 2), material);
  mesh.renderOrder = 10;
  return { mesh, material };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Dust motes
 * ────────────────────────────────────────────────────────────────────────── */

const SPARK_COUNT = 26;

function createSparks(scale) {
  const seeds = new Float32Array(SPARK_COUNT);
  const positions = new Float32Array(SPARK_COUNT * 3);
  for (let i = 0; i < SPARK_COUNT; i++) {
    // Golden-ratio stagger: even angular coverage without visible symmetry.
    seeds[i] = (i * 0.6180339887498949) % 1;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('seed', new Float32BufferAttribute(seeds, 1));

  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: {
      uProgress: { value: -1 },
      uScale: { value: scale },
      uPixelRatio: { value: 1 },
      uColor: { value: new Color(0x6d7bff) },
    },
    vertexShader: /* glsl */ `
      attribute float seed;
      uniform float uProgress;
      uniform float uScale;
      uniform float uPixelRatio;
      varying float vAlpha;

      float rnd(float x) { return fract(sin(x * 91.3458) * 47453.5453); }

      void main() {
        float t = uProgress;
        float angle = seed * 6.28318530718;
        float speed = 0.45 + rnd(seed) * 0.9;
        float lift  = 0.3 + rnd(seed + 7.1) * 0.85;

        // Ejected radially with drag, drifting off the surface, then falling.
        float drag = 1.0 - exp(-t * 4.6);
        float r = speed * drag * 0.5;
        float z = lift * (1.0 - exp(-t * 5.2)) * 0.11 - t * t * 0.085;

        vec3 offset = vec3(cos(angle) * r, sin(angle) * r, z) * uScale;
        vec4 mv = modelViewMatrix * vec4(position + offset, 1.0);
        gl_Position = projectionMatrix * mv;

        float life = pow(max(0.0, 1.0 - t), 2.1);
        vAlpha = life * (0.55 + rnd(seed + 3.3) * 0.45);
        gl_PointSize = (2.4 + rnd(seed + 1.7) * 3.4) * uPixelRatio * life;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        if (d > 1.0) discard;
        float a = pow(max(0.0, 1.0 - d), 2.0);
        gl_FragColor = vec4(mix(vec3(1.0), uColor, 0.55) * a * vAlpha, 1.0);
      }`,
  });

  const points = new Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 11;
  return { points, material };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Impact
 * ────────────────────────────────────────────────────────────────────────── */

export class Impact {
  /**
   * @param {number} boardRadius
   * @param {import('../../vendor/three.module.js').Vector3} faceCenter local bullseye
   */
  constructor(boardRadius, faceCenter) {
    const glow = createGlow(boardRadius * 0.5);
    this.glowMesh = glow.mesh;
    this.glowMaterial = glow.material;
    this.glowMesh.position.copy(faceCenter);
    this.glowMesh.position.z += boardRadius * 0.004;

    const sparks = createSparks(boardRadius);
    this.sparkPoints = sparks.points;
    this.sparkMaterial = sparks.material;
    this.sparkPoints.position.copy(faceCenter);
  }

  /** Attaches to the board so the effects inherit its transform exactly. */
  attachTo(object3D) {
    object3D.add(this.glowMesh);
    object3D.add(this.sparkPoints);
  }

  /**
   * @param {object} state frame state from the timeline
   * @param {number} pixelRatio drawing-buffer height / 1080, so dots keep their
   *   apparent size between the preview and the 4K master
   */
  update(state, pixelRatio) {
    const { glow, sparkle } = state.impact;

    if (glow > 0 && glow < 1) {
      const attack = Math.min(1, glow / 0.1);
      const decay = Math.pow(1 - glow, 2.6);
      this.glowMaterial.uniforms.uStrength.value = attack * decay * 0.5;
      this.glowMesh.visible = true;
    } else {
      this.glowMesh.visible = false;
    }

    if (sparkle > 0 && sparkle < 1) {
      this.sparkMaterial.uniforms.uProgress.value = sparkle;
      this.sparkMaterial.uniforms.uPixelRatio.value = pixelRatio;
      this.sparkPoints.visible = true;
    } else {
      this.sparkPoints.visible = false;
    }
  }

  dispose() {
    this.glowMesh.geometry.dispose();
    this.glowMaterial.dispose();
    this.sparkPoints.geometry.dispose();
    this.sparkMaterial.dispose();
  }
}
