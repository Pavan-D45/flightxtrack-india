// FlightxTrack backend: serves the website + JSON APIs.
//   /api/flights  -> current aircraft over India (from OpenSky, cached)
//   /api/history  -> snapshots of traffic counts over time (for analytics charts)
// Zero dependencies (Node 18+).
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const POLL_MS = 20000;          // pause between polls (a poll itself takes ~25s)
const HISTORY_MAX = 1440;       // ~16h at ~60s per sample
const HISTORY_FILE = path.join(__dirname, "history.json");

const BOX = { lamin: 6.0, lamax: 37.5, lomin: 68.0, lomax: 97.5 }; // covers India
const OPENSKY = `https://opensky-network.org/api/states/all?lamin=${BOX.lamin}&lamax=${BOX.lamax}&lomin=${BOX.lomin}&lomax=${BOX.lomax}`;

let latest = null;   // { fetchedAt, count, flights }
let lastError = null;
let history = [];
try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); } catch {}

function parseState(s) {
  return {
    icao24: s[0],
    callsign: (s[1] || "").trim() || null,
    country: s[2],
    lon: s[5],
    lat: s[6],
    altitude: s[7] ?? s[13],   // metres
    onGround: s[8],
    speed: s[9],               // m/s
    heading: s[10],
    vertRate: s[11],           // m/s
    lastContact: s[4],
  };
}

// ---- Routes (origin/destination) via adsbdb.com: free, no key, lookup by callsign ----
// Results are cached on disk. Lookups run in a slow background queue so we stay polite.
const ROUTES_FILE = path.join(__dirname, "routes.json");
const ROUTE_OK_MS = 24 * 3600e3, ROUTE_MISS_MS = 6 * 3600e3;
let routeCache = {};            // callsign -> { t, route|null }
try { routeCache = JSON.parse(fs.readFileSync(ROUTES_FILE, "utf8")); } catch {}
const queue = new Set();
let working = false;
const slim = (a) => a && { iata: a.iata_code, icao: a.icao_code, city: a.municipality, name: a.name, country: a.country_iso_name, lat: a.latitude, lon: a.longitude };

