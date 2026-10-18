# Logged — flood explorer for Bengaluru Urban

An open-source, in-browser 3D map of flood risk across **Bengaluru Urban**. It opens on a city overview: every pincode in the district, coloured by a precomputed flood-susceptibility index. Pick a pincode by number, by locality name or by clicking the map. Its data pack then loads, and you get the full experience first built for **Rajarajeshwari Nagar (560098)**:

- the depressions and low-lying ground
- a rainfall-driven flood simulation from live forecasts or historical scenarios
- what the water depth means for daily life: which roads stall two-wheelers, which schools and hospitals get cut off, and which homes take water on the ground floor

Inspired by the Claude wildfire analysis prototype. Everything here runs on free, keyless, openly licensed data.

> **Prototype, not a warning system.** Depths are modelled from a ~30 m elevation model and simplified drainage. Use it to understand *where* water collects and *why*, not to make safety decisions. Follow BBMP / KSNDMC advisories.

## City overview

- **The map:** the district outline (OSM relation `2020589`) and the **117 pincodes** that lie at least half inside it, coloured by susceptibility. A dashed outline marks a pincode whose 3D flood model has been built. Hover a pincode for its numbers, and click one to open it.
- **Search:** the "Pincodes" section of the sidebar finds a pincode by number (`560103`, `5601`) or by area name (`Bellandur`, `HSR`, `Electronic City`). Search is offline, over the pincode index, and calls no geocoder. A ranked list gives the same information as a table.
- **Links:** `?pin=<code>` opens a pincode directly, and the back button returns to the overview. Every other URL parameter below still works.
- **Fallback:** if the overview data is missing, the app opens 560098 as before.

### Susceptibility index

`npm run data:city` computes the index on a district-wide 60 m grid. The inputs are the Copernicus GLO-30 elevation model (with a 3×3 low-percentile filter so building and tree tops count less) and OSM drains, lakes, buildings, roads and landuse. The steps are priority-flood filling, D8 flow, flow accumulation and HAND. Each pincode is then ranked against the others on four measures:

| Weight | Measure |
|---|---|
| 0.35 | share of area with HAND < 2 m (ground less than 2 m above the nearest drainage line, i.e. ≥ 0.5 km² catchment, a mapped drain or a lake) |
| 0.25 | depression storage per km² (fill depth × area) |
| 0.20 | mean impervious share (buildings 95 %, roads 90 %, landuse defaults) |
| 0.20 | upstream area draining in from outside the pincode, relative to its own area |

The index is the weighted mean of the four percentile ranks, from 0 to 1. The legend bands are lower (< 0.25), moderate, high and very high (≥ 0.75). **It ranks pincodes against each other**. It is not a probability or a forecast, and it is not calibrated to flood events.

## What it does (in a pincode)

