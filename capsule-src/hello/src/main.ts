import "./style.css";

/**
 * SPECTRA · 胶囊版 —— 一个实时现场：着色器背景 + 流场粒子 + 现场写回磁盘。
 *
 * 一屏之内有四个实时系统：GPU 片元着色器背景、旋度流场粒子、指针驱动、以及
 * **把现场写回磁盘**（预设 JSON + 当前画面 PNG）。
 *
 * 胶囊能力（面板上每条都能当场验证）：
 *   1. 单文件 / 零外部资源 —— 构建产物就是一个 html，资源条目数实时显示；
 *   2. 数据写回磁盘 —— 预设与滑杆写入 data/presets.json；
 *   3. 文件即数据 —— 刷新后原样恢复；
 *   4. ETag / If-Match —— 过期版本保存会被 412 拒绝，不静默覆盖；
 *   5. 二进制也能存 —— 「导出 PNG」把画面写进 data/snapshots/*.png（不是下载，是落盘）。
 *
 * 打开方式：/capsules/hello/（尾斜杠让相对路径落在胶囊自己的文件夹里）。
 */

type Palette = {
  hot: [number, number, number];
  warm: [number, number, number];
  cool: [number, number, number];
  /** 亮度增益：主题色比马卡龙深，需要抬一档才在深底上好看 */
  gain?: number;
};
type Params = { speed: number; trail: number; density: number; warp: number };
type Snapshot = { name: string; bytes: number; at: string };
type Preset = { id: string; seed: number; palette: number; params: Params; created: string };
type SpectraFile = {
  version: 1;
  last: { seed: number; palette: number; params: Params } | null;
  presets: Preset[];
  snapshots: Snapshot[];
  updated: string;
};

// 三套马卡龙配色 = 三原色的变种：绿（主题色）/ 红 / 蓝。
// 低饱和、高明度，放在深色底上像三块糖；hot 是主色，cool / warm 是它的相邻色。
const PAL: Palette[] = [
  // ① 苔绿（Y-Hub 主题色 #4E7A5C / #9CC3A6 的粉彩版；深色底需要抬一档亮度）
  { hot: [127, 176, 143], warm: [238, 246, 232], cool: [176, 214, 196], gain: 1.28 },
  // ② 珊瑚红 · 蜜桃 · 奶油
  { hot: [255, 143, 152], warm: [255, 234, 214], cool: [255, 197, 176] },
  // ③ 海盐蓝 · 雾紫 · 薄荷
  { hot: [140, 190, 255], warm: [222, 216, 255], cool: [168, 236, 236] },
];

const DEFAULTS: Params = { speed: 0.55, trail: 0.12, density: 0.62, warp: 0.5 };
const DATA_URL = new URL("data/presets.json", location.href).toString();

