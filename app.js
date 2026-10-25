import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

// Public (publishable) Supabase credentials. Writes only happen through the
// toggle_cell() database function, which enforces the shared paint pool.
const SUPABASE_URL = "https://ftjqihegangdtmsylyzf.supabase.co";
const SUPABASE_KEY = "sb_publishable_rW-RjmP7j08g_IZvv42f8g_dPJOjqjF";

const LIMIT = 1_000_000; // board spans -LIMIT..LIMIT on both axes
const MIN_SCALE = 0.25; // px per cell
const MAX_SCALE = 80;
const MAX_CLICKS_PER_SEC = 8;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { params: { eventsPerSecond: 20 } },
});

// ---------- state ----------
const cells = new Set(); // "x,y" of black cells
let poolTotal = 0;
const cam = { x: 0, y: 0, scale: 20 }; // world coords at screen center
let hover = null;
let needsDraw = true;
const clickTimes = [];

const key = (x, y) => x + "," + y;

// ---------- DOM ----------
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const paintEl = document.getElementById("paint");
const paintFill = document.getElementById("paint-fill");
const paintText = document.getElementById("paint-text");
const coordsEl = document.getElementById("coords");
const toastEl = document.getElementById("toast");
const onlineEl = document.getElementById("online-n");
const help = document.getElementById("help");

let dpr = 1;
function resize() {
  dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  needsDraw = true;
}
new ResizeObserver(resize).observe(canvas);

// ---------- camera helpers ----------
function screenToWorld(sx, sy) {
  const r = canvas.getBoundingClientRect();
  return {
    x: cam.x + (sx - r.left - r.width / 2) / cam.scale,
    y: cam.y + (sy - r.top - r.height / 2) / cam.scale,
  };
}

function clampCam() {
  cam.x = Math.max(-LIMIT, Math.min(LIMIT + 1, cam.x));
  cam.y = Math.max(-LIMIT, Math.min(LIMIT + 1, cam.y));
}

function zoomAt(sx, sy, factor) {
  const before = screenToWorld(sx, sy);
  cam.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, cam.scale * factor));
  const after = screenToWorld(sx, sy);
  cam.x += before.x - after.x;
  cam.y += before.y - after.y;
  clampCam();
  needsDraw = true;
  scheduleHash();
}

