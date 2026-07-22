// comflow — global hard-commodity trade flows.
// deck.gl standalone (no basemap tiles): dark country landmasses on true black,
// bilateral flows as great-circle paths — a faint static base network plus an
// animated pulse of light traversing each line from exporter to importer.
// Colour encodes commodity; width and opacity scale with trade volume.

const { Deck, MapView, GeoJsonLayer, PathLayer, TripsLayer } = deck;

const DATA = "data/";
const state = {
  data: null,
  countries: null,
  world: null,
  active: new Set(),
  periodIdx: 0,
  measure: "v",           // 'v' value (USD) | 'w' weight (tonnes)
  hover: null,            // hovered flow object
  maxByMeasure: { v: 1, w: 1 },
  flows: [],              // current flow set (with cached great-circle paths)
  time: 0,                // animation clock
};

const el = (id) => document.getElementById(id);
const fmtUSD = (n) => {
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(n < 1e10 ? 2 : 1) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(0) + "K";
  return "$" + n;
};
const fmtT = (n) => {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "Mt";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "kt";
  return n + " t";
};

const INITIAL_VIEW = { longitude: 13, latitude: 26, zoom: 0.6, pitch: 0, bearing: 0 };
const MAX_WIDTH_PX = 9;    // widest flow
const MIN_WIDTH_PX = 0.25; // thinnest flow — small volumes stay recessive
const LOOP = 2.0;          // animation period (phase spread 0..1 over a 0..2 clock)
const TRAIL = 0.16;        // comet trail length in clock units
const SPEED = 0.28;        // clock units per second

let deckgl;

init();

async function init() {
  const [data, countries, world] = await Promise.all([
    fetch(DATA + "flows.json").then((r) => r.json()),
    fetch(DATA + "countries.json").then((r) => r.json()),
    fetch(DATA + "world.json").then((r) => r.json()),
  ]);
  state.data = data;
  state.countries = countries;
  state.world = world;
  data.meta.commodities.forEach((c) => state.active.add(c.id));
  state.periodIdx = data.meta.years.length - 1;

  computeMaxima();
  buildChips();
  buildTimeline();
  wireMeasure();

  deckgl = new Deck({
    parent: el("map"),
    views: new MapView({ repeat: true }),
    initialViewState: INITIAL_VIEW,
    controller: { dragRotate: true, minZoom: 0.5, maxZoom: 7, inertia: 220 },
    getCursor: ({ isHovering }) => (isHovering ? "pointer" : "grab"),
    layers: [],
  });

  el("src").innerHTML =
    `BACI (CEPII) · reconciled UN Comtrade · top ${data.meta.top_n}/commodity`;

  rebuildFlows();
  requestAnimationFrame(tick);
}

function computeMaxima() {
  let mv = 1, mw = 1;
  const f = state.data.flows;
  for (const cid in f)
    for (const yr in f[cid])
      for (const d of f[cid][yr]) {
        if (d.v > mv) mv = d.v;
        if (d.w > mw) mw = d.w;
      }
  state.maxByMeasure = { v: mv, w: mw };
}

const currentPeriod = () => String(state.data.meta.years[state.periodIdx]);

/* ---------- great-circle geometry (cached per flow) ---------- */

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const pathCache = new Map();

// Hashless deterministic phase from the flow key so pulses are staggered but
// stable across re-renders (no Math.random flicker when toggling).
function phaseOf(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000;
}

function greatCircle(a, b) {
  const [lo1, la1] = a.map((v) => v * D2R);
  const [lo2, la2] = b.map((v) => v * D2R);
  const dLat = la2 - la1, dLon = lo2 - lo1;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  const d = 2 * Math.asin(Math.min(1, Math.sqrt(h))); // angular distance (rad)
  const degDist = d * R2D;
  const n = Math.max(12, Math.min(48, Math.round(degDist / 4)));
  const pts = [];
  if (d < 1e-6) return { path: [a, b], ts: [0, 1] };
  const sinD = Math.sin(d);
  let prevLon = null;
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / sinD;
    const B = Math.sin(f * d) / sinD;
    const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
    const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
    const z = A * Math.sin(la1) + B * Math.sin(la2);
    const lat = Math.atan2(z, Math.hypot(x, y)) * R2D;
    let lon = Math.atan2(y, x) * R2D;
    if (prevLon !== null) {            // unwrap across the antimeridian
      while (lon - prevLon > 180) lon -= 360;
      while (lon - prevLon < -180) lon += 360;
    }
    prevLon = lon;
    pts.push([lon, lat]);
  }
  // timestamps: even fraction 0..1 (constant-parameter pulse speed)
  const ts = pts.map((_, i) => i / n);
  return { path: pts, ts };
}