const state = {
  seed: 0,
  palette: 0,
  params: { ...DEFAULTS },
  running: true,
  etag: null as string | null,
  persist: "none" as "disk" | "local" | "none",
  presets: [] as Preset[],
  snapshots: [] as Snapshot[],
  dataEtag: null as string | null,
  readonly: false,
  audioOn: false,
  volume: 0.5,
  audioLevel: 0,
};

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <canvas id="gl"></canvas>
  <canvas id="fx"></canvas>
  <div id="veil"></div>
  <div id="grain"></div>

  <header id="hud">
    <div class="brand">SPECTRA <span>capsule demo</span></div>
    <div class="meta live"><i></i>LIVE</div>
    <div class="meta">SEED <b id="hud-seed">······</b></div>
    <div class="meta">PAL <b id="hud-pal">1</b>/<span id="hud-pal-max">3</span></div>
    <div class="meta"><b id="hud-fps">60</b> FPS</div>
    <div class="meta">GL <b id="hud-gl">…</b></div>
    <div class="meta">AUDIO <b id="hud-audio">OFF</b></div>
    <div class="grow"></div>
    <div class="meta">SPACE pause · 1–3 palette · R reseed · E export PNG · P sound · ? help</div>
  </header>

  <div id="transport">
    <button id="btn-play" title="Pause / resume (Space)">Pause</button>
    <div class="pals" id="pals"></div>
    <button id="btn-audio" title="Toggle the sound field (P)">Sound</button>
    <button id="btn-seed" title="Reseed (R)">Reseed</button>
    <button id="btn-shot" title="Write the current frame to PNG (E)">Export PNG</button>
    <button id="btn-panel" title="Capability panel">Checks</button>
  </div>

  <aside id="panel" data-collapsed="false">
    <div class="card">
      <h3>What this capsule can do <span class="tag" id="cap-file">—</span></h3>
      <ul class="caps">
        <li>
          <span class="i">◈</span>
          <div class="body">
            <div class="head"><span class="t">Single file, works offline</span><span class="v" id="cap-net">0 external</span></div>
            <div class="d">Shader and particles are computed on this page; nothing is fetched</div>
          </div>
        </li>
        <li>
          <span class="i">↓</span>
          <div class="body">
            <div class="head"><span class="t">Writes back to disk</span><span class="v" id="cap-json">—</span></div>
            <div class="d">Presets and sliders go into this file</div>
          </div>
        </li>
        <li>
          <span class="i">↻</span>
          <div class="body">
            <div class="head"><span class="t">The file is the data</span><span class="v" id="cap-restore">—</span></div>
            <div class="d">Reload restores seed, palette and sliders</div>
          </div>
        </li>
        <li>
          <span class="i">⌥</span>
          <div class="body">
            <div class="head"><span class="t">Versioning and conflict protection</span><span class="v" id="cap-etag">—</span></div>
            <div class="d">ETag / If-Match: a stale save is rejected with 412</div>
          </div>
        </li>
        <li>
          <span class="i">▣</span>
          <div class="body">
            <div class="head"><span class="t">Binary data too</span><span class="v" id="cap-shots">0 files</span></div>
            <div class="d">Export PNG writes straight into <code>data/snapshots/</code></div>
          </div>
        </li>
      </ul>
      <div class="note" id="persist-note" hidden></div>
      <div class="row">
        <button class="btn primary" id="btn-save">Save scene</button>
        <button class="btn" id="btn-conflict">Try a conflicting save</button>
      </div>
    </div>

    <div class="card">
      <h3>Scene parameters</h3>
      <div class="ctrls">
        <label class="ctrl">Flow <input id="s-speed" type="range" min="0" max="1" step="0.01" value="0.55" /><output id="o-speed">55</output></label>
        <label class="ctrl">Trail <input id="s-trail" type="range" min="0.02" max="0.5" step="0.01" value="0.12" /><output id="o-trail">12</output></label>
        <label class="ctrl">Density <input id="s-density" type="range" min="0.1" max="1" step="0.01" value="0.62" /><output id="o-density">62</output></label>
        <label class="ctrl">Warp <input id="s-warp" type="range" min="0" max="1" step="0.01" value="0.5" /><output id="o-warp">50</output></label>
        <label class="ctrl">Volume <input id="s-vol" type="range" min="0" max="1" step="0.01" value="0.5" /><output id="o-vol">50</output></label>
      </div>
    </div>

    <div class="card">
      <h3>Presets <span class="tag" id="preset-count">0</span></h3>
      <div class="presets" id="presets"></div>
      <div class="row">
        <button class="btn ghost" id="btn-clear-presets">Clear presets</button>
      </div>
    </div>
  </aside>

  <div id="status">
    <span class="st" id="save-state" data-tone="idle"><i></i><span id="save-text">Ready</span></span>
    <span class="opt">JSON <code id="bar-path">data/presets.json</code></span>
    <span class="opt">ETag <code id="bar-etag">—</code></span>
    <span class="opt">Snapshots <code id="bar-shots">0</code></span>
    <span>Sound <code id="bar-audio">OFF</code></span>
  </div>

  <div id="toasts" aria-live="polite"></div>

  <div id="help">
    <div class="card box">
      <h3>Keyboard and pointer <span class="tag">?</span></h3>
      <ul>
        <li><kbd>SPACE</kbd> pause / resume</li>
        <li><kbd>1</kbd>–<kbd>3</kbd> switch palette (green / red / blue)</li>
        <li><kbd>R</kbd> reseed (the field rearranges)</li>
        <li><kbd>E</kbd> export the current frame as PNG (written to data/snapshots/)</li>
        <li><kbd>P</kbd> toggle the sound field (55 Hz, resonates with the frame)</li>
        <li><kbd>drag</kbd> the pointer disturbs the flow field and shader</li>
        <li><kbd>?</kbd> toggle this panel</li>
      </ul>
      <div class="row" style="padding:0 14px 14px">
        <button class="btn" id="btn-help-close">Close</button>
      </div>
    </div>
  </div>
