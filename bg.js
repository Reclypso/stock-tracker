// Live backdrop. One full-screen fragment pass (aurora curtains, horizon glow,
// perspective grid floor) plus a drifting starfield drawn as GL points with
// depth and cursor/scroll parallax. Hand-written WebGL, no library.
// Pauses when the tab is hidden, renders a single still frame under reduced
// motion, and leaves the CSS gradient fallback in place if WebGL is missing.

const FRAG = `
precision mediump float;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uMouse;
uniform float uScroll;
uniform float uMood;
uniform float uPulse;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  vec2 m = uMouse * 0.035;
  float t = uTime * 0.05;

  vec3 col = mix(vec3(0.010, 0.012, 0.030), vec3(0.018, 0.024, 0.060), smoothstep(0.0, 1.0, uv.y));

  // Aurora curtains, drifting slowly, tinted by the book's mood.
  vec2 ap = p + m * 1.4;
  float warp = fbm(vec2(ap.x * 1.1 + t * 1.6, ap.y * 0.7 - t * 0.8));
  float curtain = fbm(vec2(ap.x * 2.2 + warp * 1.8 - t * 2.2, t * 0.6 + warp));
  float ay = uv.y - 0.70 + uScroll * 0.10 - (curtain - 0.5) * 0.42;
  float aur = exp(-ay * ay * 14.0) * smoothstep(0.28, 0.85, curtain + 0.2);
  float rays = noise(vec2(ap.x * 26.0 + warp * 7.0, t * 0.7 + uv.y * 0.6));
  aur *= 0.5 + pow(rays, 2.0) * 1.3;

  vec3 mint = vec3(0.16, 1.0, 0.70);
  vec3 cyan = vec3(0.20, 0.82, 1.0);
  vec3 indigo = vec3(0.38, 0.40, 1.0);
  vec3 violet = vec3(0.72, 0.32, 1.0);
  vec3 rose = vec3(1.0, 0.28, 0.45);
  vec3 aCol = mix(cyan, indigo, smoothstep(-0.7, 0.7, ap.x + sin(t * 3.0) * 0.4));
  aCol = mix(aCol, violet, smoothstep(0.45, 0.85, warp));
  aCol = mix(aCol, mint, smoothstep(0.55, 0.8, curtain) * 0.45);
  aCol = mix(aCol, mint, clamp(uMood, 0.0, 1.0) * 0.55 * (1.0 - smoothstep(0.3, 0.8, warp)));
  aCol = mix(aCol, rose, clamp(-uMood, 0.0, 1.0) * 0.45 * smoothstep(0.2, 0.7, warp));
  col += aCol * aur * 0.7;

  // Two slow colour fields so the page never looks flat.
  vec2 b1 = vec2(-0.55 * aspect + sin(t * 2.1) * 0.15, 0.30 + cos(t * 1.7) * 0.08) + m;
  vec2 b2 = vec2(0.60 * aspect + cos(t * 1.3) * 0.18, -0.05 + sin(t * 2.4) * 0.10) + m;
  col += indigo * 0.10 * exp(-dot(p - b1, p - b1) * 3.2);
  col += violet * 0.08 * exp(-dot(p - b2, p - b2) * 2.6);

  // Perspective grid floor.
  float horizon = 0.30 - uScroll * 0.06 + m.y * 0.6;
  float hd = uv.y - horizon;
  col += mix(cyan, violet, uv.x) * exp(-abs(hd) * 46.0) * (0.22 + uPulse * 0.45);
  if (hd < 0.0) {
    float d = -hd;
    float kx = 0.9;
    float kz = 0.32;
    vec2 g = vec2((p.x - m.x * 4.0) * kx / d, kz / d + uTime * 0.25);
    vec2 fw = vec2(kx / d, kz / (d * d)) / uRes.y * 1.5;
    vec2 gl = abs(fract(g + 0.5) - 0.5);
    float lx = 1.0 - smoothstep(fw.x * 0.4, fw.x * 1.4, gl.x);
    float lz = 1.0 - smoothstep(fw.y * 0.4, fw.y * 1.4, gl.y);
    float line = max(lx, lz * (1.0 - smoothstep(0.12, 0.5, fw.y)));
    float fade = smoothstep(0.0, 0.07, d) * (1.0 - smoothstep(0.2, 0.34, d) * 0.5);
    vec3 gCol = mix(cyan, violet, smoothstep(-0.6, 0.6, p.x));
    col += gCol * line * fade * (0.42 + uPulse * 0.5);
    col *= 1.0 - smoothstep(0.0, 0.3, d) * 0.25;
  }

  // Vignette + dither against banding.
  float vig = smoothstep(1.25, 0.25, length((uv - 0.5) * vec2(aspect * 0.85, 1.1)));
  col *= mix(0.45, 1.0, vig);
  col += (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}`;

