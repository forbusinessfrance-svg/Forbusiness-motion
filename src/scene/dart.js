/**
 * The dart.
 *
 * Built as four real parts — steel point, knurled tungsten barrel, moulded stem,
 * four-wing flight — assembled along +Z with the point at the local origin. That
 * origin matters: every impact behaviour in the film is a rotation about the tip,
 * so making the tip the pivot means the physics needs no compensating offsets.
 *
 * The knurl is turned geometry, not a normal map. At 4K the difference is the
 * difference between metal and a picture of metal: real grooves break the
 * specular into distinct bands and self-shadow along the silhouette.
 */

import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Color,
  Shape,
  ExtrudeGeometry,
  Vector2,
} from '../../vendor/three.module.js';
import { DART } from '../config.js';

/* ─────────────────────────────────────────────────────────────────────────────
 * Surface of revolution around +Z, with normals derived from the profile
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * @param {Array<{r:number,z:number}>} profile ordered from tip to tail
 * @param {number} segments
 */
function revolve(profile, segments = 192) {
  const rows = profile.length;
  const cols = segments + 1;
  const positions = new Float32Array(rows * cols * 3);
  const normals = new Float32Array(rows * cols * 3);
  const uvs = new Float32Array(rows * cols * 2);

  // Profile-space normals from a central difference along the polyline.
  const profileNormals = profile.map((p, i) => {
    const prev = profile[Math.max(0, i - 1)];
    const next = profile[Math.min(rows - 1, i + 1)];
    const dr = next.r - prev.r;
    const dz = next.z - prev.z;
    const len = Math.hypot(dr, dz) || 1;
    // Rotate the tangent (dr, dz) by −90° to point outward.
    return { nr: dz / len, nz: -dr / len };
  });

  for (let ri = 0; ri < rows; ri++) {
    const p = profile[ri];
    const n = profileNormals[ri];
    for (let ci = 0; ci < cols; ci++) {
      const a = (ci / segments) * Math.PI * 2;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const i3 = (ri * cols + ci) * 3;
      positions[i3] = p.r * cos;
      positions[i3 + 1] = p.r * sin;
      positions[i3 + 2] = p.z;
      normals[i3] = n.nr * cos;
      normals[i3 + 1] = n.nr * sin;
      normals[i3 + 2] = n.nz;
      const i2 = (ri * cols + ci) * 2;
      uvs[i2] = ci / segments;
      uvs[i2 + 1] = ri / (rows - 1);
    }
  }

  const indices = [];
  for (let ri = 0; ri < rows - 1; ri++) {
    for (let ci = 0; ci < segments; ci++) {
      const a = ri * cols + ci;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
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
 * Flight wing outline
 * ────────────────────────────────────────────────────────────────────────── */

function buildWingGeometry(length, span, thickness) {
  // Outline in (axial, radial) normalised space, traced along the leading edge.
  // A standard flight: narrow at the stem, swelling continuously to its widest
  // at the trailing edge, which is cut square with a rounded corner.
  const outline = [
    [0.0, 0.06],
    [0.13, 0.25],
    [0.3, 0.5],
    [0.5, 0.73],
    [0.7, 0.9],
    [0.87, 0.985],
  ];

  const shape = new Shape();
  shape.moveTo(0, 0);
  shape.lineTo(outline[0][0] * length, outline[0][1] * span);
  shape.splineThru(
    outline.slice(1).map(([x, y]) => new Vector2(x * length, y * span))
  );
  // Rounded trailing corner, then straight down the back edge to the axis.
  shape.quadraticCurveTo(length, span, length, span * 0.9);
  shape.lineTo(length, 0);
  shape.closePath();

  const geometry = new ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelThickness: thickness * 0.42,
    bevelSize: thickness * 0.5,
    bevelSegments: 3,
    curveSegments: 48,
  });
  geometry.translate(0, 0, -thickness / 2);
  geometry.computeVertexNormals();
  return geometry;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Dart
 * ────────────────────────────────────────────────────────────────────────── */

export class Dart {
  /** @param {number} length total dart length in world units */
  constructor(length) {
    const L = length;
    this.length = L;

    const p = DART.parts;
    const R = DART.barrelRadius * L;

    const zPointEnd = p.point * L;
    const zBarrelEnd = zPointEnd + p.barrel * L;
    const zStemEnd = zBarrelEnd + p.stem * L;
    const zFlightEnd = zStemEnd + p.flight * L;

    this.group = new Group();
    this.group.name = 'dart';

    /* ── Point: a slightly concave steel taper ─────────────────────────── */
    const pointProfile = [];
    const pointSteps = 26;
    const pointBaseR = R * 0.3;
    for (let i = 0; i <= pointSteps; i++) {
      const t = i / pointSteps;
      const z = t * zPointEnd;
      // Concave taper — needle at the tip, shoulder at the base.
      const r = Math.max(0.0006 * L, pointBaseR * Math.pow(t, 0.62));
      pointProfile.push({ r, z });
    }
    // Shoulder into the barrel.
    pointProfile.push({ r: R * 0.52, z: zPointEnd + 0.004 * L });

    this.pointMaterial = new MeshPhysicalMaterial({
      color: new Color(DART.material.pointColor),
      metalness: 1,
      roughness: 0.28,
      envMapIntensity: 1.15,
    });
    this.pointMesh = new Mesh(revolve(pointProfile, 128), this.pointMaterial);

    /* ── Barrel: tapered, with turned knurl grooves ────────────────────── */
    const barrelProfile = [];
    const barrelLen = zBarrelEnd - zPointEnd;
    const barrelSteps = 400;
    for (let i = 0; i <= barrelSteps; i++) {
      const t = i / barrelSteps;
      const z = zPointEnd + t * barrelLen;

      // Overall silhouette: swells in from the point, tapers off to the stem.
      let base = R;
      if (t < 0.22) base = R * (0.52 + 0.48 * Math.pow(t / 0.22, 0.55));
      else if (t > 0.86) base = R * (1 - 0.34 * Math.pow((t - 0.86) / 0.14, 1.5));

      // Knurl: rounded V-grooves, faded out at both ends where the turning stops.
      const grooveZone = Math.min(1, Math.max(0, (t - 0.16) / 0.1)) *
        Math.min(1, Math.max(0, (0.9 - t) / 0.08));
      const wave = 0.5 + 0.5 * Math.cos(t * Math.PI * 2 * DART.grooves);
      const depth = R * 0.155 * grooveZone;

      barrelProfile.push({ r: base - depth * wave, z });
    }

    this.barrelMaterial = new MeshPhysicalMaterial({
      color: new Color(DART.material.steelColor),
      metalness: 1,
      roughness: DART.material.steelRoughness,
      envMapIntensity: 1.2,
    });
    this._patchBarrelSweep(this.barrelMaterial, zPointEnd, zBarrelEnd);
    this.barrelMesh = new Mesh(revolve(barrelProfile, 192), this.barrelMaterial);

    /* ── Stem: moulded black plastic with a collar ─────────────────────── */
    const stemProfile = [];
    const stemLen = zStemEnd - zBarrelEnd;
    const stemR = R * 0.44;
    stemProfile.push({ r: R * 0.6, z: zBarrelEnd - 0.001 * L });
    stemProfile.push({ r: R * 0.62, z: zBarrelEnd + 0.012 * L });
    stemProfile.push({ r: stemR, z: zBarrelEnd + 0.026 * L });
    stemProfile.push({ r: stemR, z: zBarrelEnd + stemLen * 0.82 });
    stemProfile.push({ r: stemR * 1.12, z: zStemEnd - 0.006 * L });
    stemProfile.push({ r: stemR * 0.92, z: zStemEnd });

    this.plasticMaterial = new MeshPhysicalMaterial({
      color: new Color(DART.material.plasticColor),
      metalness: 0,
      roughness: 0.34,
      clearcoat: 0.5,
      clearcoatRoughness: 0.2,
    });
    this.stemMesh = new Mesh(revolve(stemProfile, 96), this.plasticMaterial);

    /* ── Flight: four wings ────────────────────────────────────────────── */
    this.flightMaterial = new MeshStandardMaterial({
      color: new Color(DART.material.flightColor),
      metalness: 0,
      roughness: 0.44,
    });

    const flightLen = zFlightEnd - zStemEnd;
    const span = DART.flight.span * L;
    const wingGeometry = buildWingGeometry(flightLen, span, 0.0022 * L);
    this.flightGroup = new Group();
    for (let i = 0; i < DART.flight.wings; i++) {
      const wing = new Mesh(wingGeometry, this.flightMaterial);
      // The shape lies in XY (x = axial, y = span); swing its axial axis onto +Z
      // so the blade stands along the dart, then fan the copies around it.
      wing.rotation.y = -Math.PI / 2;
      const holder = new Group();
      holder.add(wing);
      holder.rotation.z = (i / DART.flight.wings) * Math.PI * 2;
      this.flightGroup.add(holder);
    }
    this.flightGroup.position.z = zStemEnd;
    // Rolled so one blade presents its face to the lens and its neighbour goes
    // nearly edge-on — the silhouette in the reference, rather than a rosette.
    this.flightGroup.rotation.z = DART.flight.roll * (Math.PI / 180);

    for (const mesh of [this.pointMesh, this.barrelMesh, this.stemMesh]) {
      mesh.castShadow = true;
      this.group.add(mesh);
    }
    this.flightGroup.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    this.group.add(this.flightGroup);

    this.zBarrel = [zPointEnd, zBarrelEnd];
  }

  /**
   * A single travelling highlight down the barrel at the moment of impact —
   * the light "finding" the metal. One uniform, one gaussian, no post-processing.
   */
  _patchBarrelSweep(material, zStart, zEnd) {
    material.userData.uniforms = {
      uSweepZ: { value: -1 },
      uSweepStrength: { value: 0 },
      uSweepWidth: { value: (zEnd - zStart) * 0.16 },
    };
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, material.userData.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n varying float vAxial;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n vAxial = position.z;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying float vAxial;
           uniform float uSweepZ;
           uniform float uSweepStrength;
           uniform float uSweepWidth;`
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           if (uSweepStrength > 0.001) {
             float d = (vAxial - uSweepZ) / uSweepWidth;
             totalEmissiveRadiance += vec3(1.0) * exp(-d * d) * uSweepStrength;
           }`
        );
    };
    material.customProgramCacheKey = () => 'fbf-barrel-v1';
  }

  /** @param {object} state frame state from the timeline */
  update(state) {
    this.group.visible = state.dart.visible && state.scene.opacity > 0.001;

    const sweep = state.impact.sweep;
    const u = this.barrelMaterial.userData.uniforms;
    if (sweep >= 0) {
      const [z0, z1] = this.zBarrel;
      // Runs tip-to-tail, brightest mid-travel.
      u.uSweepZ.value = z0 + (z1 - z0) * (1.25 * sweep - 0.12);
      u.uSweepStrength.value = Math.sin(Math.PI * sweep) * 0.5;
    } else {
      u.uSweepStrength.value = 0;
    }
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh) o.geometry.dispose();
    });
    this.pointMaterial.dispose();
    this.barrelMaterial.dispose();
    this.plasticMaterial.dispose();
    this.flightMaterial.dispose();
  }
}