`;

/* ------------------------------------------------------------------ 工具 */

const $ = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel)!;

function toast(text: string, tone: "info" | "warn" | "error" = "info") {
  const host = $("#toasts");
  const el = document.createElement("div");
  el.className = "toast";
  el.dataset.tone = tone;
  el.textContent = text;
  host.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity 240ms, transform 240ms";
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    setTimeout(() => el.remove(), 260);
  }, 3600);
}

function setState(tone: "idle" | "ok" | "warn" | "error", text: string) {
  $("#save-state").dataset.tone = tone;
  $("#save-text").textContent = text;
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

const shortEtag = (e: string | null) => (e ? e.replace(/"/g, "").slice(0, 6) : "—");
const seedHex = () => state.seed.toString(16).padStart(6, "0").toUpperCase();

function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOCAL_KEY = "spectra.capsule.v1";

/* ------------------------------------------------------------------ WebGL 背景 */

const GL_VS = "attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }";
const GL_FS = [
  "precision highp float;",
  "uniform vec2 u_res; uniform float u_time; uniform vec2 u_mouse;",
  "uniform vec3 u_hot; uniform vec3 u_cool; uniform vec3 u_warm;",
  "uniform float u_energy; uniform float u_seed; uniform float u_warp;",
  "uniform float u_mouseVel; uniform float u_audio; uniform float u_gain;",
  "float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }",
  "float n2(vec2 p){",
  "  vec2 i = floor(p), f = fract(p);",
  "  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);",
  "  return mix(mix(hash(i), hash(i + vec2(1,0)), f.x), mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);",
  "}",
  "float fbm(vec2 p){",
  "  float s = 0.0, a = 0.52;",
  "  for (int i = 0; i < 5; i++){ s += a * n2(p); p = p * 2.03 + vec2(11.3, 7.7); a *= 0.5; }",
  "  return s;",
  "}",
  "void main(){",
  "  vec2 R = u_res;",
  "  vec2 uv = gl_FragCoord.xy / R;",
  "  vec2 p = (gl_FragCoord.xy - 0.5 * R) / min(R.x, R.y);",
  "  float t = u_time * 0.11;",
  "  p += u_seed * 0.013;",
  "  // 指针是一个透镜：把采样坐标朝指针方向掰过去，靠近时fbm结构会被拉出漩涡",
  "  vec2 m = (u_mouse - 0.5) * vec2(R.x / min(R.x, R.y), R.y / min(R.x, R.y));",
  "  vec2 d = p - m; float md = max(length(d), 1e-4);",
  "  float lens = exp(-md * md * 2.0) * (0.4 + u_energy * 0.6 + u_mouseVel * 0.9);",
  "  p -= (d / md) * lens * 0.13;",
  "  vec2 q = vec2(fbm(p * 1.7 + t), fbm(p * 1.7 + vec2(3.1, 5.7) - t * 0.75));",
  "  vec2 r = vec2(fbm(p + q * (1.2 + u_warp * 1.4) + vec2(1.9, 4.2)), fbm(p + q * (1.1 + u_warp) + vec2(5.3, 1.1)));",
  "  float f = fbm(p + r * (0.8 + u_warp * 0.8));",
  "  vec3 col = mix(u_cool * 0.30, u_hot * 0.92, clamp(f * f * 2.4, 0.0, 1.0));",
  "  col = mix(col, u_warm * 0.5, clamp(length(r) * 0.42, 0.0, 1.0));",
  "  float band = 0.5 + 0.5 * sin((f * 4.2 + r.x * 2.2) * 3.14159 + t * 2.0);",
  "  col += u_hot * band * band * 0.16 * u_energy;",
  "  // 指针光斑 + 呼吸的同心波纹（速度越快越亮、越大）",
  "  col += u_hot * (0.15 + u_mouseVel * 0.45) * exp(-md * 2.2) * (0.45 + u_energy * 0.8);",
  "  float rings = sin(md * 24.0 - u_time * 4.2);",
  "  col += u_hot * 0.09 * smoothstep(0.55, 1.0, rings) * exp(-md * 1.6) * (0.4 + u_mouseVel);",
  "  col += u_warm * 0.08 * exp(-md * 6.5) * (0.5 + u_audio * 2.0);",
  "  // 声场：低频脉动沿画面横向扫过",
  "  col += u_hot * u_audio * 0.14 * (0.5 + 0.5 * sin(uv.y * 9.0 - u_time * 2.2));",
  "  col *= 1.0 - 0.42 * dot(p, p) * 0.38;",
  "  col *= 1.0 - smoothstep(1.15, 1.85, length(p)) * 0.55;",
  "  col = mix(col, col * col * 1.06, 0.35);",
  "  col *= u_gain;",
  "  col += (hash(gl_FragCoord.xy + floor(u_time * 4.0)) - 0.5) * 0.017;",
  "  gl_FragColor = vec4(col, 1.0);",
  "}",
].join("\n");

class Background {
  gl: WebGLRenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private canvas: HTMLCanvasElement;
  private w = 1;
  private h = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    try {
      this.gl = (canvas.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true }) ||
        canvas.getContext("webgl", { alpha: false, antialias: false, preserveDrawingBuffer: true })) as WebGLRenderingContext | null;
    } catch {
      this.gl = null;
    }
    $("#hud-gl").textContent = this.gl ? (this.gl instanceof WebGL2RenderingContext ? "WebGL2" : "WebGL1") : "CSS";
    if (this.gl) this.build();
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  get size() {
    return { w: this.w, h: this.h };
  }

  private build() {
    const gl = this.gl!;
    const mk = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.warn(gl.getShaderInfoLog(sh));
        return null;
      }
      return sh;
    };
    const vs = mk(gl.VERTEX_SHADER, GL_VS);
    const fs = mk(gl.FRAGMENT_SHADER, GL_FS);
    if (!vs || !fs) return;
    const pr = gl.createProgram()!;
    gl.attachShader(pr, vs);
    gl.attachShader(pr, fs);
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return;
    gl.useProgram(pr);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.prog = pr;
    for (const name of ["u_res", "u_time", "u_mouse", "u_hot", "u_cool", "u_warm", "u_energy", "u_seed", "u_warp", "u_mouseVel", "u_audio", "u_gain"]) {
      this.u[name] = gl.getUniformLocation(pr, name);
    }
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(1, Math.floor(window.innerWidth));
    this.h = Math.max(1, Math.floor(window.innerHeight));
    this.canvas.width = Math.floor(this.w * dpr);
    this.canvas.height = Math.floor(this.h * dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    if (this.gl) this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  draw(time: number, mouse: { x: number; y: number }, energy: number, mouseVel: number, audio: number) {
    const gl = this.gl;
    if (!gl || !this.prog) return;
    const p = PAL[state.palette];
    gl.useProgram(this.prog);
    gl.uniform2f(this.u.u_res, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.u.u_time, time);
    gl.uniform2f(this.u.u_mouse, mouse.x, mouse.y);
    gl.uniform3f(this.u.u_hot, p.hot[0] / 255, p.hot[1] / 255, p.hot[2] / 255);
    gl.uniform3f(this.u.u_cool, p.cool[0] / 255, p.cool[1] / 255, p.cool[2] / 255);
    gl.uniform3f(this.u.u_warm, p.warm[0] / 255, p.warm[1] / 255, p.warm[2] / 255);
    gl.uniform1f(this.u.u_energy, energy);
    gl.uniform1f(this.u.u_seed, state.seed / 4294967295);
    gl.uniform1f(this.u.u_warp, state.params.warp);
    gl.uniform1f(this.u.u_mouseVel, mouseVel);
    gl.uniform1f(this.u.u_audio, audio);
    gl.uniform1f(this.u.u_gain, p.gain ?? 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

/* ------------------------------------------------------------------ 流场粒子 */

class Flow {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private w = 1;
  private h = 1;
  private dpr = 1;
  private n = 1150;
  private px = new Float32Array(this.n);
  private py = new Float32Array(this.n);
  private ox = new Float32Array(this.n);
  private oy = new Float32Array(this.n);
  private tone = new Float32Array(this.n);
  private phase = new Float32Array(this.n);
  private vx = new Float32Array(this.n);
  private vy = new Float32Array(this.n);
  private rng = mulberry32(1);
  quality = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.reseed();
  }

  resize() {
    // 粒子层不需要 Retina：1x 渲染，省下来的像素直接换成帧率
    this.dpr = Math.min(window.devicePixelRatio || 1, 1);
    this.w = Math.max(1, window.innerWidth);
    this.h = Math.max(1, window.innerHeight);
    this.canvas.width = Math.floor(this.w * this.dpr);
    this.canvas.height = Math.floor(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  reseed() {
    this.rng = mulberry32(state.seed || 1);
    for (let i = 0; i < this.n; i += 1) {
      this.px[i] = this.rng() * this.w;
      this.py[i] = this.rng() * this.h;
      this.ox[i] = this.px[i];
      this.oy[i] = this.py[i];
      this.tone[i] = this.rng();
      this.phase[i] = this.rng() * Math.PI * 2;
      this.vx[i] = 0;
      this.vy[i] = 0;
    }
    this.ctx.clearRect(0, 0, this.w, this.h);
  }

  step(dt: number, t: number, mouse: { x: number; y: number }, dragging: boolean, audio: number) {
    const { speed, trail } = state.params;
    const active = Math.floor(this.n * (0.1 + state.params.density * this.quality * 0.9));
    const force = (120 + speed * 260) * (1 + audio * 0.9);
    const mx = mouse.x * this.w;
    const my = mouse.y * this.h;

    for (let i = 0; i < active; i += 1) {
      this.ox[i] = this.px[i];
      this.oy[i] = this.py[i];
      const x = this.px[i];
      const y = this.py[i];
      const f = 0.0032 + speed * 0.0022;
      const a =
        Math.sin(y * f + t * (0.35 + speed * 0.9) + this.phase[i]) +
        Math.cos(x * f * 0.9 - t * (0.24 + speed * 0.6) + this.phase[i] * 1.7);
      let tx = Math.cos(a * Math.PI) * force;
      let ty = Math.sin(a * Math.PI) * force;

      // 指针是个小漩涡：靠近的粒子被往里拉 + 绕着转（拖拽时更猛）
      const dx = x - mx;
      const dy = y - my;
      const d2 = dx * dx + dy * dy;
      const R = 460;
      if (d2 < R * R) {
        const dist = Math.sqrt(d2) || 1;
        const fall = 1 - dist / R;
        const nx = dx / dist;
        const ny = dy / dist;
        const pull = (dragging ? 2.6 : 1.5) * fall * fall;
        const swirl = (dragging ? 1.9 : 0.9) * fall;
        tx += (-nx * pull - ny * swirl) * 460;
        ty += (-ny * pull + nx * swirl) * 460;
      }

      // 速度向目标场缓一缓：轨迹是流线，不是锯齿
      this.vx[i] += (tx - this.vx[i]) * Math.min(1, dt * 9);
      this.vy[i] += (ty - this.vy[i]) * Math.min(1, dt * 9);
      this.px[i] = x + this.vx[i] * dt;
      this.py[i] = y + this.vy[i] * dt;

      if (this.px[i] < -20 || this.px[i] > this.w + 20 || this.py[i] < -20 || this.py[i] > this.h + 20) {
        this.px[i] = this.rng() * this.w;
        this.py[i] = this.rng() * this.h;
        this.ox[i] = this.px[i];
        this.oy[i] = this.py[i];
      }
    }

    const ctx = this.ctx;
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = 1;
    ctx.fillStyle = `rgba(0,0,0,${trail})`;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.globalCompositeOperation = "source-over";
    ctx.lineCap = "round";

    const pal = PAL[state.palette];
    for (let i = 0; i < active; i += 1) {
      const x = this.px[i];
      const y = this.py[i];
      const dx = x - this.ox[i];
      const dy = y - this.oy[i];
      const d2 = dx * dx + dy * dy;
      if (d2 > 900) continue;
      const tone = this.tone[i];
      const c =
        tone < 0.62 ? mix(pal.hot, pal.cool, tone / 0.62) : mix(pal.cool, pal.warm, (tone - 0.62) / 0.38);
      ctx.strokeStyle = rgba(c, Math.min(0.58, 0.13 + Math.sqrt(d2) * 0.045));
      ctx.lineWidth = 0.6 + tone * 1.1;
      ctx.beginPath();
      ctx.moveTo(this.ox[i], this.oy[i]);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function rgba(c: [number, number, number], a: number) {
  return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
}

const bg = new Background($<HTMLCanvasElement>("#gl"));
const flow = new Flow($<HTMLCanvasElement>("#fx"));

/* ------------------------------------------------------------------ 主循环 */

const mouse = { x: 0.5, y: 0.5, dragging: false, vel: 0 };
let last = performance.now();
let time = 0;
let energy = 0.4;
let fps = 60;
let frames = 0;
let fpsAt = performance.now();

/* 指针的「看得见」的反馈：一个跟着手走的光环，越快越大 */
const cursor = document.createElement("div");
cursor.id = "cursor";
cursor.innerHTML = '<div class="core"></div><div class="ring"></div>';
document.body.appendChild(cursor);
let px0 = window.innerWidth / 2;
let py0 = window.innerHeight / 2;
let ringScale = 1;

window.addEventListener("pointermove", (e) => {
  mouse.x = e.clientX / window.innerWidth;
  mouse.y = e.clientY / window.innerHeight;
  const dx = e.clientX - px0;
  const dy = e.clientY - py0;
  px0 = e.clientX;
  py0 = e.clientY;
  const sp = Math.hypot(dx, dy);
  mouse.vel = Math.min(1, mouse.vel + sp / 90);
  ringScale = 1 + Math.min(1.2, sp / 70);
  cursor.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0)`;
  cursor.dataset.active = "true";
  cursor.style.setProperty("--scale", ringScale.toFixed(2));
  energy = Math.min(1, energy + 0.02 + sp / 400);
});

