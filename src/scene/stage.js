/**
 * The stage: scene graph, camera solving, and the dart's flight.
 *
 * ── Placement ──────────────────────────────────────────────────────────────
 * The board's pivot sits at the world origin *at the bullseye*, not at the
 * disc's centre. Everything the film does — the dart planting, the wobble, the
 * ripple, the camera aim — is defined relative to that one point, so none of it
 * needs compensating offsets.
 *
 * Rather than move the board to hit its mark, the camera is *solved* each frame:
 * given the lens, the framing and the desired normalised screen position, there
 * is exactly one camera position that puts the bullseye where the reference has
 * it. That solve is what keeps the composition locked while the camera pushes
 * in, drifts and shakes.
 *
 * ── The dart ───────────────────────────────────────────────────────────────
 * The dart is a child of the board. Once it lands it is *in* the board, so it
 * inherits the wobble for free and can never drift out of the hole. Its resting
 * attitude is specified in screen terms (the angle it makes in the reference
 * frame) and converted into board space once at startup.
 */

import {
  Scene,
  PerspectiveCamera,
  Group,
  Quaternion,
  Vector3,
  Euler,
} from '../../vendor/three.module.min.js';
import { BOARD, DART, CAMERA, QUALITY } from '../config.js';
import { Board } from './board.js';
import { Dart } from './dart.js';
import { ContactShadow } from './contactShadow.js';
import { Impact } from './impact.js';
import { createStudioEnvironment } from './environment.js';
import { smoothstep } from '../core/easing.js';

const DEG = Math.PI / 180;
const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Y = new Vector3(0, 1, 0);
const AXIS_Z = new Vector3(0, 0, 1);

export class Stage {
  /**
   * @param {import('../../vendor/three.module.min.js').WebGLRenderer} renderer
   * @param {ReturnType<import('../config.js').resolveLayout>} layout
   */
  constructor(renderer, layout) {
    this.renderer = renderer;
    this.layout = layout;

    this.scene = new Scene();
    this.scene.background = null;

    this.environment = createStudioEnvironment(renderer);
    this.scene.environment = this.environment;

    /* ── Camera ────────────────────────────────────────────────────────── */

    this.camera = new PerspectiveCamera(CAMERA.fov, layout.aspect, 0.1, 100);
    // Framed so that one world unit spans exactly the frame width at the board.
    this.baseDistance = 1 / (2 * Math.tan((CAMERA.fov / 2) * DEG) * layout.aspect);

    // A few degrees of downward pitch. Enough for the floor to catch a real
    // contact shadow, far too little to read as a camera angle.
    this.pitch = 6.0 * DEG;
    this.cameraQuaternion = new Quaternion().setFromAxisAngle(AXIS_X, -this.pitch);

    /* ── Board ─────────────────────────────────────────────────────────── */

    const radius = layout.board.radius;
    this.board = new Board(radius);
    this.boardPivot = new Group();
    this.boardPivot.name = 'board-pivot';
    // Shift the disc back so its front face — the bullseye — is the pivot.
    this.board.mesh.position.z = -this.board.thickness / 2;
    this.boardPivot.add(this.board.mesh);
    this.scene.add(this.boardPivot);

    this.boardBaseQuaternion = new Quaternion()
      .setFromAxisAngle(AXIS_X, BOARD.tiltX * DEG)
      .premultiply(new Quaternion().setFromAxisAngle(AXIS_Y, BOARD.tiltY * DEG))
      .premultiply(new Quaternion().setFromAxisAngle(AXIS_Z, BOARD.rollZ * DEG));
    this.boardPivot.quaternion.copy(this.boardBaseQuaternion);

    /* ── Dart ──────────────────────────────────────────────────────────── */

    this.dart = new Dart(radius * DART.length);
    this.boardPivot.add(this.dart.group);

    /* ── Impact ────────────────────────────────────────────────────────── */

    this.impact = new Impact(radius, new Vector3(0, 0, 0));
    this.impact.attachTo(this.boardPivot);
    // Layer 1 is "additive light": visible to the lens, invisible to the shadow
    // pass, which would otherwise read the glow card as a solid occluder.
    this.impact.glowMesh.layers.set(1);
    this.impact.sparkPoints.layers.set(1);
    this.camera.layers.enable(1);

    /* ── Contact shadow ────────────────────────────────────────────────── */

    // The disc floats a touch above the ground, which is what detaches the
    // shadow and gives the render its lift.
    const lowestPoint = -radius * 1.02;
    this.floorY = lowestPoint - radius * 0.022;
    this.shadow = new ContactShadow({
      size: radius * 3.6,
      height: radius * 2.2,
      resolution: QUALITY.shadow.resolution,
      blur: QUALITY.shadow.blur,
      darkness: QUALITY.shadow.darkness,
      opacity: QUALITY.shadow.opacity,
    });
    this.shadow.group.position.y = this.floorY;
    this.scene.add(this.shadow.group);

    /* ── Flight path, solved once in board space ───────────────────────── */

    this._solveFlightFrame();

    // Scratch objects — allocation-free per-frame updates.
    this._q = new Quaternion();
    this._q2 = new Quaternion();
    this._v = new Vector3();
    this._tip = new Vector3();
    this._axis = new Vector3();
    this._aim = new Vector3();
    this._euler = new Euler();
  }

