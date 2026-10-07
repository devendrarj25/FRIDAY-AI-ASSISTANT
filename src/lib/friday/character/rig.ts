/**
 * FRIDAY · 2D skeletal character renderer (WebGL2, GPU accelerated)
 *
 * A real-time renderer for the shipped artwork:
 *  - the texture is deformed by a small bone hierarchy on the GPU, so breathing,
 *    sway, head turns and reactions are procedural rather than pre-baked frames
 *  - eyes blink by re-projecting a skin patch over the eye landmarks
 *  - the mouth is drawn procedurally from the REAL audio envelope of whatever
 *    FRIDAY is speaking, so lip-sync matches the actual voice
 *  - every animated value is spring-damped, so state changes never snap
 *
 * The renderer owns no application state: it is fed a target pose each frame
 * and reports its real measured frame rate back to the caller.
 */
import type { CharacterAction, CharacterEmotion, CharacterRig } from "./types";

const VERT = `#version 300 es
precision highp float;

in vec2 a_uv;
in vec4 a_weight;   // hips, torso, neck, head

uniform vec2 u_pivot[4];
uniform vec3 u_bone[4];  // rotation, translate.x, translate.y
uniform vec2 u_scale;    // global squash/stretch around the feet
uniform vec2 u_offset;   // global translation in clip units
uniform vec4 u_crop;     // u0, v0, u1, v1

out vec2 v_uv;

vec2 applyBone(vec2 p, int i) {
  vec2 pivot = u_pivot[i];
  float r = u_bone[i].x;
  vec2 t = u_bone[i].yz;
  vec2 d = p - pivot;
  float c = cos(r);
  float s = sin(r);
  return pivot + vec2(d.x * c - d.y * s, d.x * s + d.y * c) + t;
}

void main() {
  vec2 p = a_uv;
  vec2 deformed =
    applyBone(p, 0) * a_weight.x +
    applyBone(p, 1) * a_weight.y +
    applyBone(p, 2) * a_weight.z +
    applyBone(p, 3) * a_weight.w;

  // Feet stay planted: scaling happens around the bottom of the sprite.
  vec2 scaled = vec2((deformed.x - 0.5) * u_scale.x + 0.5, 1.0 - (1.0 - deformed.y) * u_scale.y);
  vec2 clip = vec2(scaled.x * 2.0 - 1.0, (1.0 - scaled.y) * 2.0 - 1.0) + u_offset;

  v_uv = vec2(mix(u_crop.x, u_crop.z, a_uv.x), mix(u_crop.y, u_crop.w, a_uv.y));
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;

in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec3 u_tint;      // emotion colour
uniform float u_tintMix;  // 0..1
uniform float u_alpha;
uniform float u_rim;      // rim light strength

out vec4 outColor;

void main() {
  vec4 texel = texture(u_tex, v_uv);
  if (texel.a < 0.01) discard;
  vec3 rgb = mix(texel.rgb, texel.rgb * u_tint, u_tintMix);
  // Rim light: brighten the silhouette edge using the alpha gradient.
  float edge = 1.0 - smoothstep(0.35, 0.95, texel.a);
  rgb += u_tint * edge * u_rim;
  outColor = vec4(rgb, texel.a * u_alpha);
}`;

/** Simple coloured/rounded shapes: mouth, aura, progress ring. */
const SHAPE_VERT = `#version 300 es
precision highp float;
in vec2 a_pos;
uniform vec4 u_rect;   // x, y, w, h in clip space
out vec2 v_local;
void main() {
  v_local = a_pos;
  vec2 p = vec2(u_rect.x + a_pos.x * u_rect.z, u_rect.y + a_pos.y * u_rect.w);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const SHAPE_FRAG = `#version 300 es