window.addEventListener("pointerdown", () => {
  mouse.dragging = true;
  energy = 1;
  cursor.dataset.down = "true";
});

window.addEventListener("pointerup", () => {
  mouse.dragging = false;
  cursor.dataset.down = "false";
});

function loop(now: number) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (state.running) {
    time += dt;
    const level = readAudioLevel();
    state.audioLevel += (level - state.audioLevel) * Math.min(1, dt * 8);
    flow.step(dt, time, mouse, mouse.dragging, state.audioLevel);
    energy = Math.max(0.3, energy - dt * 0.5);
  }
  bg.draw(time, mouse, energy, mouse.vel, state.audioLevel);
  mouse.vel = Math.max(0, mouse.vel - dt * 2.6);

  frames += 1;
  if (now - fpsAt > 500) {
    fps = Math.round((frames * 1000) / (now - fpsAt));
    frames = 0;
    fpsAt = now;
    $("#hud-fps").textContent = String(fps);
    if (state.audioOn) $("#bar-audio").textContent = `ON · ${Math.round(state.audioLevel * 100)}%`;
  }
}

/* ------------------------------------------------------------------ 声场 */

/**
 * 55 Hz 低频声场：5 个分音 + 粉红噪声 + 低通（LFO 扫频）+ 反馈延迟。
 * 与频谱图无关，纯粹是「呼吸」——它的包络会喂回着色器与粒子速度。
 */
