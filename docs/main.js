// comflow — global hard-commodity trade flows.
// deck.gl standalone (no basemap tiles): dark country landmasses on true black,
// bilateral flows as great-circle paths — a faint static base network plus a
// continuous stream of glowing pulses flowing exporter -> importer along each
// line. Colour encodes commodity; width, size and opacity scale with volume.

const { Deck, MapView, GeoJsonLayer, PathLayer, ScatterplotLayer } = deck;

const DATA = "data/";
const state = {
  data: null, countries: null, world: null,
  active: new Set(),
  periodIdx: 0,
  measure: "v",
  hover: null,
  maxByMeasure: { v: 1, w: 1 },
  flows: [],
  time: 0,
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
const MAX_WIDTH_PX = 6;    // widest static line
const MIN_WIDTH_PX = 0.3;
const PULSES = 3;          // pulses in flight per line at once → continuous stream
const SPEED = 0.14;        // traversals per second (1 / seconds-per-trip)
const DOT_MIN = 0.9, DOT_MAX = 4.4;  // pulse radius range (px)
const FADE = 0.09;         // fraction of the path over which pulses fade in/out

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
const geomCache = new Map();

// deterministic per-flow phase so pulse streams are staggered but stable
function phaseOf(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return (h % 997) / 997;
}

// evenly-spaced great-circle samples (equal angular step ≈ equal arc length),
// longitudes unwrapped across the antimeridian so interpolation stays continuous
function greatCircle(a, b) {
  const lo1 = a[0] * D2R, la1 = a[1] * D2R, lo2 = b[0] * D2R, la2 = b[1] * D2R;
  const dLat = la2 - la1, dLon = lo2 - lo1;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  const d = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  if (d < 1e-6) return [a, b];
  const n = Math.max(12, Math.min(64, Math.round(d * R2D / 3)));
  const sinD = Math.sin(d);
  const pts = [];
  let prevLon = null;
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / sinD, B = Math.sin(f * d) / sinD;
    const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
    const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
    const z = A * Math.sin(la1) + B * Math.sin(la2);
    const lat = Math.atan2(z, Math.hypot(x, y)) * R2D;
    let lon = Math.atan2(y, x) * R2D;
    if (prevLon !== null) {
      while (lon - prevLon > 180) lon -= 360;
      while (lon - prevLon < -180) lon += 360;
    }
    prevLon = lon;
    pts.push([lon, lat]);
  }
  return pts;
}

function geomFor(d) {
  let g = geomCache.get(d.key);
  if (!g) g = geomCache.set(d.key, { path: greatCircle(d.es, d.is), phase: phaseOf(d.key) }).get(d.key);
  return g;
}

// position at fraction f (0..1) along a flow's path (uniform speed)
function pointAt(path, f) {
  const n = path.length - 1;
  const x = f * n;
  const i = Math.min(n - 1, Math.max(0, Math.floor(x)));
  const t = x - i;
  const a = path[i], b = path[i + 1];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/* ---------- scales ---------- */

const norm = (d) => Math.sqrt(d[state.measure]) / Math.sqrt(state.maxByMeasure[state.measure]);
const widthFor = (d) => MIN_WIDTH_PX + norm(d) * (MAX_WIDTH_PX - MIN_WIDTH_PX);
const baseAlpha = (d) => Math.round(8 + norm(d) * 42);    // faint static line 8..50
const dotAlpha = (d) => Math.round(70 + norm(d) * 175);   // pulse 70..245
const dotRadius = (d) => DOT_MIN + norm(d) * (DOT_MAX - DOT_MIN);

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
      rec.path = g.path; rec.phase = g.phase;
      out.push(rec);
    }
  }
  out.sort((a, b) => a[state.measure] - b[state.measure]);
  state.flows = out;
  updateStat(out);
}

// build the moving pulses for the current time — a stream per line, wrapping
// seamlessly (fade in at source, out at destination) so there is no loop point
function buildPulses() {
  const dots = [];
  const t = state.time;
  for (const d of state.flows) {
    const rad = dotRadius(d), a = dotAlpha(d), col = d.color;
    for (let j = 0; j < PULSES; j++) {
      let f = (t * SPEED + d.phase + j / PULSES) % 1;
      // fade near both ends so the wrap (dest -> source) is invisible
      const fIn = Math.min(1, f / FADE);
      const fOut = Math.min(1, (1 - f) / FADE);
      const fade = Math.min(fIn, fOut);
      if (fade <= 0.02) continue;
      dots.push({
        position: pointAt(d.path, f),
        color: [col[0], col[1], col[2], Math.round(a * fade)],
        radius: rad * (0.6 + 0.4 * fade),
      });
    }
  }
  return dots;
}

/* ---------- render (every frame) ---------- */

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

  const net = new PathLayer({
    id: "net",
    data: flows,
    getPath: (d) => d.path,
    getColor: (d) => [...d.color, baseAlpha(d)],
    getWidth: (d) => Math.max(0.5, widthFor(d) * 0.5),
    widthUnits: "pixels", widthMinPixels: 0.5,
    capRounded: true, jointRounded: true,
    parameters: { depthTest: false },
    updateTriggers: { getColor: [state.measure], getWidth: [state.measure] },
    pickable: true, onHover: onHover,
  });

  const pulses = new ScatterplotLayer({
    id: "pulses",
    data: buildPulses(),
    getPosition: (d) => d.position,
    getFillColor: (d) => d.color,
    getRadius: (d) => d.radius,
    radiusUnits: "pixels",
    radiusMinPixels: 0.6,
    stroked: false,
    parameters: { depthTest: false, blend: true, blendFunc: [770, 1] }, // additive glow
  });

  const layers = [base, net, pulses];

  if (state.hover) {
    layers.push(new PathLayer({
      id: "hi",
      data: [state.hover],
      getPath: (d) => d.path,
      getColor: (d) => [...d.color, 235],
      getWidth: (d) => widthFor(d) + 1.2,
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
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  state.time += dt;
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