// ---------- rendering ----------
function draw() {
  const w = canvas.width, h = canvas.height;
  const s = cam.scale * dpr;
  // world coordinate of the top-left pixel
  const ox = cam.x - w / 2 / s;
  const oy = cam.y - h / 2 / s;

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);

  const x0 = Math.floor(ox), y0 = Math.floor(oy);
  const x1 = Math.ceil(ox + w / s), y1 = Math.ceil(oy + h / s);

  // area outside the board
  ctx.fillStyle = "#e9e9e6";
  if (x0 < -LIMIT) ctx.fillRect(0, 0, (-LIMIT - ox) * s, h);
  if (x1 > LIMIT + 1) { const px = (LIMIT + 1 - ox) * s; ctx.fillRect(px, 0, w - px, h); }
  if (y0 < -LIMIT) ctx.fillRect(0, 0, w, (-LIMIT - oy) * s);
  if (y1 > LIMIT + 1) { const py = (LIMIT + 1 - oy) * s; ctx.fillRect(0, py, w, h - py); }

  // grid lines
  if (cam.scale >= 5) {
    const alpha = Math.min(1, (cam.scale - 5) / 15);
    ctx.strokeStyle = `rgba(0,0,0,${0.06 + 0.06 * alpha})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = x0; x <= x1; x++) {
      const px = Math.round((x - ox) * s) + 0.5;
      ctx.moveTo(px, 0); ctx.lineTo(px, h);
    }
    for (let y = y0; y <= y1; y++) {
      const py = Math.round((y - oy) * s) + 0.5;
      ctx.moveTo(0, py); ctx.lineTo(w, py);
    }
    ctx.stroke();
  }

  // black cells
  ctx.fillStyle = "#111";
  const size = Math.max(1, s);
  for (const k of cells) {
    const i = k.indexOf(",");
    const x = +k.slice(0, i), y = +k.slice(i + 1);
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    const px = Math.floor((x - ox) * s), py = Math.floor((y - oy) * s);
    ctx.fillRect(px, py, Math.max(size, Math.floor((x + 1 - ox) * s) - px), Math.max(size, Math.floor((y + 1 - oy) * s) - py));
  }

  // hover
  if (hover && cam.scale >= 3) {
    const px = Math.floor((hover.x - ox) * s), py = Math.floor((hover.y - oy) * s);
    const black = cells.has(key(hover.x, hover.y));
    ctx.fillStyle = black ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.18)";
    ctx.fillRect(px, py, Math.ceil(s), Math.ceil(s));
  }
}

function loop() {
  if (needsDraw) { needsDraw = false; draw(); }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ---------- paint counter ----------
function updatePaint() {
  const remaining = Math.max(0, poolTotal - cells.size);
  paintText.textContent = `${remaining.toLocaleString("es-ES")} / ${poolTotal.toLocaleString("es-ES")} de pintura`;
  paintFill.style.width = poolTotal ? (100 * remaining) / poolTotal + "%" : "0%";
  paintEl.classList.toggle("empty", remaining === 0);
}

// ---------- toast ----------
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
}

// ---------- toggling ----------
async function toggle(x, y) {
  if (x < -LIMIT || x > LIMIT || y < -LIMIT || y > LIMIT) return;
  const now = performance.now();
  while (clickTimes.length && now - clickTimes[0] > 1000) clickTimes.shift();
  if (clickTimes.length >= MAX_CLICKS_PER_SEC) { toast("¡Más despacio!"); return; }
  clickTimes.push(now);

  const k = key(x, y);
  const wasBlack = cells.has(k);
  if (!wasBlack && cells.size >= poolTotal) {
    toast("Se acabó la pintura negra. Borra algún cuadro para recuperarla.");
    return;
  }
  // optimistic update
  wasBlack ? cells.delete(k) : cells.add(k);
  updatePaint();
  needsDraw = true;

  const { data, error } = await supabase.rpc("toggle_cell", { px: x, py: y });
  if (error || !data?.ok) {
    // revert to the server's truth for this cell
    if (data?.error === "no_paint") toast("Se acabó la pintura negra. Borra algún cuadro para recuperarla.");
    else toast("No se pudo pintar. Inténtalo de nuevo.");
    wasBlack ? cells.add(k) : cells.delete(k);
  } else {
    // someone may have toggled the same cell meanwhile; trust the server
    data.black ? cells.add(k) : cells.delete(k);
  }
  updatePaint();
  needsDraw = true;
}

// ---------- input ----------
const pointers = new Map();
let drag = null; // { startX, startY, camX, camY, moved }
let pinch = null; // { dist, midX, midY }

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    drag = { startX: e.clientX, startY: e.clientY, camX: cam.x, camY: cam.y, moved: false };
  } else if (pointers.size === 2) {
    drag = null;
    const [a, b] = [...pointers.values()];
    pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
  }
});

canvas.addEventListener("pointermove", (e) => {
  if (e.pointerType === "mouse") {
    const w = screenToWorld(e.clientX, e.clientY);
    const hx = Math.floor(w.x), hy = Math.floor(w.y);
    if (!hover || hover.x !== hx || hover.y !== hy) {
      hover = { x: hx, y: hy };
      coordsEl.textContent = `${hx}, ${hy}`;
      needsDraw = true;
    }
  }
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
    cam.x -= (midX - pinch.midX) / cam.scale;
    cam.y -= (midY - pinch.midY) / cam.scale;
    zoomAt(midX, midY, dist / pinch.dist);
    pinch = { dist, midX, midY };
  } else if (drag) {
    const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) > 6) {
      drag.moved = true;
      canvas.classList.add("dragging");
    }
    if (drag.moved) {
      cam.x = drag.camX - dx / cam.scale;
      cam.y = drag.camY - dy / cam.scale;
      clampCam();
      needsDraw = true;
      scheduleHash();
    }
  }
});

function endPointer(e, cancelled) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pinch) {
    if (pointers.size < 2) pinch = null;
    drag = null; // don't paint at the end of a pinch
    return;
  }
  if (drag && !drag.moved && !cancelled) {
    const w = screenToWorld(e.clientX, e.clientY);
    if (cam.scale < 2) {
      // too far out to aim at a single cell: zoom in instead
      zoomAt(e.clientX, e.clientY, 4);
    } else {
      toggle(Math.floor(w.x), Math.floor(w.y));
    }
  }
  drag = null;
  canvas.classList.remove("dragging");
}
canvas.addEventListener("pointerup", (e) => endPointer(e, false));
canvas.addEventListener("pointercancel", (e) => endPointer(e, true));
canvas.addEventListener("pointerleave", () => { hover = null; needsDraw = true; });

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
  zoomAt(e.clientX, e.clientY, factor);
}, { passive: false });

function zoomCenter(f) {
  const r = canvas.getBoundingClientRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, f);
}
document.getElementById("btn-zoom-in").onclick = () => zoomCenter(1.6);
document.getElementById("btn-zoom-out").onclick = () => zoomCenter(1 / 1.6);
document.getElementById("btn-home").onclick = () => goTo(0, 0, 20);
document.getElementById("btn-random").onclick = () => {
  if (!cells.size) return toast("El lienzo está vacío. ¡Sé el primero!");
  const i = Math.floor(Math.random() * cells.size);
  let n = 0;
  for (const k of cells) {
    if (n++ === i) {
      const [x, y] = k.split(",").map(Number);
      goTo(x + 0.5, y + 0.5, 14);
      break;
    }
  }
};
document.getElementById("btn-share").onclick = async () => {
  writeHash();
  try {
    await navigator.clipboard.writeText(location.href);
    toast("Enlace copiado");
  } catch {
    toast(location.href);
  }
};

window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  const step = 80 / cam.scale;
  if (e.key === "ArrowLeft") cam.x -= step;
  else if (e.key === "ArrowRight") cam.x += step;
  else if (e.key === "ArrowUp") cam.y -= step;
  else if (e.key === "ArrowDown") cam.y += step;
  else if (e.key === "+" || e.key === "=") return zoomCenter(1.25);
  else if (e.key === "-") return zoomCenter(0.8);
  else return;
  clampCam();
  needsDraw = true;
  scheduleHash();
});

// help panel
try { if (localStorage.getItem("paint-help-seen")) help.classList.add("hidden"); } catch {}
document.getElementById("help-close").onclick = () => {
  help.classList.add("hidden");
  try { localStorage.setItem("paint-help-seen", "1"); } catch {}
};

// ---------- URL hash (#x,y,zoom) ----------
function goTo(x, y, scale) {
  cam.x = x; cam.y = y; cam.scale = scale;
  clampCam();
  needsDraw = true;
  scheduleHash();
}
function writeHash() {
  history.replaceState(null, "", `#${Math.floor(cam.x)},${Math.floor(cam.y)},${+cam.scale.toFixed(2)}`);
}
let hashTimer;
function scheduleHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(writeHash, 400);
}
function readHash() {
  const m = location.hash.slice(1).split(",").map(Number);
  if (m.length >= 2 && m.every(Number.isFinite)) {
    cam.x = m[0] + 0.5; cam.y = m[1] + 0.5;
    if (m[2]) cam.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, m[2]));
    clampCam();
  }
}
readHash();
window.addEventListener("hashchange", () => { readHash(); needsDraw = true; });