const AUDIO = {
  ac: null as AudioContext | null,
  master: null as GainNode | null,
  analyser: null as AnalyserNode | null,
  data: null as Uint8Array | null,
  filt: null as BiquadFilterNode | null,
  oscs: [] as { osc: OscillatorNode; partial: number }[],
  base: 55,
};

function pinkBuffer(ac: AudioContext) {
  const len = Math.floor(ac.sampleRate * 2);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < len; i += 1) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99976 * b0 + w * 0.099046;
    b1 = 0.99685 * b1 + w * 0.2965187;
    b2 = 0.969 * b2 + w * 0.7482012;
    d[i] = (b0 + b1 + b2 + w * 0.1056157) * 0.25;
  }
  return buf;
}

function initAudio() {
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AC) return false;
  const ac = new AC();
  const master = ac.createGain();
  master.gain.value = 0;
  const comp = ac.createDynamicsCompressor();
  const filt = ac.createBiquadFilter();
  filt.type = "lowpass";
  filt.frequency.value = 520;
  filt.Q.value = 7;
  const delay = ac.createDelay(1);
  delay.delayTime.value = 0.32;
  const fb = ac.createGain();
  fb.gain.value = 0.34;
  const an = ac.createAnalyser();
  an.fftSize = 1024;
  const data = new Uint8Array(an.fftSize);

  const lfo = ac.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = 0.07;
  const lfoG = ac.createGain();
  lfoG.gain.value = 260;
  lfo.connect(lfoG);
  lfoG.connect(filt.frequency);
  lfo.start();

  AUDIO.base = 55 * (1 + (state.seed % 13) * 0.012);
  const partials = [1, 1.5, 2, 2.9931, 4.01];
  const levels = [0.34, 0.2, 0.15, 0.09, 0.05];
  const types: OscillatorType[] = ["sine", "sine", "triangle", "sine", "sine"];
  const oscs: { osc: OscillatorNode; partial: number }[] = [];
  partials.forEach((partial, i) => {
    const osc = ac.createOscillator();
    osc.type = types[i];
    osc.frequency.value = AUDIO.base * partial;
    const g = ac.createGain();
    g.gain.value = levels[i];
    const wob = ac.createOscillator();
    wob.frequency.value = 0.05 + i * 0.043;
    const wobG = ac.createGain();
    wobG.gain.value = 0.4 + i * 0.5;
    wob.connect(wobG);
    wobG.connect(osc.frequency);
    wob.start();
    osc.connect(g);
    g.connect(filt);
    osc.start();
    oscs.push({ osc, partial });
  });

  const noise = ac.createBufferSource();
  noise.buffer = pinkBuffer(ac);
  noise.loop = true;
  const ng = ac.createGain();
  ng.gain.value = 0.1;
  noise.connect(ng);
  ng.connect(filt);
  noise.start();

  filt.connect(delay);
  delay.connect(fb);
  fb.connect(delay);
  filt.connect(master);
  delay.connect(master);
  master.connect(comp);
  comp.connect(an);
  comp.connect(ac.destination);

  AUDIO.ac = ac;
  AUDIO.master = master;
  AUDIO.analyser = an;
  AUDIO.data = data;
  AUDIO.filt = filt;
  AUDIO.oscs = oscs;
  return true;
}