function routeFor(callsign) {
  const c = routeCache[callsign];
  if (c && Date.now() - c.t < (c.route ? ROUTE_OK_MS : ROUTE_MISS_MS)) return c.route;
  if (/^[A-Z]{3}\d/.test(callsign)) { queue.add(callsign); work(); }   // airline-style callsigns only
  return c ? c.route : null;
}
async function work() {
  if (working) return;
  working = true;
  while (queue.size) {
    const cs = queue.values().next().value;
    queue.delete(cs);
    try {
      const r = await fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`, { signal: AbortSignal.timeout(10000) });
      if (r.status === 429) { queue.add(cs); await new Promise((x) => setTimeout(x, 30000)); continue; }
      const fr = r.ok ? (await r.json()).response?.flightroute : null;
      routeCache[cs] = { t: Date.now(), route: fr && fr.origin && fr.destination ? { from: slim(fr.origin), to: slim(fr.destination) } : null };
    } catch { routeCache[cs] = { t: Date.now(), route: null }; }
    await new Promise((x) => setTimeout(x, 300));
  }
  working = false;
  fs.writeFile(ROUTES_FILE, JSON.stringify(routeCache), () => {});
}

// ---- Data source 1 (primary): adsb.lol, free community ADS-B API, no key ----
// It answers "aircraft within N nautical miles of a point" (max 250 nm), so we tile India with circles.
const TILES = [];
for (const lat of [10.5, 16, 21.5, 27, 32.5]) for (const lon of [71, 76.5, 82, 87.5, 93]) if (!(lat === 32.5 && lon > 85)) TILES.push([lat, lon]);
const FT = 0.3048, KT = 0.514444;

// Country from the ICAO24 address block (adsb.lol doesn't give it). Unlisted blocks -> "Other".
const BLOCKS = [
  [0x800000, 0x83ffff, "India"], [0xa00000, 0xafffff, "United States"], [0x400000, 0x43ffff, "United Kingdom"],
  [0x3c0000, 0x3fffff, "Germany"], [0x380000, 0x3bffff, "France"], [0x480000, 0x487fff, "Netherlands"],
  [0x880000, 0x887fff, "Thailand"], [0x896000, 0x896fff, "United Arab Emirates"], [0x06a000, 0x06afff, "Qatar"],
  [0x710000, 0x717fff, "Saudi Arabia"], [0x780000, 0x7bffff, "China"], [0x750000, 0x757fff, "Malaysia"],
  [0x768000, 0x76ffff, "Singapore"], [0x770000, 0x777fff, "Sri Lanka"], [0x700000, 0x700fff, "Bangladesh"],
  [0x760000, 0x767fff, "Pakistan"], [0x70c000, 0x70cfff, "Oman"], [0x706000, 0x706fff, "Kuwait"],
  [0x894000, 0x894fff, "Bahrain"], [0x4b8000, 0x4bffff, "Turkey"], [0x100000, 0x1fffff, "Russia"],
  [0x7c0000, 0x7fffff, "Australia"], [0xc00000, 0xc3ffff, "Canada"], [0x840000, 0x87ffff, "Japan"],
  [0x8a0000, 0x8a7fff, "Indonesia"],
];
function countryOf(hex) {
  const n = parseInt(hex, 16);
  const b = BLOCKS.find(([lo, hi]) => n >= lo && n <= hi);
  return b ? b[2] : "Other";
}
function parseAdsbLol(a) {
  const ground = a.alt_baro === "ground";
  const altFt = typeof a.alt_baro === "number" ? a.alt_baro : a.alt_geom;
  return {
    icao24: a.hex,
    callsign: (a.flight || "").trim() || null,
    country: countryOf(a.hex),
    lon: a.lon, lat: a.lat,
    altitude: ground ? 0 : altFt != null ? altFt * FT : null,            // metres
    onGround: ground,
    speed: a.gs != null ? a.gs * KT : null,                               // m/s
    heading: a.track ?? null,
    vertRate: (a.baro_rate ?? a.geom_rate) != null ? (a.baro_rate ?? a.geom_rate) * FT / 60 : null,  // m/s
    lastContact: Math.round(Date.now() / 1000 - (a.seen || 0)),
    type: a.t || null,                                                    // aircraft type, e.g. A320
    reg: a.r || null,                                                     // registration
  };
}
// Two free providers with the same readsb data format. Each region is fetched from one of them,
// and falls back to the other on any failure (e.g. HTTP 429), so neither gets hammered.
const ADSB_PROVIDERS = [
  { name: "adsb.lol", url: (lat, lon) => `https://api.adsb.lol/v2/point/${lat}/${lon}/250`, list: (j) => j.ac },
  { name: "adsb.fi", url: (lat, lon) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/250`, list: (j) => j.aircraft },
];
const TILE_GAP_MS = 1100;          // ~1 request/second overall
const TILE_STALE_MS = 4 * 60e3;    // keep a region's last good result this long if it can't be refreshed
const tileCache = new Map();       // tile index -> { t, list }
let adsbErrors = [];

async function fetchTile(i) {
  const [lat, lon] = TILES[i];
  const order = i % 2 ? [1, 0] : [0, 1];
  for (const pi of order) {
    const p = ADSB_PROVIDERS[pi];
    try {
      const r = await fetch(p.url(lat, lon), { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`${p.name} responded ${r.status}`);
      return { t: Date.now(), list: p.list(await r.json()) || [] };
    } catch (e) { adsbErrors.push(why(e)); }
  }
  return null;
}
async function fromAdsb() {
  adsbErrors = [];
  for (let i = 0; i < TILES.length; i++) {
    const res = await fetchTile(i);
    if (res) tileCache.set(i, res);
    await new Promise((x) => setTimeout(x, TILE_GAP_MS));
  }
  const seen = new Map();
  for (const { t, list } of tileCache.values()) {
    if (Date.now() - t > TILE_STALE_MS) continue;
    for (const a of list) if (a.lat != null && a.lon != null) seen.set(a.hex, a);
  }
  if (!seen.size) throw new Error([...new Set(adsbErrors)].slice(0, 3).join("; ") || "no data from adsb.lol / adsb.fi");
  return [...seen.values()].map(parseAdsbLol)
    .filter((f) => f.lat >= BOX.lamin && f.lat <= BOX.lamax && f.lon >= BOX.lomin && f.lon <= BOX.lomax);
}

// ---- Data source 2 (backup): OpenSky Network ----
async function fromOpenSky() {
  const res = await fetch(OPENSKY, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`OpenSky responded ${res.status}`);
  return ((await res.json()).states || []).map(parseState).filter((f) => f.lat != null && f.lon != null);
}

let openSkyPausedUntil = 0;

// "fetch failed" alone is useless; include the underlying network error code.
const why = (e) => e.message + (e.cause ? ` (${e.cause.code || e.cause.message})` : "");

async function poll() {
  try {
    // Ask both sources and merge by aircraft ID for the best coverage; either one alone is enough.
    const errors = [], got = {};
    const skipOpenSky = Date.now() < openSkyPausedUntil;
    const jobs = [["adsb", fromAdsb], ...(skipOpenSky ? [] : [["OpenSky", fromOpenSky]])];
    await Promise.all(jobs.map(async ([name, fn]) => {
      try { got[name] = await fn(); }
      catch (e) {
        errors.push(`${name}: ${why(e)}`);
        if (name === "OpenSky") openSkyPausedUntil = Date.now() + 5 * 60e3;   // back off for 5 min after any failure (e.g. 429)
      }
    }));
    const byId = new Map();
    for (const f of got["OpenSky"] || []) byId.set(f.icao24, f);
    for (const f of got["adsb"] || []) {
      const o = byId.get(f.icao24);
      byId.set(f.icao24, { ...o, ...f, country: o?.country || f.country });   // adsb.lol: type/reg/fresher fields; OpenSky: authoritative country
    }
    const flights = [...byId.values()];
    const source = Object.keys(got).filter((k) => got[k].length).join(" + ");
    if (!flights.length) throw new Error(errors.join("; ") || "no aircraft returned");
    latest = { fetchedAt: Date.now(), count: flights.length, source, flights };
    lastError = errors.length ? errors.join("; ") : null;

    const air = flights.filter((f) => !f.onGround);
    const alts = air.map((f) => f.altitude).filter((a) => a != null);
    history.push({
      t: latest.fetchedAt,
      air: air.length,
      ground: flights.length - air.length,
      avgAlt: alts.length ? Math.round(alts.reduce((a, b) => a + b, 0) / alts.length) : 0,
    });
    if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
    fs.writeFile(HISTORY_FILE, JSON.stringify(history), () => {});
  } catch (e) {
    lastError = e.message;
    console.log("poll failed:", e.message);
  }
}
// Sequential loop (never overlaps, even though one poll takes ~10-15s)
(async function loop() { await poll(); setTimeout(loop, POLL_MS); })();

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

http
  .createServer((req, res) => {
    const url = req.url.split("?")[0];
    if (url === "/api/flights") {
      if (!latest) return json(res, 502, { error: lastError || "Loading first data…" });
      const flights = latest.flights.map((f) => ({ ...f, route: f.callsign ? routeFor(f.callsign) : null }));
      return json(res, 200, { ...latest, flights, routesPending: queue.size, warning: lastError });
    }
    if (url === "/api/history") return json(res, 200, history);

    const file = url === "/" ? "/index.html" : url;
    const root = path.join(__dirname, "public");
    const full = path.join(root, path.normalize(file));
    if (!full.startsWith(root)) { res.writeHead(403); return res.end(); }
    fs.readFile(full, (err, buf) => {
      if (err) { res.writeHead(404); return res.end("Not found"); }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(full)] || "application/octet-stream" });
      res.end(buf);
    });
  })
  .listen(PORT, () => console.log(`FlightxTrack running at http://localhost:${PORT}`));