- **Terrain analysis**: priority-flood depression filling, D8 flow accumulation, height-above-nearest-drainage (HAND), and 103 detected basins with volume and catchment.
- **Live weather**: hourly Open-Meteo forecast for the past 2 days plus the next 7. Shows a best estimate and a worst case (the hourly max across 4 models).
- **Scenarios**: a typical monsoon evening, the **20 Oct 2024 RR Nagar storm (177.6 mm)**, a hypothetical cloudburst, and a multi-day soak.
- **Real storms**: four sourced Bengaluru flood days (14–16 Aug 2017, 17–18 May 2022, 4–6 Sep 2022, 20–22 Oct 2024), each run on the hourly rain that the free Open-Meteo historical archive holds for the open pincode's centroid. The archive is a reanalysis, so it shows much less rain than the gauges in the reports (see Limitations).
- **Flood simulation**: a 2D diffusive-wave model in a Web Worker. It accounts for infiltration, storm-drain capacity and blockage, and lake storage, and is mass-conserving (tested). Storm drains are a network: inlets feed the mapped drains, which carry the water downstream through tanks to the grid edge and overflow onto the street where a reach is full (`src/sim/network.ts`). A 9-day forecast runs in about 2 s.
- **Impact**: road passability for two-wheelers (>0.15 m), cars (>0.30 m) and buses (>0.50 m); wet ground floors (>0.25 m); affected schools, hospitals, metro stations, bus stops and substations; plus daily-life cards.
- **Model vs reported**: 12 historically reported flood spots (each with a news source) compared against modelled depth, plus a sourced "Why RR Nagar floods" explainer.
- **Visuals**: 3D terrain, animated shaded water, rain overlay, extruded buildings coloured by flood depth, and an 8-stop guided tour (Tour button; arrow keys, Space to pause, Esc to exit).
- **Map**: dark vector basemap or Sentinel-2 satellite, adjustable terrain height, and optional analysis layers (low spots, flow paths, land near streams, drains, lakes, reported floods). Hover or tap anywhere for depth, ground level and drainage at that spot.
- **Phones and tablets**: the side panels become drawers; the timeline stays on screen.
- **Shareable views**: `?scenario=<id>` (`typical-evening`, `rrnagar-2024-10-20`, `cloudburst`, `multi-day-soak`), `&basemap=satellite`, `&view=lng,lat,zoom[,pitch,bearing]`.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173  (city overview; ?pin=560098 for RR Nagar)
npm test           # node:test suites in src/**/__tests__ (sim, routing, packs, codec)
```

Requires Node 22.18+ or 24+. The tests and data scripts import TypeScript directly, using native type stripping.

## Data pipeline

| Command | What it does |
|---|---|
| `npm run data:osm` | Streams the OSM planet from the public AWS bucket `osm-pds` (≈95 GB, nothing stored) through `osmium extract`. The result is `.cache/osm/blr-region.osm.pbf`, about 60 MB, covering the bbox 77.15–78.05 E and 12.45–13.45 N. It takes 20–40 min, once. Needs `osmium-tool` (`apt install osmium-tool`). A Geofabrik extract works too: see `scripts/osm-extract.sh`. |
| `npm run data:city` | Builds the pincode index, the district outline, the pincode polygons and the susceptibility index (≈40 s). Writes `public/data/pins/index.json`, `public/data/city/city.geojson` and `.cache/pins/catalog.json`. |
| `npm run data -- --pin <code>` | Builds one pincode's pack into `public/data/pins/<code>/` (5–25 s; 560098 builds into `public/data/`). |
| `npm run data:all [-- --pins a,b] [--jobs 2] [--force]` | Builds every pack (or the listed ones), then refreshes the index. It is resumable: packs that already exist are skipped. It is polite to public servers: OSM comes from the local extract and Copernicus windows are cached, and failures back off exponentially. |
| `node scripts/calibrate.mjs --pin <code> --impact` | Runs the scenarios headlessly. Reports peak flooded area, recession time, buildings with water over plinth, road closed, and model depth near the pack's reported flood spots. Add `--event all` (or a comma list of ids) to also run the real storms on archive rain at the pin centroid. |

Without the local extract, `npm run data -- --pin <code>` falls back to one Overpass query per pack (cached).

Reported flood spots outside 560098 live in `scripts/data/hotspots-blr.json`. Each event there has a source URL, and each place is located from a named OSM object, never a geocoder or memory. The pack build copies the spots inside a pack's grid into that pack's `hotspots.json`.

### Pack format

`CONTRACT.md` ("Multi-region") documents the format, and `src/types.ts` (`PinIndex`, `PackInfo`, `LayerInfo`) holds the types.

- **Format 2** is used by every pack except 560098:
  - grids are quantised to u16/u8, and smooth surfaces are row-delta coded and byte-shuffled
  - `filled` is derived on load
  - `osm.geojson` coordinates are rounded to 1e-5° (≈1 m)
  - per-feature grid cells are rebuilt on load (`src/pack/osm.ts`)
- **Grid cell size:** 15 m like 560098. Large pincodes use a coarser cell, so a pack stays near 140k cells (Yelahanka 560064: 50 m).
- **Format 1:** the 560098 reference pack keeps format 1 and stays in `public/data/` (`pack.path: "."`), so old links and the calibration baseline are unchanged.

### Hosting the packs

The repository commits the pipeline, the index and the city overview, plus the 560098 pack and a few small sample packs. Every other pack is built by `npm run data:all` into `public/data/pins/<code>/`, which is git-ignored.

To publish them:
- **Release asset or any static host:** upload `public/data/pins/`. Then open the app with `?packs=https://host/path/pins`, or build it with `VITE_PACKS_URL=https://host/path/pins`. The hosted folder needs its own `index.json` (written by `data:all`).
- **GitHub Actions:** `.github/workflows/packs.yml` (manual `workflow_dispatch` only) builds everything and uploads `public/data/pins` and `public/data/city` as an artifact.

## Budgets (measured 2026-10-17)

