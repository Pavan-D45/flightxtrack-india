# FlightxTrack India

A website that shows live air traffic over India using free, public data. It has a live map, a searchable flights table, an airports page and an analytics dashboard.

- **Stack:** Node.js (no npm packages) + plain HTML/CSS/JavaScript, Leaflet (maps), Chart.js (charts)
- **Data sources (all free, no API keys):**
  - [adsb.lol](https://adsb.lol) (primary) and [OpenSky Network](https://opensky-network.org) (backup): live aircraft positions. The server asks both and merges them by aircraft ID. If one is blocked or rate-limited, the other keeps the site working.
  - [OurAirports](https://ourairports.com/data/): airport list (public domain)
  - [adsbdb.com](https://www.adsbdb.com): flight routes (origin → destination) by callsign

---

## 1. Run it

```bash
cd C:\FlightxTrack
node server.js
```

Open http://localhost:3000. Needs Node 18+ (built-in `fetch`). There is nothing to install.

To change the port: `set PORT=8080` then `node server.js`.

### Deploy (Render, free tier)
1. Push this repo to GitHub.
2. On [render.com](https://render.com): **New → Blueprint** (or **Web Service**), pick the repo. `render.yaml` sets everything: start command `node server.js`, no build step.
3. Render sets `PORT` automatically; the server already reads it.

Free-tier notes: the service sleeps after ~15 min without visitors (first load is slow, and the server isn't polling or recording history while asleep), and its disk is wiped on each restart, so `history.json` and `routes.json` start fresh. That's fine for a demo. For continuous history, use a paid instance with a persistent disk or move history to a database.

---

## 2. The big picture

```
   ┌────────────────────┐   ┌─────────────────┐   ┌──────────────────┐
   │  OpenSky Network   │   │     adsbdb      │   │   OurAirports    │
   │ live positions     │   │ routes by       │   │ airport list     │
   │ (every 30s)        │   │ callsign        │   │ (one-time file)  │
   └─────────┬──────────┘   └────────┬────────┘   └────────┬─────────┘
             │ HTTPS/JSON            │ HTTPS/JSON          │ filtered once
             ▼                       ▼                     ▼ → airports.json
   ┌──────────────────────────────────────────────────────────────────┐
   │                    BACKEND  (server.js, Node)                     │
   │  • polls OpenSky every 30s for a box around India                 │
   │  • cleans raw data into readable objects                          │
   │  • looks up routes in a slow background queue, caches them        │
   │  • records traffic counts over time (history)                     │
   │  • serves the API and the website files                           │
   └──────────────┬─────────────────────────────┬─────────────────────┘
        /api/flights                      /api/history
        (aircraft + route)                (counts over time)
                  │                             │
                  ▼                             ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │                 FRONTEND  (public/, in the browser)               │
   │   Live Map │ Flights │ Airports │ Analytics │ About               │
   │   each page fetches the API on a timer and redraws                │
   └──────────────────────────────────────────────────────────────────┘
```

**Why a backend instead of calling OpenSky from the browser?**

1. **Rate limits.** OpenSky limits anonymous use. With the server in the middle, 1 or 1,000 visitors cause the same number of upstream calls.
2. **Enrichment.** The server joins positions with routes before the browser sees them.
3. **History.** Only a server that keeps running can record traffic over time.
4. **One place to change.** If we switch data providers, the frontend doesn't change.

---

## 3. Data flow, step by step

### A. About every minute (server)
1. `poll()` asks two sources at the same time:
   - **adsb.lol** only answers "aircraft within 250 nm of a point", so the server queries a 5×5 grid of points that tile India (`TILES`) and removes duplicates.
   - **OpenSky** takes one rectangle: `GET /api/states/all?lamin=6&lamax=37.5&lomin=68&lomax=97.5`. If it fails (e.g. HTTP 429 rate limit), it is skipped for 5 minutes.
2. Both are converted into the same object: `{ icao24, callsign, country, lat, lon, altitude, speed, heading, vertRate, onGround, type, reg }`, in metric units. adsb.lol uses feet and knots, so `parseAdsbLol()` converts; it also gives no country, so `countryOf()` derives it from the aircraft's ICAO24 address block.
3. The two lists are merged by `icao24`. adsb.lol adds aircraft type and registration, and OpenSky's country wins when both have one. Aircraft without a position are dropped. The result is kept in memory as `latest`, along with `source` (which providers answered).
4. One summary row is added to `history`: `{ t, air, ground, avgAlt }`. The last 2,880 rows (24 h) are saved to `history.json`.

### B. When someone requests `/api/flights` (server)
1. For each flight with an airline-style callsign (3 letters + digit, e.g. `IGO6876`) the server calls `routeFor(callsign)`.
2. If the route is **cached**, it is attached. If not, the callsign goes into a **queue**.
3. A background worker takes one callsign every ~300 ms, asks adsbdb, and stores the answer in `routes.json`. A found route is kept 24 h and a failed lookup 6 h, so we don't keep asking.
4. The response is `{ fetchedAt, count, flights: [...], routesPending }`. Each flight has `route: { from, to }` or `null`.

Routes arrive gradually. After a fresh start, expect a few minutes before most flights have one.

### C. In the browser (every page)
1. `shared.js` loads first. It draws the **navbar** and provides helpers: unit conversion, airline names, distance, route and airport logic.
2. The page script fetches `/api/flights` on a timer and redraws.
3. Airports load once from `/airports.json`.

| Page | Refresh | What it does with the data |
|---|---|---|
| Live Map | 15 s | Moves plane markers, keeps a trail per plane, draws route on click |
| Flights | 20 s | Table with search, filters and sorting |
| Airports | 20 s | Counts aircraft near each airport |
| Analytics | 30 s | Computes statistics and draws charts |

---

## 4. File guide

```
FlightxTrack/
├── server.js            Backend: polling, caching, routes, API, static files
├── package.json         Project info (no dependencies)
├── history.json         (generated) traffic counts over time
├── routes.json          (generated) cache of callsign → route
├── server.log / .err    (generated) server output
└── public/              Everything the browser downloads
    ├── index.html       Live Map page
    ├── app.js           Live Map logic (Leaflet)
    ├── flights.html     Flights table page (script is inside)
    ├── airports.html    Airports page (script is inside)
    ├── analytics.html   Analytics page (Chart.js, script is inside)
    ├── about.html       About page
    ├── shared.js        Navbar + helpers used by every page
    ├── style.css        All styling (dark theme, responsive)
    └── airports.json    116 Indian airports (from OurAirports)
```

### `server.js` – the main parts
| Part | Purpose |
|---|---|
| `BOX`, `OPENSKY` | The latitude/longitude rectangle sent to OpenSky |
| `parseState()` | Converts OpenSky's array format to a named object |
| `poll()` + `setInterval` | Fetch, store `latest`, append `history` |
| `routeFor()`, `work()` | Route cache + polite background queue |
| HTTP handler | `/api/flights`, `/api/history`, otherwise serve files from `public/` |

### `public/shared.js` – helpers
| Helper | Purpose |
|---|---|
| `ftFromM`, `knFromMs`, `kmhFromMs` | Metres → feet, m/s → knots / km/h (OpenSky uses metric) |
| `AIRLINES`, `airlineOf(f)` | Callsign prefix (`IGO`) → airline name (IndiGo) |
| `phase(f)` | Climbing / Descending / Cruising / On ground from vertical rate |
| `distKm`, `nearestAirport` | Distance (haversine formula) and closest airport |
| `terminalActivity` | Is it arriving/departing an airport? (see §6) |
| `routeCodes`, `routeProgress` | `"DEL → BOM"` and % of the way along the route |

---

## 5. API reference

### `GET /api/flights`
```json
{
  "fetchedAt": 1794773767761,
  "count": 258,
  "routesPending": 120,
  "flights": [{
    "icao24": "801665", "callsign": "AIC105", "country": "India",
    "lat": 23.56, "lon": 71.07,
    "altitude": 10363.2,   // metres
    "speed": 221.63,       // m/s
    "heading": 241.89,     // degrees from north
    "vertRate": 0,         // m/s (+ climbing, − descending)
    "onGround": false,
    "route": { "from": { "iata": "DEL", "city": "New Delhi", "lat": 28.56, "lon": 77.10 },
               "to":   { "iata": "EWR", "city": "Newark", "lat": 40.69, "lon": -74.17 } }  // or null
  }]
}
```
Returns HTTP 502 `{ "error": "..." }` until the first poll succeeds.

### `GET /api/history`
`[{ "t": <ms timestamp>, "air": 253, "ground": 5, "avgAlt": 10127 }, ...]`

---

## 6. How the "smart" features work

**Flight phase.** Vertical rate above +1.5 m/s is Climbing, below −1.5 m/s is Descending, otherwise Cruising/level. On-ground flights are separate.

**Nearest airport.** Haversine distance to each of the 116 airports; the smallest wins.

**Arriving / departing.** A flight counts as terminal activity if it is airborne, **below ~3,000 m (≈10,000 ft)**, and **within 40 km** of an airport. Then:
1. If its route's destination is that airport → *arriving*.
2. If its route's origin is that airport → *departing*.
3. Otherwise it falls back to vertical rate: descending → arriving, climbing → departing, level → near.

**Route progress.** `distance from origin ÷ (distance from origin + distance to destination)`. It is an approximation and ignores the real flight path.

**Trails.** The browser remembers the last 60 positions of each plane since the page loaded. They are not stored on the server.

**Airline names.** The first 3 letters of a callsign are the ICAO airline code. Unknown codes show as unidentified, and more can be added to `AIRLINES` in `shared.js`.

---

## 7. Design decisions (the "why")

| Decision | Reason |
|---|---|
| No npm packages, no framework | Easy to understand, runs anywhere with Node, nothing to maintain |
| Multi-page (not single-page app) | Simple to explain: one file per page, shared navbar |
| Server polls on its own timer | Predictable API usage and history keeps growing without visitors |
| Cache routes on disk | Routes rarely change, so we ask once per callsign |
| JSON files instead of a database | Enough for one server and one day of data; easy to inspect |
| CDN for Leaflet and Chart.js | No build step |

---

## 8. Limitations (be upfront about these)

- **Coverage:** OpenSky relies on volunteer receivers. Low-altitude, remote and some military flights may be missing.
- **Rate limits:** anonymous OpenSky access is limited. On failure the server keeps serving the last good data and retries.
- **Routes are schedule-based:** looked up by callsign, so diversions and swapped flights can be wrong. Many flights have none.
- **History is short:** 24 hours, and a restart keeps what was saved in `history.json`.
- **Single server:** all state is in memory and local files, so it does not scale to multiple instances as-is.
- **Not for navigation or safety use.**

---

## 9. Ideas for the future

1. Save history in SQLite and add daily or weekly analytics.
2. Per-flight detail page (aircraft type, photo, full path replay).
3. Airport pages with live arrivals and departures boards.
4. Alerts: notify when a chosen flight takes off or lands.
5. OpenSky account (higher limits) or additional feeders for better coverage.
6. Deploy to Render, Railway or Fly.io (one Node process).

---

## 10. Explaining it in 2 minutes

> "Planes broadcast their position over ADS-B. Volunteers collect those signals and share them through the OpenSky Network. My Node server asks OpenSky every 30 seconds for everything inside a box around India, cleans it up, and adds origin and destination from a free route database. It also saves simple traffic counts over time. The website is plain HTML and JavaScript: the map page redraws the planes every 15 seconds, the flights page is a searchable table, the airports page shows what's landing or taking off near each airport, and the analytics page turns the same data into charts. The server sits in the middle so we respect rate limits, combine several data sources, and keep history."

### Likely questions
- **Where does the data come from?** Aircraft ADS-B broadcasts, collected by volunteer receivers (OpenSky).
- **Is it really live?** Near-live: about 15–45 seconds behind.
- **Why do some planes have no route?** The route database works by callsign and doesn't know every flight, such as cargo, private and military.
- **Why not call OpenSky directly from the browser?** Rate limits, no history, and no way to join other data sources.
- **How does it know a plane is landing?** It is low, close to an airport, and either its route says so or it is descending.
- **How would you scale it?** Move history and routes to a database, add a cache layer, run multiple instances.