const VERT_QUAD = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const VERT_STARS = `
attribute vec4 aStar;
uniform float uTime;
uniform vec2 uMouse;
uniform float uScroll;
uniform float uDpr;
varying float vAlpha;
varying float vSeed;
void main() {
  float z = aStar.z;
  float seed = aStar.w;
  vec2 pos = aStar.xy;
  pos.y += uTime * (0.003 + z * 0.010);
  pos.x += sin(uTime * 0.12 + seed * 6.283) * 0.03 * z;
  pos += uMouse * (0.008 + z * 0.06);
  pos.y += uScroll * (0.04 + z * 0.30);
  pos = mod(pos + 1.0, 2.0) - 1.0;
  gl_Position = vec4(pos, 0.0, 1.0);
  gl_PointSize = (1.0 + z * z * 3.2) * uDpr;
  float tw = 0.55 + 0.45 * sin(uTime * (0.5 + seed * 2.0) + seed * 40.0);
  vAlpha = (0.12 + z * 0.7) * tw;
  vSeed = seed;
}`;

const FRAG_STARS = `
precision mediump float;
varying float vAlpha;
varying float vSeed;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  vec3 c = mix(vec3(0.6, 0.85, 1.0), vec3(0.8, 0.65, 1.0), step(0.7, vSeed));
  c = mix(c, vec3(0.55, 1.0, 0.85), step(0.9, vSeed));
  gl_FragColor = vec4(c * a * vAlpha, 0.0);
}`;

function compile(gl, type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function program(gl, vsrc, fsrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsrc);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  return prog;
}

function uniforms(gl, prog, names) {
  const out = {};
  for (const name of names) out[name] = gl.getUniformLocation(prog, name);
  return out;
}