| Budget | Target | Measured |
|---|---|---|
| City overview transfer | ≤ 5 MB | **1.8 MB** without basemap tiles: app 0.37 MB, city.geojson 0.17 MB raw (≈0.05 MB gzipped), index 0.01 MB, z10 terrain 1.2 MB. Basemap tiles were blocked in the test environment and are not counted. |
| Pincode pack | ≤ 4 MB gzipped | All 117 packs: **max 3.2 MB** (Yelahanka 560064), median 1.1 MB, total 138 MB. 560098 is 2.6 MB. |
| 9-day forecast simulation | ≤ 3 s on a laptop | Every sample pack runs 216 h faster than 560098 on the same machine. In a slow cloud container that was 2.2–3.8 s vs 4.0 s; on a laptop 560098 takes about 2 s. Big pincodes get coarser cells, so cells stay ≤ ~140k. |
| 560098 | no slower than before | Same pack (format 1), same engine. Opening it adds two small fetches: index.json and city.geojson. |

Switching regions is checked in headless Chromium, over five city ↔ 560098 round trips. JS heap, workers, canvases, markers and window/document listeners all return to the same level after each one.

## Sample results (`node scripts/report.mjs --perf`)

"Oct 2024 storm" replays the RR Nagar rainfall (177.6 mm) on every pincode. "Typical evening" is a 35 mm monsoon evening. The table reports:
- **Peak flooded:** area with more than 0.1 m of water inside the pincode.
- **Recession:** hours after the rain ends until the flooded area falls below 25 % of its peak.
- **Buildings over plinth:** buildings with more than 0.25 m of water at the peak hour.
- **Road closed:** road with more than 0.30 m of water.
- **Reports wet:** sourced flood reports inside the pack where the model has at least 0.15 m of street water within 300 m.

| Pincode | Name | Susc. | Grid | Pack (gz) | Oct 2024 storm: peak flooded | recession | buildings over plinth | road closed (car) | reports wet | Typical evening: peak | buildings | 9-day run |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 560098 | Rajarajeshwarinagar | 0.49 | 15 m, 135k | 2.64 MB | 0.63 km² | 5 h | 538 | 7.2 km | 8/12 | 0.03 km² | 8 | 4.0 s |
| 560072 | Nagarbhavi | 0.39 | 15 m, 102k | 1.40 MB | 0.15 km² | 8 h | 184 | 2.1 km | – | 0.00 km² | 4 | 3.2 s |
| 560034 | Koramangala I Block | 0.88 | 15 m, 88k | 1.16 MB | 0.19 km² | 5 h | 110 | 2.9 km | 3/3 | 0.01 km² | 2 | 2.6 s |
| 560095 | Koramangala VI Block | 0.80 | 15 m, 110k | 1.33 MB | 0.27 km² | 3 h | 336 | 3.2 km | 1/1 | 0.02 km² | 5 | 3.1 s |
| 560102 | HSR Layout | 0.63 | 20 m, 79k | 1.23 MB | 0.26 km² | 2 h | 222 | 3.7 km | 3/3 | 0.01 km² | 0 | 2.2 s |
| 560103 | Bellandur | 0.83 | 25 m, 104k | 1.69 MB | 0.44 km² | 4 h | 58 | 2.1 km | 3/3 | 0.01 km² | 0 | 3.2 s |
| 560068 | Bommanahalli (Bangalore) | 0.75 | 25 m, 103k | 2.26 MB | 0.48 km² | 4 h | 402 | 5.6 km | 2/2 | 0.00 km² | 0 | 2.8 s |
| 560037 | Rameshnagar | 0.79 | 20 m, 123k | 1.97 MB | 0.63 km² | 3 h | 543 | 5.1 km | 0/1 | 0.02 km² | 0 | 3.8 s |
| 560048 | Mahadevapura | 0.56 | 20 m, 97k | 1.50 MB | 0.35 km² | 4 h | 107 | 1.8 km | – | 0.01 km² | 0 | 3.1 s |
| 560087 | Varthur | 0.75 | 25 m, 137k | 1.67 MB | 0.68 km² | 4 h | 195 | 1.8 km | 0/1 | 0.00 km² | 0 | 3.8 s |
| 560024 | HA Farm | 0.81 | 20 m, 84k | 1.91 MB | 0.32 km² | 3 h | 96 | 2.9 km | 1/1 | 0.01 km² | 1 | 2.7 s |
| 560064 | Yelahanka Satellite Town | 0.55 | 50 m, 114k | 3.20 MB | 3.54 km² | 1 h | 275 | 9.2 km | 0/1 | 0.01 km² | 0 | 3.3 s |
| 560097 | Vidyaranyapura | 0.53 | 20 m, 121k | 1.65 MB | 0.37 km² | 2 h | 502 | 2.9 km | – | 0.00 km² | 0 | 3.5 s |
| 560100 | Wipro Limited | 0.38 | 30 m, 114k | 1.49 MB | 1.46 km² | 2 h | 90 | 4.5 km | 0/1 | 0.03 km² | 0 | 3.8 s |

