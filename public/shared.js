// Shared by every page: navbar, unit helpers, airline lookup, data fetching.
const ftFromM = (m) => Math.round(m * 3.28084);
const knFromMs = (v) => Math.round(v * 1.94384);
const kmhFromMs = (v) => Math.round(v * 3.6);

// ICAO airline code (first 3 letters of callsign) -> name
const AIRLINES = {
  IGO: "IndiGo", AIC: "Air India", AXB: "Air India Express", VTI: "Vistara", SEJ: "SpiceJet",
  AKJ: "Akasa Air", LLR: "Alliance Air", SDG: "Star Air", IAD: "Air India Express", GOW: "Go First",
  FLJ: "Fly91", ETD: "Etihad", UAE: "Emirates", QTR: "Qatar Airways", FDB: "flydubai", ABY: "Air Arabia",
  SIA: "Singapore Airlines", THA: "Thai Airways", BAW: "British Airways", DLH: "Lufthansa",
  AFR: "Air France", KLM: "KLM", SVA: "Saudia", OMA: "Oman Air", GFA: "Gulf Air", KAC: "Kuwait Airways",
  MAS: "Malaysia Airlines", AIQ: "Thai AirAsia", AXM: "AirAsia", CPA: "Cathay Pacific", THY: "Turkish Airlines",
  UAL: "United", AAL: "American", BBC: "Biman Bangladesh", UBG: "US-Bangla", ALK: "SriLankan", DRK: "Drukair",
  CES: "China Eastern", CSN: "China Southern", CCA: "Air China", PIA: "PIA", RBA: "Royal Brunei", FIN: "Finnair",
  SWR: "Swiss", ETH: "Ethiopian", RJA: "Royal Jordanian", MEA: "Middle East Airlines", IRM: "Mahan Air",
  MXD: "Batik Air Malaysia", TGW: "Scoot", JST: "Jetstar", VIR: "Virgin Atlantic", ACA: "Air Canada",
};
function airlineOf(f) {
  const m = (f.callsign || "").match(/^[A-Z]{3}(?=\d)/);
  if (!m) return null;
  return AIRLINES[m[0]] || null;
}
function phase(f) {
  if (f.onGround) return "On ground";
  if (f.vertRate > 1.5) return "Climbing";
  if (f.vertRate < -1.5) return "Descending";
  return "Cruising / level";
}

// ---- Airports ----
let _airports = null;
async function loadAirports() {
  if (!_airports) _airports = await (await fetch("/airports.json")).json();
  return _airports;
}
function distKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}
function nearestAirport(f, airports) {
  let best = null, bd = Infinity;
  for (const a of airports) { const d = distKm(f.lat, f.lon, a.lat, a.lon); if (d < bd) { bd = d; best = a; } }
  return best ? { airport: best, km: Math.round(bd) } : null;
}
// Heuristic: low and close to an airport = probably arriving or departing there.
function terminalActivity(f, airports, radiusKm = 40, maxAltM = 3000) {
  if (f.onGround || f.altitude == null || f.altitude > maxAltM) return null;
  const n = nearestAirport(f, airports);
  if (!n || n.km > radiusKm) return null;
  let kind = f.vertRate < -1 ? "arriving" : f.vertRate > 1 ? "departing" : "near";
  // A known route beats the climb/descent guess
  if (f.route && n.airport.iata === f.route.to.iata) kind = "arriving";
  else if (f.route && n.airport.iata === f.route.from.iata) kind = "departing";
  return { ...n, kind };
}
// "DEL → BOM" (or null if the route is unknown)
function routeCodes(f) { return f.route ? `${f.route.from.iata} → ${f.route.to.iata}` : null; }
// How far along the route a flight is, 0–100 (null if unknown)
function routeProgress(f) {
  if (!f.route) return null;
  const a = distKm(f.lat, f.lon, f.route.from.lat, f.route.from.lon), b = distKm(f.lat, f.lon, f.route.to.lat, f.route.to.lon);
  return Math.round((a / (a + b)) * 100);
}

async function fetchFlights() {
  const res = await fetch("/api/flights");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}

// Navbar
(function () {
  const pages = [["/", "Live Map"], ["/flights.html", "Flights"], ["/airports.html", "Airports"],["/analytics.html", "Analytics"], ["/about.html", "About"]];
  const here = location.pathname === "/index.html" ? "/" : location.pathname;
  const nav = document.createElement("nav");
  nav.innerHTML = `<a class="brand" href="/">✈ Flightx<span>Track</span> <em>India</em></a>
    <button id="burger" aria-label="Menu">☰</button>
    <div class="links">${pages.map(([h, t]) => `<a href="${h}" class="${h === here ? "active" : ""}">${t}</a>`).join("")}</div>
    <div class="live"><i></i> <span id="nav-updated">connecting…</span></div>`;
  document.body.prepend(nav);
  nav.querySelector("#burger").onclick = () => nav.classList.toggle("open");
})();
function setUpdated(ts) {
  const el = document.getElementById("nav-updated");
  if (el) el.textContent = "Updated " + new Date(ts).toLocaleTimeString();
}