function readAudioLevel() {
  if (!state.audioOn || !AUDIO.analyser || !AUDIO.data) return 0;
  AUDIO.analyser.getByteTimeDomainData(AUDIO.data as Uint8Array);
  let sum = 0;
  for (let i = 0; i < AUDIO.data.length; i += 4) {
    const v = (AUDIO.data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / (AUDIO.data.length / 4)) * 6);
}

async function setAudio(on: boolean) {
  if (on && !AUDIO.ac) initAudio();
  if (!AUDIO.ac || !AUDIO.master) return;
  state.audioOn = on;
  const target = on ? state.volume * 0.16 : 0;
  AUDIO.master.gain.cancelScheduledValues(AUDIO.ac.currentTime);
  AUDIO.master.gain.linearRampToValueAtTime(target, AUDIO.ac.currentTime + (on ? 1.2 : 0.35));
  if (on) await AUDIO.ac.resume();
  $("#hud-audio").textContent = on ? "ON" : "OFF";
  $("#bar-audio").textContent = on ? "ON" : "OFF";
  const btn = $("#btn-audio");
  btn.textContent = on ? "Mute" : "Sound";
  btn.classList.toggle("on", on);
}

function retuneAudio() {
  if (!AUDIO.ac) return;
  AUDIO.base = 55 * (1 + (state.seed % 13) * 0.012);
  for (const { osc, partial } of AUDIO.oscs) {
    osc.frequency.setTargetAtTime(AUDIO.base * partial, AUDIO.ac.currentTime, 0.08);
  }
}

/* ------------------------------------------------------------------ 状态应用 */

function applyState(seed: number, palette: number, params: Params) {
  state.seed = seed >>> 0;
  state.palette = Math.max(0, Math.min(PAL.length - 1, palette | 0));
  state.params = { ...DEFAULTS, ...params };
  flow.reseed();
  $("#hud-seed").textContent = seedHex();
  $("#hud-pal").textContent = String(state.palette + 1);
  for (const id of ["speed", "trail", "density", "warp"] as const) {
    const input = $<HTMLInputElement>(`#s-${id}`);
    input.value = String(state.params[id]);
    $(`#o-${id}`).textContent = String(Math.round(state.params[id] * 100));
  }
  document.documentElement.style.setProperty("--accent", `rgb(${PAL[state.palette].cool.join(",")})`);
  retuneAudio();
  renderPals();
}

function renderPals() {
  const host = $("#pals");
  host.innerHTML = "";
  PAL.forEach((p, i) => {
    const b = document.createElement("button");
    b.className = "pal";
    b.title = `Palette ${i + 1}`;
    b.setAttribute("aria-label", `Palette ${i + 1}`);
    b.setAttribute("aria-pressed", String(i === state.palette));
    b.style.background = `linear-gradient(135deg, rgb(${p.hot.join(",")}), rgb(${p.cool.join(",")}))`;
    b.addEventListener("click", () => {
      applyState(state.seed, i, state.params);
      scheduleSave();
    });
    host.appendChild(b);
  });
}

/* ------------------------------------------------------------------ 数据：预设 / 快照 */

function snapshotData(): SpectraFile {
  return {
    version: 1,
    last: { seed: state.seed, palette: state.palette, params: { ...state.params } },
    presets: state.presets,
    snapshots: state.snapshots,
    updated: new Date().toISOString(),
  };
}

function setPersist(mode: "disk" | "local" | "none") {
  state.persist = mode;
  const note = $("#persist-note");
  const capJson = $("#cap-json");
  if (mode === "disk") {
    capJson.textContent = "data/presets.json";
    note.hidden = true;
  } else if (mode === "local") {
    capJson.textContent = "browser-local";
    note.hidden = false;
    note.textContent =
      "The bundled example is read-only: presets and snapshots stay in this browser. Put it in your own capsule library to write to disk (PNG included).";
  } else {
    capJson.textContent = "—";
    note.hidden = true;
  }
}

function saveLocal() {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(snapshotData()));
  } catch {
    /* 隐私模式 */
  }
}

function loadLocal(): SpectraFile | null {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? (JSON.parse(raw) as SpectraFile) : null;
  } catch {
    return null;
  }
}

function adoptData(data: SpectraFile | null) {
  state.presets = Array.isArray(data?.presets) ? data!.presets.slice(-12) : [];
  state.snapshots = Array.isArray(data?.snapshots) ? data!.snapshots.slice(-30) : [];
  renderPresets();
  renderSnapshots();
  if (data?.last) applyState(data.last.seed, data.last.palette, data.last.params);
}