What the reports show:
- **Matched:** most reports. Silk Board, HSR Layout, ST Bed Layout, Rainbow Drive, the ORR at Ecospace and the Hebbal flyover all get street water near them in the 2024 storm.
- **Missed:** the **Marathahalli Bridge**, **Kendriya Vihar** and the **Electronic City flyover**. The flyovers are probably a resolution problem: the elevation model measures the deck, not the road under it. Kendriya Vihar flooded because the lakes upstream overflowed, which needs inflow from outside the pack (see Limitations). Yelahanka's 50 m grid is also coarse.
- **Rainfall:** every pincode gets the same storm. Real rainfall varies across the city, so compare pincodes with care.

## How it works

```
scripts/build-data.mjs   DEM + OSM  →  public/data/{meta.json, grids.bin, osm.geojson, depressions.json}
src/terrain.ts           load grids
src/weather.ts           Open-Meteo forecast + scenarios
src/sim/                 flood engine (worker)  →  hourly depth snapshots
src/impact.ts            depth + OSM  →  ImpactReport
src/map/, src/ui/        MapLibre 3D map, panels, timeline, tour
src/region/              pincode index + pack loader, city overview region
src/pack/                pack format 2 codec (grids) and OSM cell rebuild
scripts/build-city.mjs   pincode index, district outline, susceptibility (data:city)
scripts/build-all.mjs    every pack, resumable (data:all)
```

`CONTRACT.md` and `src/types.ts` define the interfaces between modules.

### Model defaults