// Returns a small controller, or null when WebGL is unavailable (the CSS
// gradient behind the canvas stays as the fallback).
export function startBackground(canvas, opts = {}) {
  if (!canvas) return null;
  const reduced = Boolean(opts.reduced);
  const coarse = Boolean(opts.coarse);
  let gl = null;
  try {
    const attrs = { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "high-performance", preserveDrawingBuffer: Boolean(opts.preserve) };
    gl = canvas.getContext("webgl", attrs) || canvas.getContext("experimental-webgl", attrs);
  } catch {
    gl = null;
  }
  if (!gl) return null;

  const quad = program(gl, VERT_QUAD, FRAG);
  const stars = program(gl, VERT_STARS, FRAG_STARS);
  if (!quad || !stars) return null;

  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

  const smallScreen = Math.min(window.innerWidth, window.innerHeight) < 700;
  const count = reduced ? 140 : (coarse || smallScreen ? 170 : 420);
  const data = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    data[i * 4] = Math.random() * 2 - 1;
    data[i * 4 + 1] = Math.random() * 2 - 1;
    data[i * 4 + 2] = Math.pow(Math.random(), 2.2);
    data[i * 4 + 3] = Math.random();
  }
  const starBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, starBuf);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

  const qa = gl.getAttribLocation(quad, "aPos");
  const sa = gl.getAttribLocation(stars, "aStar");
  const qu = uniforms(gl, quad, ["uRes", "uTime", "uMouse", "uScroll", "uMood", "uPulse"]);
  const su = uniforms(gl, stars, ["uTime", "uMouse", "uScroll", "uDpr"]);

  // Resolution budget: DPR capped (1.5 on touch/small screens, 1.25 otherwise)
  // and total pixels capped, then scaled down further if frames run slow.
  const dprCap = coarse || smallScreen ? 1.5 : 1.25;
  let quality = coarse || smallScreen ? 0.7 : 1;
  let dpr = 1;
  function resize() {
    const w = window.innerWidth;
    const h = Math.max(window.innerHeight, document.documentElement.clientHeight || 0);
    dpr = Math.min(window.devicePixelRatio || 1, dprCap) * quality;
    const budget = 2.4e6;
    if (w * h * dpr * dpr > budget) dpr = Math.sqrt(budget / (w * h));
    const bw = Math.max(1, Math.round(w * dpr));
    const bh = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    gl.viewport(0, 0, bw, bh);
  }

  const target = { x: 0, y: 0 };
  const mouse = { x: 0, y: 0 };
  let mood = 0;
  let moodTarget = 0;
  let pulse = 0;
  let scroll = 0;
  let raf = 0;
  let last = 0;
  let elapsed = 7;
  let running = false;
  let lost = false;
  let held = false;
  const frameGap = coarse ? 1000 / 31 : 0;
  let slowFrames = 0;

  function draw(time) {
    gl.disable(gl.BLEND);
    gl.useProgram(quad);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(qa);
    gl.vertexAttribPointer(qa, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(qu.uRes, canvas.width, canvas.height);
    gl.uniform1f(qu.uTime, time);
    gl.uniform2f(qu.uMouse, mouse.x, mouse.y);
    gl.uniform1f(qu.uScroll, scroll);
    gl.uniform1f(qu.uMood, mood);
    gl.uniform1f(qu.uPulse, pulse);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disableVertexAttribArray(qa);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(stars);
    gl.bindBuffer(gl.ARRAY_BUFFER, starBuf);
    gl.enableVertexAttribArray(sa);
    gl.vertexAttribPointer(sa, 4, gl.FLOAT, false, 0, 0);
    gl.uniform1f(su.uTime, time);
    gl.uniform2f(su.uMouse, mouse.x, mouse.y);
    gl.uniform1f(su.uScroll, scroll);
    gl.uniform1f(su.uDpr, dpr);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.disableVertexAttribArray(sa);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = last ? now - last : 16;
    if (frameGap && dt < frameGap - 2) return;
    last = now;
    const step = Math.min(dt, 64) / 1000;
    elapsed += step;
    mouse.x += (target.x - mouse.x) * Math.min(1, step * 3);
    mouse.y += (target.y - mouse.y) * Math.min(1, step * 3);
    mood += (moodTarget - mood) * Math.min(1, step * 1.5);
    pulse *= Math.pow(0.12, step);
    const sy = Math.min(1, (window.scrollY || 0) / Math.max(1, window.innerHeight * 2.5));
    scroll += (sy - scroll) * Math.min(1, step * 5);
    draw(elapsed);
    // Adaptive quality: sustained slow frames drop the render scale.
    if (!frameGap && dt > 28 && quality > 0.55) {
      if (++slowFrames > 45) {
        quality = Math.max(0.55, quality - 0.15);
        slowFrames = 0;
        resize();
      }
    } else if (slowFrames > 0) {
      slowFrames--;
    }
  }

  function start() {
    if (running || lost || reduced || held) return;
    running = true;
    last = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resize();
      if (!running && !lost) draw(elapsed);
    }, 120);
  }, { passive: true });

  if (!reduced && !coarse) {
    window.addEventListener("pointermove", (event) => {
      target.x = (event.clientX / window.innerWidth) * 2 - 1;
      target.y = -((event.clientY / window.innerHeight) * 2 - 1);
    }, { passive: true });
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else start();
  });

  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    lost = true;
    stop();
    canvas.classList.remove("is-on");
  });

  resize();
  draw(elapsed);
  canvas.classList.add("is-on");
  if (!document.hidden) start();

  return {
    // -1 (book is red) … +1 (book is green); tints the aurora.
    setMood(value) {
      const n = Number(value);
      moodTarget = Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0;
      if (reduced && !lost) {
        mood = moodTarget;
        draw(elapsed);
      }
    },
    // Freeze on the current frame (e.g. behind a modal), then resume.
    hold(value) {
      held = Boolean(value);
      if (held) stop();
      else if (!document.hidden) start();
    },
    // Brief horizon flash when fresh prices land.
    pulse() {
      if (!reduced) pulse = 1;
    },
  };
}
