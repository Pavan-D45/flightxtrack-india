// Live Map page: polls /api/flights and draws planes on a Leaflet map.
const REFRESH_MS = 15000;
const map = L.map("map").setView([22.5, 80], 5);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap contributors | Data: OpenSky Network",
  maxZoom: 12,
}).addTo(map);

const markers = new Map();
const trails = new Map();
let trailLine = null, selected = null, flights = [];

function icon(f, sel) {
  const rot = (f.heading ?? 0) - 90; // ✈ glyph points east
  return L.divIcon({
    className: "",
    html: `<div class="plane ${sel ? "sel" : ""}" style="transform:rotate(${rot}deg)">✈</div>`,
    iconSize: [24, 24], iconAnchor: [12, 12],
  });
}
let airports = [];
function nearText(f) {
  const act = terminalActivity(f, airports);
  if (act) return `<br><b>${act.kind[0].toUpperCase() + act.kind.slice(1)} ${act.airport.iata}</b> (${act.airport.city}, ${act.km} km)`;
  const n = airports.length && nearestAirport(f, airports);
  return n ? `<br>Nearest airport: ${n.airport.iata} (${n.km} km)` : "";
}
function routeHtml(f) {
  if (!f.route) return "";
  return `<br><b>${routeCodes(f)}</b> · ${routeProgress(f)}% of the way<br>
    <small>${f.route.from.city} → ${f.route.to.city}</small>`;
}
function popup(f) {
  return `<b>${f.callsign || "Unknown"}</b> ${airlineOf(f) ? "· " + airlineOf(f) : ""}${routeHtml(f)}${nearText(f)}<br>
    ${f.type ? `Aircraft: ${f.type}${f.reg ? " (" + f.reg + ")" : ""}<br>` : ""}Registered: ${f.country}<br>
    Status: ${phase(f)}<br>
    Altitude: ${f.altitude != null ? ftFromM(f.altitude).toLocaleString() + " ft" : "–"}<br>
    Speed: ${f.speed != null ? knFromMs(f.speed) + " kt (" + kmhFromMs(f.speed) + " km/h)" : "–"}<br>
    Heading: ${f.heading != null ? Math.round(f.heading) + "°" : "–"}<br>
    ICAO24: ${f.icao24}`;
}
function select(id) { selected = id; drawTrail(); render(); }
function drawTrail() {
  if (trailLine) { map.removeLayer(trailLine); trailLine = null; }
  const t = trails.get(selected);
  const f = flights.find((x) => x.icao24 === selected);
  const layers = [];
  if (t && t.length > 1) layers.push(L.polyline(t, { color: "#f43f5e", weight: 3 }));   // where it has been
  if (f && f.route) {                                                                   // planned route
    const { from, to } = f.route;
    layers.push(L.polyline([[from.lat, from.lon], [f.lat, f.lon], [to.lat, to.lon]], { color: "#38bdf8", weight: 2, dashArray: "6 8" }));
    layers.push(L.circleMarker([from.lat, from.lon], { radius: 5, color: "#22c55e" }).bindTooltip("From " + from.iata));
    layers.push(L.circleMarker([to.lat, to.lon], { radius: 5, color: "#f43f5e" }).bindTooltip("To " + to.iata));
  }
  if (layers.length) trailLine = L.layerGroup(layers).addTo(map);
}

function render() {
  const q = document.getElementById("search").value.trim().toUpperCase();
  const visible = flights.filter((f) => !q || (f.callsign || "").startsWith(q) || (airlineOf(f) || "").toUpperCase().includes(q));
  const seen = new Set();
  for (const f of visible) {
    seen.add(f.icao24);
    let m = markers.get(f.icao24);
    if (!m) { m = L.marker([f.lat, f.lon]).addTo(map).on("click", () => select(f.icao24)); markers.set(f.icao24, m); }
    m.setLatLng([f.lat, f.lon]).setIcon(icon(f, f.icao24 === selected)).bindPopup(popup(f));
  }
  for (const [id, m] of markers) if (!seen.has(id)) { map.removeLayer(m); markers.delete(id); }

  document.getElementById("rows").innerHTML = visible
    .filter((f) => !f.onGround)
    .sort((a, b) => (a.callsign || "~").localeCompare(b.callsign || "~"))
    .slice(0, 300)
    .map((f) => `<div class="row" data-id="${f.icao24}"><b>${f.callsign || f.icao24}</b>
      <span>${f.altitude != null ? ftFromM(f.altitude).toLocaleString() + " ft" : ""}</span>
      <small>${routeCodes(f) || airlineOf(f) || f.country}</small></div>`).join("");
}

async function refresh() {
  const status = document.getElementById("status");
  try {
    const data = await fetchFlights();
    flights = data.flights;
    for (const f of flights) {
      const t = trails.get(f.icao24) || [];
      const last = t[t.length - 1];
      if (!last || last[0] !== f.lat || last[1] !== f.lon) t.push([f.lat, f.lon]);
      trails.set(f.icao24, t.slice(-60));
    }
    status.style.display = "none";
    const air = flights.filter((f) => !f.onGround).length;
    document.getElementById("s-total").textContent = air;
    document.getElementById("s-ground").textContent = flights.length - air;
    setUpdated(data.fetchedAt);
    render(); drawTrail();
  } catch (e) {
    status.textContent = "Data unavailable: " + e.message + " (retrying)";
    status.style.display = "block";
  }
}

document.getElementById("search").addEventListener("input", render);
document.getElementById("rows").addEventListener("click", (e) => {
  const row = e.target.closest(".row");
  const f = row && flights.find((x) => x.icao24 === row.dataset.id);
  if (f) { select(f.icao24); map.setView([f.lat, f.lon], 8); markers.get(f.icao24)?.openPopup(); }
});
// Airport markers (toggle control, large airports labelled)
const airportLayer = L.layerGroup().addTo(map);
loadAirports().then((list) => {
  airports = list;
  for (const a of list) {
    const big = a.size === "large";
    L.circleMarker([a.lat, a.lon], { radius: big ? 6 : 4, color: "#0b1220", weight: 1, fillColor: big ? "#22d3ee" : "#64748b", fillOpacity: 0.95 })
      .bindTooltip(`<b>${a.iata}</b> · ${a.name}<br>${a.city || ""}`).addTo(airportLayer);
  }
  L.control.layers(null, { "Airports": airportLayer }, { collapsed: false, position: "topright" }).addTo(map);
});
refresh();
setInterval(refresh, REFRESH_MS);