| Parameter | Default | Basis |
|---|---|---|
| Drain capacity | 50 mm/hr | Older Bengaluru drains are designed for ~75 mm/hr ([DH, 2019](https://www.deccanherald.com/specials/point-blank/monsoon-flood-fury-not-yet-battle-ready-734464.html)); RR Nagar has ~20 bottlenecks ([TNM, 2022](https://www.thenewsminute.com/article/bengaluru-residents-upset-choked-stormwater-drains-lead-flooding-164116)) |
| Drain blockage | 40% | silt and encroachment (adjustable) |
| Infiltration | 10 mm/hr | on pervious ground, with soil storage saturation |

#### Drain network (`NET_TUNING` in `src/sim/network.ts`)

Captured water enters the nearest mapped drain (OSM `waterway` lines) instead of leaving the model. It flows downstream along the drain lines and through tanks, and leaves at the grid edge. Inlets only take what their drain has room for. A reach that receives more than it can carry overflows onto the street at that cell.

| Setting | Value | Basis |
|---|---|---|
| Reach capacity | drain capacity × (1 − blockage) × area served upstream × (15 min / t<sub>c</sub>)<sup>0.5</sup> | Rational method: each reach is sized for the design intensity at its time of concentration (t<sub>c</sub> = 15 min + longest channel above it at 1 m/s), so trunk drains carry less per hectare than local ones. Short bursts pass; long heavy storms overload the trunks first. |
| Flow speed | 1 m/s | Typical full-flow velocity in open storm drains. Sets the routing delay and the channel volume. |
| Gaps and line ends | culvert at half capacity | A mapped line that stops within 3 cells of a lower drain is joined to it as a culvert: road crossings are where OSM drain lines usually break. Any other line end is assumed to continue unmapped through a culvert-sized link, and what that cannot pass overflows at the end. Lines that stop at the grid edge leave there. |
| Tanks | cushion, then pass on; 1 m rise | A tank first fills its flood cushion (the existing freeboard rule), then passes water through the drain that leaves it. While that drain is full, the tank rises up to 1 m (bund freeboard above the waste weir). After that, the drains feeding the tank back up and overflow near it. |
| Upstream inflow | sized for the whole catchment | Reaches below an upstream-inflow point (`meta.inflow`) are sized for the land outside the grid too. |

`hourStats` reports `networkM3` (water in the drains), `surchargeM3` (overflow onto streets) and `networkOutM3` (discharged at the edge or into tank cushions). `drainedM3` is now the net transfer from the surface into the drains.

## Limitations

- **Multi-region:**
  - Pincode boundaries come from OSM `boundary=postal_code` relations, sourced there from NIC PostalGIS. 22 of the 139 `56xxxx` relations in the region are less than half inside Bengaluru Urban and are left out.
  - Some areas inside the district have no pincode relation in OSM; they show as dark gaps on the overview.
- **Catchments cross pincode edges:** each pack simulates only its padded bbox. `data:city` records how much upstream area drains in from outside each pack (`upstreamOutsideKm2`), and the app shows a quiet caveat when that is large. That inflow is not simulated, so valley-floor depths there are likely too low.
- **Scenarios:** the "20 Oct 2024" scenario replays the rainfall recorded at RR Nagar for every pincode; other parts of the city had different totals that day.
- **Real storms use reanalysis rain:** the Open-Meteo archive is a gridded model re-run (ERA5 / ECMWF IFS, cells of roughly 9–25 km), not a rain gauge. It smears a convective cloudburst over the whole cell, so it holds 2.5–7 times less rain than the reported gauge totals, and wettest hours of 4–12 mm instead of the 30–60 mm an hour the reports describe. Koramangala, HSR Layout and Bellandur even fall in the same cell. On that rain the model floods nothing in any committed pack (`calibrate.mjs --event all`), although all four days flooded streets. Read them as "the real timing, far too little rain", not as a replay.
- **Drains:**
  - The drain network is a storage-routing approximation. It has no water levels, so backwater only reaches one tank or one reach upstream, and overflow appears at the node just above a full reach rather than spreading along the bank.
  - Drain sizes are estimated from the area each reach serves (the rational method), not surveyed. OSM tags almost every Bengaluru drain `waterway=drain`, so the tags cannot tell a trunk from a side drain.
  - Culverts are inferred only where a mapped line breaks. The elevation grid has no roads, so a culvert under a road is not detected when the drain line runs unbroken across it.
  - Encroachment and construction debris are not mapped. They act only through the blockage setting.
  - The flyover misses (Marathahalli Bridge, Electronic City) are elevation-model problems, so the drain network cannot fix them.
  - Post-storm pond drainage and inlets more than 500 m from a mapped drain still remove water from the model, as before.
- The elevation model is Copernicus GLO-30, a ~30 m **surface** model that includes some building and tree height. Small dips, underpasses and plinth levels are not resolved, and some pits are artefacts.
- The drain network comes from OSM and is incomplete. Real drain capacity varies block by block.
- There is no live sensor feed for flood depth. Validation relies on news reports of past events.

## Data sources & licences

| Data | Source | Licence |
|---|---|---|
| Elevation | [Copernicus DEM GLO-30](https://registry.opendata.aws/copernicus-dem/) (AWS open data) | © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA; free licence |
| Elevation (fallback, map terrain) | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen/Tilezen) | SRTM and others, see their attribution |
| Roads, buildings, drains, facilities, boundaries | [OpenStreetMap](https://www.openstreetmap.org/copyright): planet from AWS Open Data [`osm-pds`](https://registry.opendata.aws/osm/) via osmium (or Overpass) | © OpenStreetMap contributors, **ODbL 1.0** |
| Pincode boundaries | OSM `boundary=postal_code` relations (tagged as sourced from NIC PostalGIS) | © OpenStreetMap contributors, ODbL 1.0 |
| Weather | [Open-Meteo](https://open-meteo.com/) | CC BY 4.0 |
| Past rain (real storms) | [Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api) (reanalysis); event dates and gauge totals from the news reports linked in `src/weather.ts` | CC BY 4.0; reports cited, facts only |
| Basemap | [OpenFreeMap](https://openfreemap.org/) | OSM data, ODbL; OpenMapTiles schema |
| Flood reports | Deccan Herald, The News Minute, Citizen Matters, Gulf News, OneIndia, South First (links in `public/data/hotspots.json` and `scripts/data/hotspots-blr.json`) | cited, facts only |

**Code**: MIT, see [LICENSE](LICENSE). **Derived data** in `public/data/` remains under the source licences above. OSM-derived files are ODbL.
