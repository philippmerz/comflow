// comflow — global hard-commodity trade flows.
// deck.gl standalone (no basemap tiles): country landmasses drawn as dark
// polygons on true black, bilateral flows as glowing arcs coloured by
// commodity, width scaled by the selected measure.

const { Deck, MapView, GeoJsonLayer, ArcLayer } = deck;

const DATA = "data/";
const state = {
  data: null,
  countries: null,
  active: new Set(),      // commodity ids currently shown
  periodIdx: 0,
  measure: "v",           // 'v' value (USD) | 'w' weight (tonnes)
  hover: null,            // hovered flow key
  maxByMeasure: { v: 1, w: 1 }, // global max for stable width scaling across periods
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
const ARC_HEIGHT = 0.22;  // lower = flatter arcs that stay within frame
const MAX_WIDTH_PX = 13;   // widest arc
const MIN_WIDTH_PX = 0.7;  // thinnest visible arc

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
  state.periodIdx = data.meta.years.length - 1; // start on the latest period

  computeMaxima();
  buildChips();
  buildTimeline();
  wireMeasure();

  deckgl = new Deck({
    parent: el("map"),
    views: new MapView({ repeat: true }),
    initialViewState: INITIAL_VIEW,
    controller: { dragRotate: true, minZoom: 0.6, maxZoom: 7, inertia: 220 },
    getCursor: ({ isHovering }) => (isHovering ? "pointer" : "grab"),
    layers: [],
  });

  el("src").innerHTML =
    `BACI (CEPII) · reconciled UN Comtrade · top ${data.meta.top_n}/commodity`;

  render();
}

// widest flow per measure across ALL commodities & periods, so arc widths stay
// comparable when you scrub time or toggle commodities.
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

function currentPeriod() {
  return String(state.data.meta.years[state.periodIdx]);
}

function commodityById(id) {
  return state.data.meta.commodities.find((c) => c.id === id);
}

// flatten active commodities for the current period into arc records
function currentFlows() {
  const yr = currentPeriod();
  const out = [];
  for (const c of state.data.meta.commodities) {
    if (!state.active.has(c.id)) continue;
    const rows = (state.data.flows[c.id] && state.data.flows[c.id][yr]) || [];
    for (const d of rows) {
      out.push({
        key: c.id + "|" + d.e + "|" + d.i,
        cid: c.id,
        color: c.color,
        label: c.label,
        e: d.e, i: d.i,
        es: d.es, is: d.is,
        v: d.v, w: d.w,
      });
    }
  }
  // draw largest last (on top)
  out.sort((a, b) => a[state.measure] - b[state.measure]);
  return out;
}

function widthFor(d) {
  const m = state.measure;
  const norm = Math.sqrt(d[m]) / Math.sqrt(state.maxByMeasure[m]);
  return MIN_WIDTH_PX + norm * (MAX_WIDTH_PX - MIN_WIDTH_PX);
}

// deck.gl arc peak height scales with span, so long routes bow far higher than
// short ones. Scale height inversely with span so every arc bows to a similar,
// gentle height — a tidy uniform arc field instead of tall vertical streaks.
function heightFor(d) {
  const dx = d.es[0] - d.is[0], dy = d.es[1] - d.is[1];
  const span = Math.hypot(dx, dy) || 1;          // rough great-circle span (deg)
  return Math.max(0.08, Math.min(0.6, (ARC_HEIGHT * 55) / span));
}

function render() {
  const flows = currentFlows();

  const base = new GeoJsonLayer({
    id: "countries",
    data: state.world,
    stroked: true,
    filled: true,
    getFillColor: [17, 19, 24, 255],
    getLineColor: [42, 46, 54, 255],
    lineWidthMinPixels: 0.5,
    parameters: { depthTest: false },
  });

  const hoverKey = state.hover;

  // glow halo (wide, low alpha) beneath the crisp arc → neon on black
  const halo = new ArcLayer({
    id: "arcs-halo",
    data: flows,
    greatCircle: true,
    getSourcePosition: (d) => d.es,
    getTargetPosition: (d) => d.is,
    getSourceColor: (d) => rgba(d.color, hoverKey && d.key !== hoverKey ? 8 : 26),
    getTargetColor: (d) => rgba(d.color, hoverKey && d.key !== hoverKey ? 10 : 34),
    getWidth: (d) => widthFor(d) * 3.2,
    widthUnits: "pixels",
    getHeight: heightFor,
    parameters: { depthTest: false, blend: true, blendFunc: [770, 1] }, // additive
    pickable: false,
    updateTriggers: { getSourceColor: [hoverKey], getTargetColor: [hoverKey], getWidth: [state.measure] },
  });

  const arcs = new ArcLayer({
    id: "arcs",
    data: flows,
    greatCircle: true,
    getSourcePosition: (d) => d.es,
    getTargetPosition: (d) => d.is,
    // exporter end dimmer, importer end bright → reads as direction of flow
    getSourceColor: (d) => rgba(d.color, alphaFor(d, hoverKey, 70)),
    getTargetColor: (d) => rgba(d.color, alphaFor(d, hoverKey, 235)),
    getWidth: widthFor,
    widthUnits: "pixels",
    widthMinPixels: MIN_WIDTH_PX,
    getHeight: heightFor,
    pickable: true,
    autoHighlight: false,
    parameters: { depthTest: false },
    onHover: onHover,
    updateTriggers: {
      getSourceColor: [hoverKey],
      getTargetColor: [hoverKey],
      getWidth: [state.measure],
    },
  });

  deckgl.setProps({ layers: [base, halo, arcs] });
  updateStat(flows);
}

function alphaFor(d, hoverKey, full) {
  if (!hoverKey) return full;
  return d.key === hoverKey ? Math.min(255, full + 20) : Math.round(full * 0.16);
}

function rgba(c, a) {
  return [c[0], c[1], c[2], a];
}

function onHover(info) {
  const tip = el("tooltip");
  if (!info.object) {
    if (state.hover !== null) {
      state.hover = null;
      render();
    }
    tip.hidden = true;
    return;
  }
  const d = info.object;
  if (state.hover !== d.key) {
    state.hover = d.key;
    render();
  }
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

function nameOf(iso) {
  return (state.countries[iso] && state.countries[iso].name) || iso;
}

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
    chip.onclick = () => toggleCommodity(c.id, chip);
    box.appendChild(chip);
  }
}

function toggleCommodity(id, chip) {
  if (state.active.has(id)) {
    state.active.delete(id);
    chip.classList.remove("on"); chip.classList.add("off");
  } else {
    state.active.add(id);
    chip.classList.add("on"); chip.classList.remove("off");
  }
  render();
}

function buildTimeline() {
  const years = state.data.meta.years;
  const slider = el("time");
  slider.min = 0;
  slider.max = years.length - 1;
  slider.value = state.periodIdx;
  el("time-value").textContent = years[state.periodIdx];
  slider.oninput = () => {
    state.periodIdx = +slider.value;
    el("time-value").textContent = years[state.periodIdx];
    render();
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
      render();
    };
  });
}
