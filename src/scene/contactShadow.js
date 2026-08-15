/**
 * Contact shadow.
 *
 * The page has to stay exactly #FFFFFF, which rules out a lit floor: any real
 * surface would shade and the white would drift. Instead the ground is a plane
 * that renders *nothing but occlusion* — the scene's depth from directly above,
 * blurred, composited as darkness only. Untouched pixels stay pure paper.
 *
 * It is recomputed every frame, so the pool tightens as the dart lands and
 * breathes with the board's post-impact wobble.
 */

import {
  Mesh,
  PlaneGeometry,
  MeshBasicMaterial,
  MeshDepthMaterial,
  ShaderMaterial,
  Color,
  OrthographicCamera,
  WebGLRenderTarget,
  LinearFilter,
  NoColorSpace,
  Group,
  Scene,
} from '../../vendor/three.module.js';

const BLUR_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uDelta: { value: [0, 0] },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uDelta;
    varying vec2 vUv;
    void main() {
      // Nine-tap gaussian, weights from the binomial row.
      const float w0 = 0.2270270270;
      const float w1 = 0.1945945946;
      const float w2 = 0.1216216216;
      const float w3 = 0.0540540541;
      const float w4 = 0.0162162162;
      vec4 sum = texture2D(tDiffuse, vUv) * w0;
      sum += texture2D(tDiffuse, vUv + uDelta * 1.0) * w1;
      sum += texture2D(tDiffuse, vUv - uDelta * 1.0) * w1;
      sum += texture2D(tDiffuse, vUv + uDelta * 2.0) * w2;
      sum += texture2D(tDiffuse, vUv - uDelta * 2.0) * w2;
      sum += texture2D(tDiffuse, vUv + uDelta * 3.0) * w3;
      sum += texture2D(tDiffuse, vUv - uDelta * 3.0) * w3;
      sum += texture2D(tDiffuse, vUv + uDelta * 4.0) * w4;
      sum += texture2D(tDiffuse, vUv - uDelta * 4.0) * w4;
      gl_FragColor = sum;
    }`,
};

export class ContactShadow {
  /**
   * @param {object} o
   * @param {number} o.size      side length of the shadow plane, world units
   * @param {number} o.height    how far above the plane casters are captured
   * @param {number} o.resolution
   * @param {number} o.blur
   * @param {number} o.darkness
   * @param {number} o.opacity
   */
  constructor({ size, height, resolution = 1024, blur = 2.5, darkness = 0.85, opacity = 0.5 }) {
    this.group = new Group();
    this.group.name = 'contact-shadow';
    this.blurAmount = blur;
    this.size = size;
    this._clearColor = new Color();

    const targetOptions = { minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false };
    this.target = new WebGLRenderTarget(resolution, resolution, targetOptions);
    this.target.texture.generateMipmaps = false;
    this.target.texture.colorSpace = NoColorSpace;
    this.scratch = new WebGLRenderTarget(resolution, resolution, targetOptions);
    this.scratch.texture.generateMipmaps = false;
    this.scratch.texture.colorSpace = NoColorSpace;

    this.plane = new Mesh(
      new PlaneGeometry(size, size),
      new MeshBasicMaterial({
        map: this.target.texture,
        transparent: true,
        opacity,
        depthWrite: false,
        toneMapped: false,
      })
    );
    this.plane.rotation.x = -Math.PI / 2;
    this.plane.renderOrder = -1;
    this.group.add(this.plane);

    // Looks straight down at the plane; anything within `height` casts.
    this.camera = new OrthographicCamera(-size / 2, size / 2, size / 2, -size / 2, 0, height);
    this.camera.rotation.x = Math.PI / 2;
    this.group.add(this.camera);

    this.depthMaterial = new MeshDepthMaterial();
    this.depthMaterial.userData.darkness = { value: darkness };
    this.depthMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.darkness = this.depthMaterial.userData.darkness;
      shader.fragmentShader = `uniform float darkness;\n${shader.fragmentShader}`.replace(
        'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
        'gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );'
      );
    };
    this.depthMaterial.depthTest = false;
    this.depthMaterial.depthWrite = false;

    this.blurMaterial = new ShaderMaterial({ ...BLUR_SHADER });
    this.blurQuad = new Mesh(new PlaneGeometry(2, 2), this.blurMaterial);
    this.blurScene = new Scene();
    this.blurScene.add(this.blurQuad);
    this.blurCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  /** @param {number} v 0..1 — fades with the rest of the 3D layer. */
  setOpacity(v) {
    this.plane.material.opacity = v;
    this.plane.visible = v > 0.001;
  }

  /**
   * @param {import('../../vendor/three.module.js').WebGLRenderer} renderer
   * @param {import('../../vendor/three.module.js').Scene} scene
   */
  update(renderer, scene) {
    if (!this.plane.visible) return;

    const previousBackground = scene.background;
    const previousOverride = scene.overrideMaterial;
    const previousTarget = renderer.getRenderTarget();
    const previousClearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this._clearColor);

    this.plane.visible = false;
    scene.background = null;
    scene.overrideMaterial = this.depthMaterial;

    // Clear to transparent black: a white clear would bleed into the blurred
    // core and wash the shadow out at its edges.
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, this.camera);

    scene.overrideMaterial = previousOverride;

    this._blur(renderer, this.blurAmount);
    // A second, tighter pass keeps the core dense while the edges stay soft.
    this._blur(renderer, this.blurAmount * 0.36);

    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(this._clearColor, previousClearAlpha);
    scene.background = previousBackground;
    this.plane.visible = true;
  }

  _blur(renderer, amount) {
    const px = amount / this.target.width;
    this.blurMaterial.uniforms.tDiffuse.value = this.target.texture;
    this.blurMaterial.uniforms.uDelta.value = [px, 0];
    renderer.setRenderTarget(this.scratch);
    renderer.clear();
    renderer.render(this.blurScene, this.blurCamera);

    this.blurMaterial.uniforms.tDiffuse.value = this.scratch.texture;
    this.blurMaterial.uniforms.uDelta.value = [0, px];
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(this.blurScene, this.blurCamera);
  }

  dispose() {
    this.target.dispose();
    this.scratch.dispose();
    this.plane.geometry.dispose();
    this.plane.material.dispose();
    this.blurQuad.geometry.dispose();
    this.blurMaterial.dispose();
    this.depthMaterial.dispose();
  }
}
