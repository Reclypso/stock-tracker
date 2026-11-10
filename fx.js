// Motion + DOM toolkit for the leads page: keyed morphing (so polls patch the
// page instead of rebuilding it), count-ups, odometer digit rolls, bursts,
// tilt/spotlight, magnetic buttons and tap ripples. No dependencies; GSAP is
// used by app.js only when it loaded.

export const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

export function reducedMotion() {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function canAnimate() {
  return !reducedMotion() && typeof Element !== "undefined" && typeof Element.prototype.animate === "function";
}

export function finePointer() {
  return typeof window.matchMedia === "function" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

export function shown(el) {
  return el.getClientRects().length > 0;
}

// ---------------------------------------------------------------------------
// Keyed morph. Elements with data-key are matched by key; others by position
// and tag. Matched nodes are patched in place, so CSS animations, focus,
// <details open> and inline styles set by JS survive a re-render.

function keyOf(node) {
  return node.nodeType === 1 ? node.getAttribute("data-key") : null;
}

function leaving(node) {
  return node && node.nodeType === 1 && node.hasAttribute("data-leaving");
}

function firstLive(node) {
  while (node && (leaving(node) || node.nodeType === 8)) node = node.nextSibling;
  return node;
}

function syncAttrs(from, to) {
  const details = from.tagName === "DETAILS";
  for (const { name, value } of [...to.attributes]) {
    if (details && name === "open") continue;
    if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  }
  for (const { name } of [...from.attributes]) {
    if (to.hasAttribute(name)) continue;
    // Inline styles written by JS (tilt, GSAP, countdowns) stay unless the
    // template sets its own. <details open> belongs to the user.
    if (name === "style" || (details && name === "open")) continue;
    from.removeAttribute(name);
  }
}

function morphNode(from, to, hooks) {
  if (from.nodeType !== 1) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return;
  }
  syncAttrs(from, to);
  morphChildren(from, to, hooks);
}

export function morphChildren(parent, next, hooks = {}) {
  const live = [...parent.childNodes].filter((n) => !leaving(n) && n.nodeType !== 8);
  const keyed = new Map();
  for (const n of live) {
    const key = keyOf(n);
    if (key != null) keyed.set(key, n);
  }
  const unkeyed = live.filter((n) => keyOf(n) == null);
  const plan = [];
  const used = new Set();
  let cursor = 0;
  for (const nk of [...next.childNodes]) {
    if (nk.nodeType === 8) continue;
    const key = keyOf(nk);
    let match = null;
    if (key != null) {
      const candidate = keyed.get(key);
      if (candidate && candidate.tagName === nk.tagName && !used.has(candidate)) match = candidate;
    } else {
      for (let i = cursor; i < unkeyed.length; i++) {
        const c = unkeyed[i];
        if (c.nodeType === nk.nodeType && (c.nodeType === 3 || c.tagName === nk.tagName)) {
          match = c;
          cursor = i + 1;
          break;
        }
      }
    }
    if (match) used.add(match);
    plan.push([nk, match]);
  }
  for (const n of live) {
    if (used.has(n)) continue;
    if (keyOf(n) != null && hooks.onRemove) hooks.onRemove(n);
    else n.remove();
  }
  let ref = firstLive(parent.firstChild);
  for (const [nk, match] of plan) {
    if (match) {
      morphNode(match, nk, hooks);
      if (match === ref) ref = firstLive(match.nextSibling);
      else parent.insertBefore(match, ref);
    } else {
      parent.insertBefore(nk, ref);
      if (keyOf(nk) != null && hooks.onAdd) hooks.onAdd(nk);
    }
  }
}

export function morphHtml(container, html, hooks) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  morphChildren(container, tpl.content, hooks);
}

// ---------------------------------------------------------------------------
// Numbers.