  /**
   * Converts the reference's *screen-space* dart attitude into board space, and
   * derives the launch point and the axes the impact physics rotates about.
   */
  _solveFlightFrame() {
    const boardInverse = this.boardBaseQuaternion.clone().invert();
    const toBoard = (v) => v.clone().applyQuaternion(this.cameraQuaternion).applyQuaternion(boardInverse);

    /**
     * A direction given in *screen* terms — the angle it makes in the frame and
     * how far it tips toward the lens — resolved into the board's local space.
     * Specifying the dart this way is what lets the reference's on-screen angle
     * survive any change to the board's orientation.
     */
    const screenDirection = (screenAngle, depthAngle) => {
      const sa = screenAngle * DEG;
      const da = depthAngle * DEG;
      return toBoard(
        new Vector3(
          Math.cos(sa) * Math.cos(da),
          Math.sin(sa) * Math.cos(da),
          Math.sin(da)
        ).normalize()
      ).normalize();
    };

    /** Resting axis of the dart, tip → tail, in board space. */
    this.restAxis = screenDirection(DART.screenAngle, DART.depthAngle);
    /** Where the throw comes from. */
    this.launchAxis = screenDirection(DART.launchScreenAngle, DART.launchDepthAngle);
    /** Camera up and right, in board space — used for the impact rotations. */
    this.upLocal = toBoard(new Vector3(0, 1, 0)).normalize();
    this.rightLocal = toBoard(new Vector3(1, 0, 0)).normalize();

    // Rotating about `pitchAxis` swings the tail up and down on screen;
    // `yawAxis` swings it left and right. Both pass through the point.
    this.pitchAxis = new Vector3().crossVectors(this.restAxis, this.rightLocal).normalize();
    this.yawAxis = new Vector3().crossVectors(this.restAxis, this.pitchAxis).normalize();

    // Trajectory: a quadratic Bézier from off-frame to the bullseye. Putting the
    // control point on the resting axis is not a stylistic choice — the tangent
    // of a quadratic at its end point runs through the control point, so this
    // makes the dart arrive *exactly* along the axis it will rest on. No blend
    // is needed at the moment that matters, and the arc between the two
    // directions is the falling curve of a real throw for free.
    const S = DART.launchDistance * this.layout.board.radius;
    this.pathStart = this.launchAxis.clone().multiplyScalar(S);
    this.pathControl = this.restAxis.clone().multiplyScalar(S * 0.34);
    this.pathEnd = new Vector3(0, 0, 0);

    this._buildArcTable();
  }

  /**
   * Distance-to-target as a function of the curve parameter, tabulated once.
   *
   * A Bézier's parameter is not distance: this curve covers most of its length
   * in its first third, so driving it with an eased parameter would make the
   * dart *decelerate* into the board. Inverting this table instead lets the
   * throw be specified the way it should be — by how much distance is left —
   * and `approachExponent` then shapes the acceleration directly.
   */
  _buildArcTable() {
    const steps = 96;
    const point = new Vector3();
    this._arc = new Float32Array(steps + 1);
    for (let i = 0; i <= steps; i++) {
      this._pathAt(i / steps, point);
      this._arc[i] = point.length();
    }
    this._arcTotal = this._arc[0] || 1;
  }