function geomFor(d) {
  let g = pathCache.get(d.key);
  if (!g) {
    const gc = greatCircle(d.es, d.is);
    const ph = phaseOf(d.key);
    g = { path: gc.path, ts: gc.ts.map((t) => t + ph) }; // phase-shifted for stagger
    pathCache.set(d.key, g);
  }
  return g;
}

/* ---------- scales ---------- */

function widthFor(d) {
  const m = state.measure;
  const norm = Math.sqrt(d[m]) / Math.sqrt(state.maxByMeasure[m]);
  return MIN_WIDTH_PX + norm * (MAX_WIDTH_PX - MIN_WIDTH_PX);
}
// opacity scales with volume: small flows recede, large flows read.
function baseAlpha(d) {
  const norm = Math.sqrt(d[state.measure]) / Math.sqrt(state.maxByMeasure[state.measure]);
  return Math.round(10 + norm * 60);   // 10..70 — faint static network
}
function trailAlpha(d) {
  const norm = Math.sqrt(d[state.measure]) / Math.sqrt(state.maxByMeasure[state.measure]);
  return Math.round(45 + norm * 180);  // 45..225 — the travelling light
}

/* ---------- flow set ---------- */

function rebuildFlows() {
  const yr = currentPeriod();
  const out = [];
  for (const c of state.data.meta.commodities) {
    if (!state.active.has(c.id)) continue;
    const rows = (state.data.flows[c.id] && state.data.flows[c.id][yr]) || [];
    for (const d of rows) {
      const rec = {
        key: c.id + "|" + d.e + "|" + d.i,
        cid: c.id, color: c.color, label: c.label,
        e: d.e, i: d.i, es: d.es, is: d.is, v: d.v, w: d.w,
      };
      const g = geomFor(rec);
      rec.path = g.path; rec.ts = g.ts;
      out.push(rec);
    }
  }
  out.sort((a, b) => a[state.measure] - b[state.measure]); // big flows drawn last
  state.flows = out;
  updateStat(out);
}

/* ---------- render (called every animation frame) ---------- */

function draw() {
  const flows = state.flows;

  const base = new GeoJsonLayer({
    id: "countries",
    data: state.world,
    stroked: true, filled: true,
    getFillColor: [16, 18, 23, 255],
    getLineColor: [40, 44, 52, 255],
    lineWidthMinPixels: 0.5,
    parameters: { depthTest: false },
  });

  // faint static network — always visible so structure persists between pulses
  const net = new PathLayer({
    id: "net",
    data: flows,
    getPath: (d) => d.path,
    getColor: (d) => [...d.color, baseAlpha(d)],
    getWidth: (d) => Math.max(0.5, widthFor(d) * 0.6),
    widthUnits: "pixels",
    widthMinPixels: 0.5,
    capRounded: true, jointRounded: true,
    parameters: { depthTest: false },
    updateTriggers: { getColor: [state.measure], getWidth: [state.measure] },
    pickable: true,
    onHover: onHover,
  });

  // animated pulse of light travelling exporter → importer
  const trips = new TripsLayer({
    id: "trips",
    data: flows,
    getPath: (d) => d.path,
    getTimestamps: (d) => d.ts,
    getColor: (d) => [...d.color, trailAlpha(d)],
    getWidth: widthFor,
    widthUnits: "pixels",
    widthMinPixels: MIN_WIDTH_PX,
    capRounded: true, jointRounded: true,
    fadeTrail: true,
    trailLength: TRAIL,
    currentTime: state.time,
    parameters: { depthTest: false, blend: true, blendFunc: [770, 1] }, // additive glow
    updateTriggers: { getColor: [state.measure], getWidth: [state.measure] },
  });

  const layers = [base, net, trips];

  // hovered flow: a bright overlay so the picked route pops without dimming all
  if (state.hover) {
    layers.push(new PathLayer({
      id: "hi",
      data: [state.hover],
      getPath: (d) => d.path,
      getColor: (d) => [...d.color, 255],
      getWidth: (d) => widthFor(d) + 1.4,
      widthUnits: "pixels", widthMinPixels: 1.5,
      capRounded: true, jointRounded: true,
      parameters: { depthTest: false },
    }));
  }

  deckgl.setProps({ layers });
}