// ---------- data + realtime ----------
async function loadAll() {
  const [{ data: pool }, { data: all, error }] = await Promise.all([
    supabase.from("pool").select("total").eq("id", 1).single(),
    supabase.rpc("get_all_cells"),
  ]);
  if (error) { toast("No se pudo cargar el lienzo"); return; }
  if (pool) poolTotal = pool.total;
  cells.clear();
  for (const [x, y] of all || []) cells.add(key(x, y));
  updatePaint();
  needsDraw = true;
}

const me = Math.random().toString(36).slice(2);
let firstSubscribe = true;
const channel = supabase
  .channel("paint", { config: { presence: { key: me } } })
  .on("postgres_changes", { event: "INSERT", schema: "public", table: "cells" }, ({ new: c }) => {
    cells.add(key(c.x, c.y));
    updatePaint();
    needsDraw = true;
  })
  .on("postgres_changes", { event: "DELETE", schema: "public", table: "cells" }, ({ old: c }) => {
    cells.delete(key(c.x, c.y));
    updatePaint();
    needsDraw = true;
  })
  .on("postgres_changes", { event: "UPDATE", schema: "public", table: "pool" }, ({ new: p }) => {
    poolTotal = p.total;
    updatePaint();
  })
  .on("presence", { event: "sync" }, () => {
    onlineEl.textContent = Object.keys(channel.presenceState()).length || 1;
  })
  .subscribe(async (status) => {
    if (status === "SUBSCRIBED") {
      await channel.track({ t: Date.now() });
      // (re)load after (re)connecting so we never miss changes made while offline
      if (!firstSubscribe) loadAll();
      firstSubscribe = false;
    }
  });

loadAll();

// ---------- ads ----------
// Push each AdSense slot once the AdSense script (in index.html) is enabled.
window.addEventListener("load", () => {
  if (!document.querySelector('script[src*="adsbygoogle.js"]')) return;
  document.querySelectorAll(".ad").forEach((ad) => {
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
      ad.classList.add("filled");
    } catch {}
  });
});