  /**
   * Curve parameter at which the remaining distance is `fraction` of the total.
   * The table is monotonically decreasing, so a binary search plus one linear
   * interpolation is exact enough for sub-pixel motion at 4K.
   */
  _uForRemaining(fraction) {
    const target = fraction * this._arcTotal;
    const arc = this._arc;
    let lo = 0;
    let hi = arc.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arc[mid] > target) lo = mid;
      else hi = mid;
    }
    const span = arc[lo] - arc[hi];
    const k = span > 1e-9 ? (arc[lo] - target) / span : 0;
    return (lo + k) / (arc.length - 1);
  }

  /** Point on the flight path at parameter u ∈ [0, 1]. */
  _pathAt(u, out) {
    const iu = 1 - u;
    return out.set(0, 0, 0)
      .addScaledVector(this.pathStart, iu * iu)
      .addScaledVector(this.pathControl, 2 * iu * u)
      .addScaledVector(this.pathEnd, u * u);
  }

  /** Unit tangent of the flight path at u, pointing in the direction of travel. */
  _tangentAt(u, out) {
    const iu = 1 - u;
    out.set(0, 0, 0)
      .addScaledVector(this.pathControl, 2 * iu)
      .addScaledVector(this.pathStart, -2 * iu)
      .addScaledVector(this.pathEnd, 2 * u)
      .addScaledVector(this.pathControl, -2 * u);
    return out.normalize();
  }

  /* ───────────────────────────────────────────────────────────────────────
   * Per-frame update
   * ──────────────────────────────────────────────────────────────────── */

  /** @param {object} state frame state from the timeline */
  update(state) {
    this._updateBoard(state);
    this._updateDart(state);
    this.board.update(state);
    this.dart.update(state);

    const pixelRatio = this.renderer.getContext().drawingBufferHeight / 1080;
    this.impact.update(state, pixelRatio);

    this._updateCamera(state);
  }

  _updateBoard(state) {
    const { board } = state;

    // Wobble is a rotation about two in-plane axes, layered on the rest pose.
    this._q.setFromEuler(this._euler.set(board.wobbleA, board.wobbleB, 0, 'XYZ'));
    this.boardPivot.quaternion.copy(this.boardBaseQuaternion).multiply(this._q);

    this.boardPivot.scale.setScalar(board.scale);
    // Entrance lift, plus the microscopic recoil along the board's own normal.
    this._v.set(0, 0, 1).applyQuaternion(this.boardBaseQuaternion);
    this.boardPivot.position
      .set(0, board.rise, 0)
      .addScaledVector(this._v, -board.push * this.layout.board.radius * 0.12);

    // The composite fades the whole 3D layer, shadow included, so the shadow
    // must not fade a second time here — only switch off once it is invisible.
    this.shadow.setOpacity(state.scene.opacity > 0.002 ? QUALITY.shadow.opacity : 0);
  }

  _updateDart(state) {
    const d = state.dart;
    if (!d.visible) return;

    const radius = this.layout.board.radius;

    // Remaining distance falls off with a fractional exponent, so the closing
    // speed keeps rising all the way to contact — the dart is quickest in the
    // last two frames, which is where the shutter earns the streak.
    const u =
      d.progress >= 1
        ? 1
        : this._uForRemaining(Math.pow(1 - d.progress, DART.approachExponent));

    this._pathAt(u, this._tip);

    // Attitude: follow the trajectory early, settle onto the reference pose late.
    if (u < 1) {
      this._tangentAt(u, this._axis).negate();
      this._axis.lerp(this.restAxis, smoothstep(u, 0.55, 1.0)).normalize();
    } else {
      this._axis.copy(this.restAxis);
    }

    // The point buries itself and the barrel unloads a fraction of a millimetre.
    const sink = d.bury * radius * 0.085 - d.recoil * radius;
    this._tip.addScaledVector(this._axis, -sink);
    this.dart.group.position.copy(this._tip);

    // Align +Z with the dart axis...
    this._q.setFromUnitVectors(AXIS_Z, this._axis);

    // ...then a little roll about its own axis, unwinding as it flies...
    const roll = d.inFlight ? (1 - d.progress) * 0.55 : 0;
    this._q2.setFromAxisAngle(AXIS_Z, roll);
    this._q.multiply(this._q2);

    // ...and finally the post-impact swing about the point itself.
    if (d.pitch !== 0 || d.yaw !== 0) {
      this._q2.setFromAxisAngle(this.pitchAxis, d.pitch);
      this._q.premultiply(this._q2);
      this._q2.setFromAxisAngle(this.yawAxis, d.yaw);
      this._q.premultiply(this._q2);
    }

    this.dart.group.quaternion.copy(this._q);
  }

  _updateCamera(state) {
    const cam = state.camera;
    const layout = this.layout;

    // Where the bullseye must land, in normalised device coordinates.
    const ndcX = (layout.board.centerX - 0.5) * 2 + cam.driftX * 2;
    const ndcY = 1 - 2 * ((layout.board.centerY + cam.driftY) / layout.height);

    const distance = this.baseDistance * cam.distance;
    const tanY = Math.tan((CAMERA.fov / 2) * DEG);
    const tanX = tanY * layout.aspect;

    // Camera orientation: fixed pitch, plus a whisper of roll during the shake.
    this._q.setFromAxisAngle(AXIS_Z, cam.roll).premultiply(this.cameraQuaternion);
    this.camera.quaternion.copy(this._q);

    // Solve for the position that puts the aim point at the requested NDC.
    this._aim.copy(this.boardPivot.position);
    this._v
      .set(ndcX * tanX * distance, ndcY * tanY * distance, -distance)
      .applyQuaternion(this._q);
    this.camera.position.copy(this._aim).sub(this._v);

    this.camera.aspect = layout.aspect;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();

    // Focus rides the bullseye, pulling back onto it as the push-in settles.
    this.focusDistance = this.camera.position.distanceTo(this._aim) - cam.focusOffset;
    this.aperture = CAMERA.aperture;
  }

  /** Refreshes the contact shadow. Called once per output frame, not per sample. */
  updateShadow() {
    this.shadow.update(this.renderer, this.scene);
  }

  setLayout(layout) {
    this.layout = layout;
    this.camera.aspect = layout.aspect;
    this.baseDistance = 1 / (2 * Math.tan((CAMERA.fov / 2) * DEG) * layout.aspect);
    this.camera.updateProjectionMatrix();
    this._solveFlightFrame();
  }

  dispose() {
    this.board.dispose();
    this.dart.dispose();
    this.impact.dispose();
    this.shadow.dispose();
    this.environment.dispose();
  }
}