export function countUp(el, from, to, fmt, duration = 1200, delay = 0) {
  if (!fmt || from == null || to == null || from === to) return;
  const final = el.textContent;
  const start = performance.now() + delay;
  el.textContent = fmt(from);
  const step = (t) => {
    if (!el.isConnected) return;
    const p = Math.max(0, Math.min(1, (t - start) / duration));
    if (p >= 1) {
      el.textContent = final;
      return;
    }
    el.textContent = fmt(from + (to - from) * (1 - Math.pow(1 - p, 4)));
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Odometer: digits that changed roll to their new value (up from below when
// the number rose, down from above when it fell). Screen readers get the
// final text only.
export function roll(el, before, after, dir) {
  const len = Math.max(before.length, after.length);
  const a = before.padStart(len, " ");
  const b = after.padStart(len, " ");
  let html = "";
  let changed = 0;
  for (let i = 0; i < len; i++) {
    const ca = a[i];
    const cb = b[i];
    if (cb === " ") continue;
    if (ca === cb || !/\d/.test(cb)) {
      html += `<span class="odo-c">${esc(cb)}</span>`;
      continue;
    }
    const top = dir === "up" ? (ca.trim() || "0") : cb;
    const bottom = dir === "up" ? cb : (ca.trim() || "0");
    html += `<span class="odo-d"><span class="odo-s odo-${dir}" style="--i:${changed++}"><span>${esc(top)}</span><span>${esc(bottom)}</span></span></span>`;
  }
  el.innerHTML = `<span class="sr-only">${esc(after)}</span><span class="odo" aria-hidden="true">${html}</span>`;
  setTimeout(() => {
    if (el.isConnected && el.querySelector(".odo")) el.textContent = after;
  }, 900 + changed * 45);
}

export function addTransient(el, cls, fallbackMs = 2400) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  const done = () => {
    el.classList.remove(cls);
    el.removeEventListener("animationend", onEnd);
  };
  const onEnd = (event) => {
    if (event.target === el) done();
  };
  el.addEventListener("animationend", onEnd);
  setTimeout(done, fallbackMs);
}

// ---------------------------------------------------------------------------
// Celebration burst (target hit): particles + shockwave ring from a point.

export function burst(host, x, y, colors = ["#ffd36b", "#fff1c2", "#9b7bff", "#2bffa8"]) {
  if (!canAnimate() || !host) return;
  const layer = document.createElement("span");
  layer.className = "burst";
  layer.setAttribute("aria-hidden", "true");
  layer.style.left = `${x}px`;
  layer.style.top = `${y}px`;
  host.appendChild(layer);
  const ring = document.createElement("i");
  ring.className = "burst-ring";
  layer.appendChild(ring);
  ring.animate(
    [{ transform: "translate(-50%,-50%) scale(0.2)", opacity: 0.9 }, { transform: "translate(-50%,-50%) scale(3.2)", opacity: 0 }],
    { duration: 900, easing: "cubic-bezier(.2,.7,.2,1)", fill: "forwards" },
  );
  const n = 22;
  for (let i = 0; i < n; i++) {
    const p = document.createElement("i");
    p.className = "burst-p";
    const color = colors[i % colors.length];
    p.style.background = color;
    p.style.boxShadow = `0 0 10px ${color}`;
    layer.appendChild(p);
    const angle = (i / n) * Math.PI * 2 + Math.random() * 0.4;
    const dist = 38 + Math.random() * 70;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist - 18;
    const s = 0.5 + Math.random() * 0.9;
    p.animate(
      [
        { transform: "translate(-50%,-50%) scale(0.2)", opacity: 1 },
        { transform: `translate(calc(-50% + ${dx * 0.7}px), calc(-50% + ${dy * 0.7}px)) scale(${s})`, opacity: 1, offset: 0.55 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy + 26}px)) scale(0)`, opacity: 0 },
      ],
      { duration: 900 + Math.random() * 500, easing: "cubic-bezier(.15,.75,.3,1)", fill: "forwards" },
    );
  }
  setTimeout(() => layer.remove(), 1700);
}

// ---------------------------------------------------------------------------
// Pointer effects (fine pointers only): 3D tilt + spotlight on cards,
// magnetic pull on [data-magnetic]. Tap ripples everywhere.

export function installTilt(selector) {
  if (!finePointer() || reducedMotion()) return;
  let active = null;
  let frame = 0;
  let pending = null;
  const apply = () => {
    frame = 0;
    if (!pending) return;
    const { el, x, y, w, h } = pending;
    const rx = ((y / h) - 0.5) * -7;
    const ry = ((x / w) - 0.5) * 9;
    el.style.setProperty("--mx", `${x}px`);
    el.style.setProperty("--my", `${y}px`);
    el.style.transform = `perspective(1100px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) translateZ(0)`;
  };
  document.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "mouse") return;
    const el = event.target.closest?.(selector);
    if (active && active !== el) {
      active.classList.remove("is-tilting");
      active.style.transform = "";
    }
    active = el || null;
    if (!el) return;
    el.classList.add("is-tilting");
    const rect = el.getBoundingClientRect();
    pending = { el, x: event.clientX - rect.left, y: event.clientY - rect.top, w: rect.width, h: rect.height };
    if (!frame) frame = requestAnimationFrame(apply);
  }, { passive: true });
  document.addEventListener("pointerleave", () => {
    if (active) {
      active.classList.remove("is-tilting");
      active.style.transform = "";
      active = null;
    }
  });
}

export function installMagnetic() {
  if (!finePointer() || reducedMotion()) return;
  let current = null;
  document.addEventListener("pointermove", (event) => {
    const el = event.target.closest?.("[data-magnetic]");
    if (current && current !== el) {
      current.style.transform = "";
      current = null;
    }
    if (!el || el.disabled) return;
    current = el;
    const r = el.getBoundingClientRect();
    const dx = event.clientX - (r.left + r.width / 2);
    const dy = event.clientY - (r.top + r.height / 2);
    el.style.transform = `translate(${(dx * 0.22).toFixed(1)}px, ${(dy * 0.3).toFixed(1)}px)`;
  }, { passive: true });
}

export function installRipple() {
  document.addEventListener("pointerdown", (event) => {
    if (reducedMotion() || event.button > 0) return;
    const host = event.target.closest?.("[data-ripple]");
    if (!host || host.disabled) return;
    const rect = host.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2.2;
    const dot = document.createElement("span");
    dot.className = "ripple";
    dot.setAttribute("aria-hidden", "true");
    dot.style.width = dot.style.height = `${size}px`;
    dot.style.left = `${event.clientX - rect.left - size / 2}px`;
    dot.style.top = `${event.clientY - rect.top - size / 2}px`;
    host.appendChild(dot);
    dot.animate(
      [{ transform: "scale(0)", opacity: 0.45 }, { transform: "scale(1)", opacity: 0 }],
      { duration: 650, easing: "cubic-bezier(.2,.6,.3,1)", fill: "forwards" },
    ).onfinish = () => dot.remove();
  }, { passive: true });
}

// ---------------------------------------------------------------------------
// FLIP: glide elements from their old position to the new one.

export function captureRects(root, selector) {
  const rects = new Map();
  for (const el of root.querySelectorAll(selector)) {
    if (shown(el) && !leaving(el)) rects.set(el.getAttribute("data-key"), el.getBoundingClientRect());
  }
  return rects;
}

export function flip(root, selector, rects) {
  if (!canAnimate()) return;
  for (const el of root.querySelectorAll(selector)) {
    const before = rects.get(el.getAttribute("data-key"));
    if (!before || leaving(el) || !shown(el)) continue;
    const now = el.getBoundingClientRect();
    const dx = before.left - now.left;
    const dy = before.top - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 620, easing: EASE });
  }
}