let lastT = null;
function tick(now) {
  if (lastT === null) lastT = now;
  const dt = Math.min(0.05, (now - lastT) / 1000); // clamp big gaps (tab switches)
  lastT = now;
  state.time = (state.time + dt * SPEED) % LOOP;
  draw();
  requestAnimationFrame(tick);
}

/* ---------- interaction ---------- */

function onHover(info) {
  const tip = el("tooltip");
  const d = info && info.object;
  if (!d) {
    if (state.hover) state.hover = null;
    tip.hidden = true;
    return;
  }
  state.hover = d;
  const en = nameOf(d.e), inn = nameOf(d.i);
  tip.innerHTML =
    `<div class="tt-route">${en} <span class="arrow">→</span> ${inn}</div>` +
    `<div class="tt-comm"><span class="dot" style="color:rgb(${d.color.join(",")})"></span>${d.label}</div>` +
    `<div class="tt-rows">` +
    `<span class="k">Value</span><span class="v">${fmtUSD(d.v)}</span>` +
    `<span class="k">Weight</span><span class="v">${fmtT(d.w)}</span>` +
    `</div>`;
  tip.style.left = info.x + "px";
  tip.style.top = info.y + "px";
  tip.hidden = false;
}

const nameOf = (iso) => (state.countries[iso] && state.countries[iso].name) || iso;

function updateStat(flows) {
  let v = 0, w = 0;
  for (const d of flows) { v += d.v; w += d.w; }
  el("stat").innerHTML =
    `<b>${flows.length}</b> flows · <b>${fmtUSD(v)}</b> · <b>${fmtT(w)}</b>`;
  el("period").textContent = currentPeriod();
}

/* ---------- controls ---------- */

function buildChips() {
  const box = el("chips");
  box.innerHTML = "";
  for (const c of state.data.meta.commodities) {
    const chip = document.createElement("button");
    chip.className = "chip on";
    chip.dataset.id = c.id;
    chip.innerHTML =
      `<span class="dot" style="color:rgb(${c.color.join(",")})"></span>${c.label}`;
    chip.onclick = () => {
      if (state.active.has(c.id)) {
        state.active.delete(c.id); chip.classList.remove("on"); chip.classList.add("off");
      } else {
        state.active.add(c.id); chip.classList.add("on"); chip.classList.remove("off");
      }
      rebuildFlows();
    };
    box.appendChild(chip);
  }
}

function buildTimeline() {
  const years = state.data.meta.years;
  const slider = el("time");
  slider.min = 0; slider.max = years.length - 1; slider.value = state.periodIdx;
  el("time-value").textContent = years[state.periodIdx];
  slider.oninput = () => {
    state.periodIdx = +slider.value;
    el("time-value").textContent = years[state.periodIdx];
    rebuildFlows();
  };
  if (years.length < 2) el("time-block").style.opacity = 0.4;
}

function wireMeasure() {
  const seg = el("measure");
  seg.querySelectorAll("button").forEach((b) => {
    b.onclick = () => {
      state.measure = b.dataset.measure;
      seg.querySelectorAll("button").forEach((x) => {
        const on = x === b;
        x.classList.toggle("on", on);
        x.setAttribute("aria-checked", on ? "true" : "false");
      });
      rebuildFlows();
    };
  });
}