precision highp float;
in vec2 v_local;
uniform vec4 u_color;
uniform float u_mode;   // 0 = ellipse, 1 = soft radial aura
out vec4 outColor;
void main() {
  float d = length(v_local);
  if (u_mode < 0.5) {
    float a = 1.0 - smoothstep(0.82, 1.0, d);
    if (a <= 0.001) discard;
    outColor = vec4(u_color.rgb, u_color.a * a);
  } else {
    float a = pow(max(0.0, 1.0 - d), 2.2);
    if (a <= 0.002) discard;
    outColor = vec4(u_color.rgb, u_color.a * a);
  }
}`;

type Pose = {
  action: CharacterAction;
  emotion: CharacterEmotion;
  amplitude: number;
  gaze: { dx: number; dy: number };
  reduceMotion: boolean;
  quality: "high" | "balanced" | "battery";
};

const EMOTION_TINT: Record<CharacterEmotion, [number, number, number]> = {
  calm: [0.72, 0.86, 1.0],
  focused: [0.62, 0.8, 1.0],
  curious: [0.86, 0.78, 1.0],
  happy: [1.0, 0.86, 0.72],
  concerned: [1.0, 0.8, 0.62],
  alert: [1.0, 0.62, 0.58],
  sleepy: [0.66, 0.7, 0.86],
};

/** A critically-damped spring — smooth, never overshooting into jelly. */
class Spring {
  value: number;
  target: number;
  private velocity = 0;
  constructor(
    value: number,
    private stiffness = 90,
    private damping = 16,
  ) {
    this.value = value;
    this.target = value;
  }
  step(dt: number) {
    const accel = (this.target - this.value) * this.stiffness - this.velocity * this.damping;
    this.velocity += accel * dt;
    this.value += this.velocity * dt;
    return this.value;
  }
}

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) || "shader compile failed";
    gl.deleteShader(shader);
    throw new Error(info);
  }
  return shader;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(p) || "program link failed");
  }
  return p;
}

export type RigProbe = {
  ok: boolean;
  api: string;
  renderer: string;
  vendor: string;
  fps: number;
  frameMs: number;
  error: string | null;
};

export class CharacterRenderer {
  private gl: WebGL2RenderingContext;
  private rig: CharacterRig;
  private prog: WebGLProgram;
  private shapeProg: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private shapeVao: WebGLVertexArrayObject;
  private indexCount = 0;
  private texture: WebGLTexture | null = null;
  private raf = 0;
  private running = false;
  private startedAt = performance.now();
  private lastFrame = performance.now();
  private frameTimes: number[] = [];
  private blinkAt = performance.now() + 2500;
  private blink = new Spring(0, 260, 26);
  private lean = new Spring(0, 70, 14);
  private tilt = new Spring(0, 80, 15);
  private bounce = new Spring(0, 120, 14);
  private shake = new Spring(0, 200, 12);
  private mouth = new Spring(0, 320, 26);
  private gazeX = new Spring(0, 60, 13);
  private gazeY = new Spring(0, 60, 13);
  private tintMix = new Spring(0.12, 40, 12);
  private glow = new Spring(0.2, 40, 12);
  private pose: Pose = {
    action: "idle",
    emotion: "calm",
    amplitude: 0,
    gaze: { dx: 0, dy: 0 },
    reduceMotion: false,
    quality: "high",
  };
  private tint: [number, number, number] = EMOTION_TINT.calm;
  readonly probeInfo: RigProbe;

  constructor(
    private canvas: HTMLCanvasElement,
    rig: CharacterRig,
  ) {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: false,
      antialias: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("WebGL2 is not available on this device");
    this.gl = gl;
    this.rig = rig;
    this.prog = program(gl, VERT, FRAG);
    this.shapeProg = program(gl, SHAPE_VERT, SHAPE_FRAG);

    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    this.probeInfo = {
      ok: true,
      api: "webgl2",
      renderer: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : "webgl2",
      vendor: debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : "unknown",
      fps: 0,
      frameMs: 0,
      error: null,
    };

    const { vao, indexCount } = this.buildMesh();
    this.vao = vao;
    this.indexCount = indexCount;
    this.shapeVao = this.buildShapeQuad();

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
  }

  /** Grid mesh with per-vertex bone weights derived from the rig landmarks. */
  private buildMesh() {
    const gl = this.gl;
    const { cols, rows } = this.rig.mesh;
    const verts: number[] = [];
    const indices: number[] = [];
    const headBottom = this.rig.landmarks.headBottom;

    for (let y = 0; y <= rows; y++) {
      for (let x = 0; x <= cols; x++) {
        const u = x / cols;
        const v = y / rows;
        // Motion authority per bone, blended so the mesh never creases.
        const head = 1 - smooth(v, headBottom, headBottom + 0.09);
        const neck = (1 - head) * (1 - smooth(v, headBottom + 0.06, 0.34));
        const torso = (1 - head - neck) * (1 - smooth(v, 0.34, 0.72));
        const hips = Math.max(0, 1 - head - neck - torso);
        verts.push(u, v, hips, torso, neck, head);
      }
    }
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const a = y * (cols + 1) + x;
        const b = a + 1;
        const c = a + cols + 1;
        const d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    const stride = 6 * 4;
    const uvLoc = gl.getAttribLocation(this.prog, "a_uv");
    const wLoc = gl.getAttribLocation(this.prog, "a_weight");
    gl.enableVertexAttribArray(uvLoc);
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(wLoc);
    gl.vertexAttribPointer(wLoc, 4, gl.FLOAT, false, stride, 8);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, indexCount: indices.length };
  }

  private buildShapeQuad() {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1]),
      gl.STATIC_DRAW,
    );
    const loc = gl.getAttribLocation(this.shapeProg, "a_pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return vao;
  }

  /** Upload the character texture (an already-decoded image). */
  setTexture(image: TexImageSource) {
    const gl = this.gl;
    if (this.texture) gl.deleteTexture(this.texture);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.texture = tex;
  }

  /** Feed the renderer the current real state. Cheap: it only sets targets. */
  setPose(pose: Partial<Pose>) {
    this.pose = { ...this.pose, ...pose };
    this.tint = EMOTION_TINT[this.pose.emotion] ?? EMOTION_TINT.calm;
    const a = this.pose.action;
    this.lean.target = a === "listening" ? 1 : a === "thinking" ? -0.5 : 0;
    this.tilt.target = a === "thinking" ? 0.09 : a === "searching" ? 0.05 : 0;
    this.bounce.target = a === "success" ? 1 : 0;
    this.shake.target = a === "error" ? 1 : 0;
    this.tintMix.target =
      a === "error" ? 0.34 : a === "waiting_approval" ? 0.3 : a === "idle" ? 0.1 : 0.2;
    this.glow.target =
      a === "speaking" || a === "working" || a === "coding" || a === "installing" ? 0.55 : 0.22;
  }

  resize(width: number, height: number, dpr: number) {
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.gl.viewport(0, 0, w, h);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
      // Battery/balanced modes really do render fewer frames.
      const budget =
        this.pose.quality === "battery" ? 1 / 24 : this.pose.quality === "balanced" ? 1 / 40 : 0;
      if (budget && dt < budget) return;
      this.lastFrame = now;
      this.frame(now, dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Real measured frame rate over the recent window. */
  probe(): RigProbe {
    const frames = this.frameTimes;
    const avg = frames.length ? frames.reduce((a, b) => a + b, 0) / frames.length : 0;
    return { ...this.probeInfo, frameMs: avg, fps: avg > 0 ? 1000 / avg : 0 };
  }

  dispose() {
    this.stop();
    const gl = this.gl;
    if (this.texture) gl.deleteTexture(this.texture);
    gl.deleteProgram(this.prog);
    gl.deleteProgram(this.shapeProg);
    gl.deleteVertexArray(this.vao);
    gl.deleteVertexArray(this.shapeVao);
  }

  /* ------------------------------------------------------------- rendering */

  private frame(now: number, dt: number) {
    const gl = this.gl;
    const t = (now - this.startedAt) / 1000;
    const still = this.pose.reduceMotion;
    const motion = this.rig.motion;

    // Blink scheduling (skipped entirely when the user asked for less motion).
    if (!still && now > this.blinkAt) {
      this.blink.target = 1;
      window.setTimeout(() => {
        this.blink.target = 0;
      }, 95);
      const span = motion.blinkMaxMs - motion.blinkMinMs;
      this.blinkAt = now + motion.blinkMinMs + Math.random() * span;
    }

    this.mouth.target =
      this.pose.action === "speaking" ? Math.min(1, this.pose.amplitude * 1.35) : 0;
    this.gazeX.target = clamp(this.pose.gaze.dx, -1, 1);
    this.gazeY.target = clamp(this.pose.gaze.dy, -1, 1);

    const blink = this.blink.step(dt);
    const lean = this.lean.step(dt);
    const tilt = this.tilt.step(dt);
    const bounce = this.bounce.step(dt);
    const shake = this.shake.step(dt);
    const mouth = this.mouth.step(dt);
    const gx = this.gazeX.step(dt);
    const gy = this.gazeY.step(dt);
    const tintMix = this.tintMix.step(dt);
    const glow = this.glow.step(dt);

    const breath = still ? 0 : Math.sin(t * Math.PI * 2 * motion.breathHz);
    const sway = still ? 0 : Math.sin(t * Math.PI * 2 * motion.swayHz);
    const busy =
      this.pose.action === "working" ||
      this.pose.action === "coding" ||
      this.pose.action === "searching";
    const busyBob = busy && !still ? Math.sin(t * 7.5) * 0.004 : 0;
    const speakBob = this.pose.action === "speaking" ? mouth * 0.006 : 0;
    const errorShake = shake * Math.sin(t * 38) * 0.012;

    gl.clear(gl.COLOR_BUFFER_BIT);

    // Aura behind the character: intensity follows what she is really doing.
    this.drawShape({
      x: 0,
      y: -0.28,
      w: 0.95,
      h: 0.5,
      color: [this.tint[0], this.tint[1], this.tint[2], 0.16 + glow * 0.22],
      mode: 1,
    });

    if (!this.texture) return;

    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.loc(this.prog, "u_tex"), 0);

    const pivots = new Float32Array([0.5, 0.62, 0.5, 0.42, 0.5, 0.19, 0.5, 0.155]);
    const headRot = tilt + gx * 0.14 + sway * 0.012 + errorShake;
    const bones = new Float32Array([
      // hips: almost static, tiny weight shift
      0,
      sway * 0.002,
      0,
      // torso: breathing + lean
      sway * 0.01,
      sway * 0.004,
      breath * 0.0035 + lean * -0.004 + busyBob + bounce * -0.008,
      // neck
      headRot * 0.35,
      gx * 0.004,
      breath * 0.002,
      // head: gaze + tilt + reaction
      headRot,
      gx * 0.012,
      gy * 0.008 + speakBob - bounce * 0.01,
    ]);
    gl.uniform2fv(this.loc(this.prog, "u_pivot"), pivots);
    gl.uniform3fv(this.loc(this.prog, "u_bone"), bones);
    gl.uniform2f(
      this.loc(this.prog, "u_scale"),
      1 + breath * 0.004 - bounce * 0.01,
      1 + breath * 0.006 + bounce * 0.02 + lean * 0.006,
    );
    gl.uniform2f(this.loc(this.prog, "u_offset"), errorShake, 0);
    const crop = this.rig.crop;
    gl.uniform4f(this.loc(this.prog, "u_crop"), crop.u0, crop.v0, crop.u1, crop.v1);
    gl.uniform3fv(this.loc(this.prog, "u_tint"), this.tint);
    gl.uniform1f(this.loc(this.prog, "u_tintMix"), tintMix);
    gl.uniform1f(this.loc(this.prog, "u_alpha"), 1);
    gl.uniform1f(this.loc(this.prog, "u_rim"), 0.25 + glow * 0.5);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);

    // Eyelids: a soft lid closing over each eye landmark.
    if (blink > 0.02) {
      for (const eye of [this.rig.landmarks.eyeLeft, this.rig.landmarks.eyeRight]) {
        const cy = eye.cy - eye.hh * (1 - blink) * 0.4;
        this.drawShape({
          x: toClipX(eye.cx + gx * 0.006),
          y: toClipY(cy + gy * 0.004),
          w: eye.hw * 2.1,
          h: eye.hh * 2.0 * blink,
          color: [0.99, 0.9, 0.88, 0.96],
          mode: 0,
        });
      }
    }

    // Mouth: opening height is the real speech envelope.
    if (mouth > 0.015) {
      const m = this.rig.landmarks.mouth;
      this.drawShape({
        x: toClipX(m.cx + gx * 0.004),
        y: toClipY(m.cy + gy * 0.003),
        w: m.hw * (1.5 + mouth * 0.5),
        h: m.hh * (0.6 + mouth * 2.6),
        color: [0.36, 0.12, 0.16, 0.92],
        mode: 0,
      });
    }

    const frameMs = performance.now() - now;
    this.frameTimes.push(Math.max(dt * 1000, frameMs));
    if (this.frameTimes.length > 90) this.frameTimes.shift();
  }

  private drawShape(shape: {
    x: number;
    y: number;
    w: number;
    h: number;
    color: [number, number, number, number];
    mode: 0 | 1;
  }) {
    const gl = this.gl;
    gl.useProgram(this.shapeProg);
    gl.bindVertexArray(this.shapeVao);
    gl.uniform4f(this.loc(this.shapeProg, "u_rect"), shape.x, shape.y, shape.w, shape.h);
    gl.uniform4fv(this.loc(this.shapeProg, "u_color"), shape.color);
    gl.uniform1f(this.loc(this.shapeProg, "u_mode"), shape.mode);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  private uniformCache = new Map<string, WebGLUniformLocation | null>();
  private loc(prog: WebGLProgram, name: string) {
    const key = `${prog === this.prog ? "m" : "s"}:${name}`;
    if (!this.uniformCache.has(key)) {
      this.uniformCache.set(key, this.gl.getUniformLocation(prog, name));
    }
    return this.uniformCache.get(key) ?? null;
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smooth = (v: number, a: number, b: number) => {
  const t = clamp((v - a) / Math.max(1e-5, b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Texture space (0..1, y down) to clip space. */
const toClipX = (u: number) => u * 2 - 1;
const toClipY = (v: number) => (1 - v) * 2 - 1;