async function loadData(showToast = false) {
  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (res.status === 404) {
      state.dataEtag = null;
      setPersist("disk");
      adoptData(loadLocal());
      setState("idle", "Empty scene (never saved)");
      $("#cap-etag").textContent = "—";
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as SpectraFile;
    state.dataEtag = res.headers.get("ETag");
    setPersist("disk");
    adoptData(data);
    setState("ok", "Scene restored from disk");
    $("#cap-etag").textContent = shortEtag(state.dataEtag);
    $("#bar-etag").textContent = shortEtag(state.dataEtag);
    if (showToast) toast("Re-read the on-disk version — seed, palette and sliders all come from the file");
  } catch (err) {
    state.readonly = true;
    setPersist("local");
    adoptData(loadLocal());
    setState("idle", "Browser-local mode");
    if (showToast) toast(`Could not read the data file: ${String(err)}`, "warn");
  }
}

let saveTimer = 0;
function scheduleSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveData(), 500);
}

async function saveData(forceStale = false) {
  if (state.persist === "local") {
    saveLocal();
    setState("ok", `Saved in the browser · ${state.presets.length} presets`);
    return;
  }
  if (state.persist === "none") return;
  setState("warn", "Saving…");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (forceStale) headers["If-Match"] = '"stale-000000"';
  else if (state.dataEtag) headers["If-Match"] = state.dataEtag;

  try {
    const res = await fetch(DATA_URL, { method: "PUT", headers, body: JSON.stringify(snapshotData()) });
    if (res.status === 204) {
      state.dataEtag = res.headers.get("ETag");
      setState("ok", `Saved · ${new Date().toLocaleTimeString("en-GB", { hour12: false })}`);
      $("#cap-etag").textContent = shortEtag(state.dataEtag);
      $("#bar-etag").textContent = shortEtag(state.dataEtag);
      if (forceStale) toast("It succeeded? Check that the backend really validates If-Match", "warn");
      return;
    }
    if (res.status === 412) {
      if (forceStale) {
        toast("412 conflict: the server refused this overwrite — that is the protection when two people edit at once", "warn");
        return;
      }
      toast("Someone just changed this data (412); the on-disk version was re-read", "warn");
      await loadData();
      return;
    }
    if (res.status === 403 || res.status === 404) {
      state.readonly = true;
      setPersist("local");
      saveLocal();
      setState("ok", "No writable data area → saved in the browser");
      toast("This capsule has no writable folder (the bundled example is read-only). Saved in the browser instead; in your own library it writes to disk", "warn");
      return;
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    setState("error", "Save failed");
    toast(`Save failed: ${String(err)}`, "error");
  }
}

/* ------------------------------------------------------------------ 预设 UI */

function renderPresets() {
  const host = $("#presets");
  host.innerHTML = "";
  $("#preset-count").textContent = String(state.presets.length);
  if (!state.presets.length) {
    const empty = document.createElement("span");
    empty.style.cssText = "font:500 10.5px/1.5 var(--mono);color:var(--dim)";
    empty.textContent = "No presets yet — tune the scene, then hit “Save scene”";
    host.appendChild(empty);
    return;
  }
  for (const p of state.presets) {
    const b = document.createElement("button");
    b.className = "chip";
    b.title = "Click to restore this scene";
    const dot = document.createElement("span");
    dot.className = "dot";
    const pal = PAL[p.palette] ?? PAL[0];
    dot.style.background = `linear-gradient(135deg, rgb(${pal.hot.join(",")}), rgb(${pal.cool.join(",")}))`;
    b.appendChild(dot);
    b.appendChild(document.createTextNode(p.seed.toString(16).padStart(6, "0").toUpperCase()));
    b.addEventListener("click", () => {
      applyState(p.seed, p.palette, p.params);
      scheduleSave();
      toast("Restored this preset (data from data/presets.json)");
    });
    host.appendChild(b);
  }
}

function renderSnapshots() {
  $("#cap-shots").textContent = `${state.snapshots.length} files`;
  $("#bar-shots").textContent = String(state.snapshots.length);
}

$("#btn-save").addEventListener("click", () => {
  const preset: Preset = {
    id: `${seedHex()}-${Date.now().toString(36)}`,
    seed: state.seed,
    palette: state.palette,
    params: { ...state.params },
    created: new Date().toISOString(),
  };
  state.presets = [...state.presets.slice(-11), preset];
  renderPresets();
  void saveData();
  toast(`Scene saved ${seedHex()}`);
});

$("#btn-clear-presets").addEventListener("click", () => {
  state.presets = [];
  renderPresets();
  void saveData();
  toast("Presets cleared (the on-disk copy too)");
});

/* ------------------------------------------------------------------ PNG 导出 */

async function exportPng() {
  const { w, h } = bg.size;
  const scale = Math.min(1, 2200 / Math.max(w, h));
  const off = document.createElement("canvas");
  off.width = Math.floor(w * scale);
  off.height = Math.floor(h * scale);
  const ctx = off.getContext("2d")!;
  ctx.fillStyle = "#05070a";
  ctx.fillRect(0, 0, off.width, off.height);
  try {
    ctx.drawImage($<HTMLCanvasElement>("#gl"), 0, 0, off.width, off.height);
    ctx.drawImage($<HTMLCanvasElement>("#fx"), 0, 0, off.width, off.height);
  } catch {
    /* 个别浏览器不让读 WebGL 画布，退化成只有粒子层 */
  }
  const blob = await new Promise<Blob | null>((resolve) => off.toBlob((b) => resolve(b), "image/png"));
  if (!blob) {
    toast("Export failed: the browser could not produce a PNG", "error");
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = `snapshots/spectra-${stamp}.png`;

  const download = () => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `spectra-${seedHex()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  if (state.persist === "local") {
    download();
    toast("Bundled example is read-only: the PNG was downloaded instead. In your own library it writes into data/snapshots/", "warn");
    return;
  }

  const url = new URL(`data/${name}`, location.href).toString();
  setState("warn", "Writing PNG…");
  try {
    const res = await fetch(url, { method: "PUT", headers: { "Content-Type": "image/png" }, body: blob });
    if (res.status === 204) {
      state.snapshots = [...state.snapshots.slice(-29), { name, bytes: blob.size, at: new Date().toISOString() }];
      renderSnapshots();
      void saveData();
      setState("ok", `PNG written · ${sizeLabel(blob.size)}`);
      toast(`Wrote capsules/hello/data/${name} (${sizeLabel(blob.size)}) — binary works too`);
      return;
    }
    if (res.status === 403 || res.status === 404) {
      state.readonly = true;
      setPersist("local");
      toast("This capsule has no writable folder: the PNG was downloaded instead", "warn");
      download();
      return;
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    setState("error", "PNG write failed");
    toast(`PNG write failed: ${String(err)}`, "error");
  }
}

/* ------------------------------------------------------------------ 控件 */

for (const id of ["speed", "trail", "density", "warp"] as const) {
  const input = $<HTMLInputElement>(`#s-${id}`);
  input.addEventListener("input", () => {
    state.params[id] = Number(input.value);
    $(`#o-${id}`).textContent = String(Math.round(Number(input.value) * 100));
    scheduleSave();
  });
}

const volInput = $<HTMLInputElement>("#s-vol");
volInput.addEventListener("input", () => {
  state.volume = Number(volInput.value);
  $("#o-vol").textContent = String(Math.round(state.volume * 100));
  if (AUDIO.ac && AUDIO.master && state.audioOn) {
    AUDIO.master.gain.setTargetAtTime(state.volume * 0.16, AUDIO.ac.currentTime, 0.15);
  }
});

$("#btn-audio").addEventListener("click", () => void setAudio(!state.audioOn));

$("#btn-play").addEventListener("click", () => {
  state.running = !state.running;
  const btn = $("#btn-play");
  btn.textContent = state.running ? "Pause" : "Resume";
  btn.classList.toggle("on", !state.running);
});

$("#btn-seed").addEventListener("click", () => {
  applyState((Math.random() * 0xffffff) | 0, state.palette, state.params);
  scheduleSave();
});

$("#btn-shot").addEventListener("click", () => void exportPng());

$("#btn-panel").addEventListener("click", () => {
  const panel = $("#panel");
  const collapsed = panel.dataset.collapsed === "true";
  panel.dataset.collapsed = String(!collapsed);
  $("#btn-panel").classList.toggle("on", collapsed);
});

$("#btn-conflict").addEventListener("click", () => {
  if (state.persist !== "disk") {
    toast("Browser-local mode: there is no server ETag to test", "warn");
    return;
  }
  void saveData(true);
});

const help = $("#help");
const toggleHelp = (open?: boolean) => {
  help.dataset.open = String(open ?? help.dataset.open !== "true");
};
$("#btn-help-close").addEventListener("click", () => toggleHelp(false));
help.addEventListener("click", (e) => {
  if (e.target === help) toggleHelp(false);
});

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  const key = e.key.toLowerCase();
  if (e.code === "Space") {
    e.preventDefault();
    $("#btn-play").click();
  } else if (/^[1-3]$/.test(e.key)) {
    applyState(state.seed, Number(e.key) - 1, state.params);
    scheduleSave();
  } else if (key === "r") {
    $("#btn-seed").click();
  } else if (key === "e") {
    void exportPng();
  } else if (key === "p") {
    void setAudio(!state.audioOn);
  } else if (e.key === "?") {
    toggleHelp();
  }
});

window.addEventListener("resize", () => {
  bg.resize();
  flow.resize();
});

/* ------------------------------------------------------------------ 启动 */

async function boot() {
  applyState((Math.random() * 0xffffff) | 0, Math.floor(Math.random() * PAL.length), DEFAULTS);
  $("#btn-panel").classList.add("on");
  $("#o-vol").textContent = String(Math.round(state.volume * 100));
  $("#hud-pal-max").textContent = String(PAL.length);

  try {
    const head = await fetch(location.href, { method: "HEAD", cache: "no-store" });
    const len = Number(head.headers.get("Content-Length") ?? "0");
    $("#cap-file").textContent = len > 0 ? sizeLabel(len) : "Single file";
  } catch {
    $("#cap-file").textContent = "Single file";
  }

  const ext = performance
    .getEntriesByType("resource")
    .filter((r) => !r.name.startsWith(location.origin + "/capsules/hello/"));
  $("#cap-net").textContent = `${ext.length} external`;

  await loadData();
  $("#cap-restore").textContent = "Reload restores";
  requestAnimationFrame(loop);
}

void boot();
