// FlightxTrack backend: serves the website + JSON APIs.
//   /api/flights  -> current aircraft over India (from OpenSky, cached)
//   /api/history  -> snapshots of traffic counts over time (for analytics charts)
// Zero dependencies (Node 18+).
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const POLL_MS = 30000;          // background poll interval (OpenSky anonymous limits are strict)
const HISTORY_MAX = 2880;       // 24h at 30s
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

async function poll() {
  try {
    const res = await fetch(OPENSKY, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`OpenSky responded ${res.status}`);
    const json = await res.json();
    const flights = (json.states || []).map(parseState).filter((f) => f.lat != null && f.lon != null);
    latest = { fetchedAt: Date.now(), count: flights.length, flights };
    lastError = null;

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
poll();
setInterval(poll, POLL_MS);

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
