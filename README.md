# Logged — flood-risk explorer for Bengaluru 560098

An open-source, in-browser 3D map that finds the depressions and low-lying ground of **Rajarajeshwari Nagar (pincode 560098)**, runs a rainfall-driven flood simulation from live weather forecasts, and translates water depth into daily-life impact: which roads stall two-wheelers, which schools and hospitals get cut off, which homes take water on the ground floor.

Inspired by the Claude wildfire analysis prototype. Everything here runs on free, keyless, openly licensed data.

> **Prototype, not a warning system.** Depths are modelled from a ~30 m elevation model and simplified drainage. Use it to understand *where* water collects and *why*, not to make safety decisions. Follow BBMP / KSNDMC advisories.

## What it does

- **Terrain analysis**: priority-flood depression filling, D8 flow accumulation, height-above-nearest-drainage (HAND), and 103 detected basins with volume and catchment.
- **Live weather**: hourly Open-Meteo forecast for the past 2 days plus the next 7. Shows a best estimate and a worst case (the hourly max across 4 models).
- **Scenarios**: a typical monsoon evening, the **20 Oct 2024 RR Nagar storm (177.6 mm)**, a hypothetical cloudburst, and a multi-day soak.
- **Flood simulation**: a 2D diffusive-wave model in a Web Worker. It accounts for infiltration, storm-drain capacity and blockage, and lake storage, and is mass-conserving (tested). A 9-day forecast runs in about 2 s.
- **Impact**: road passability for two-wheelers (>0.15 m), cars (>0.30 m) and buses (>0.50 m); wet ground floors (>0.25 m); affected schools, hospitals, metro stations, bus stops and substations; plus daily-life cards.
- **Model vs reported**: 12 historically reported flood spots (each with a news source) compared against modelled depth.
- **Visuals**: 3D terrain, animated shaded water, rain overlay, extruded buildings coloured by flood depth, and a guided cinematic tour.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # simulation tests (node:test)
npm run data       # rebuild public/data from source (optional; results are committed)
```

Requires Node 24+ (tests use native TypeScript type stripping).

## How it works

```
scripts/build-data.mjs   DEM + OSM  →  public/data/{meta.json, grids.bin, osm.geojson, depressions.json}
src/terrain.ts           load grids
src/weather.ts           Open-Meteo forecast + scenarios
src/sim/                 flood engine (worker)  →  hourly depth snapshots
src/impact.ts            depth + OSM  →  ImpactReport
src/map/, src/ui/        MapLibre 3D map, panels, timeline, tour
```

`CONTRACT.md` and `src/types.ts` define the interfaces between modules.

### Model defaults

| Parameter | Default | Basis |
|---|---|---|
| Drain capacity | 50 mm/hr | Older Bengaluru drains are designed for ~75 mm/hr ([DH, 2019](https://www.deccanherald.com/specials/point-blank/monsoon-flood-fury-not-yet-battle-ready-734464.html)); RR Nagar has ~20 bottlenecks ([TNM, 2022](https://www.thenewsminute.com/article/bengaluru-residents-upset-choked-stormwater-drains-lead-flooding-164116)) |
| Drain blockage | 40% | silt and encroachment (adjustable) |
| Infiltration | 10 mm/hr | on pervious ground, with soil storage saturation |

## Limitations

- The elevation model is Copernicus GLO-30, a ~30 m **surface** model that includes some building and tree height. Small dips, underpasses and plinth levels are not resolved, and some pits are artefacts.
- The drain network comes from OSM and is incomplete. Real drain capacity varies block by block.
- There is no live sensor feed for flood depth. Validation relies on news reports of past events.

## Data sources & licences

| Data | Source | Licence |
|---|---|---|
| Elevation | [Copernicus DEM GLO-30](https://registry.opendata.aws/copernicus-dem/) (AWS open data) | © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA; free licence |
| Elevation (fallback, map terrain) | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen/Tilezen) | SRTM and others, see their attribution |
| Roads, buildings, drains, facilities, boundary | [OpenStreetMap](https://www.openstreetmap.org/copyright) via Overpass | © OpenStreetMap contributors, **ODbL 1.0** |
| Weather | [Open-Meteo](https://open-meteo.com/) | CC BY 4.0 |
| Basemap | [OpenFreeMap](https://openfreemap.org/) | OSM data, ODbL; OpenMapTiles schema |
| Flood reports | Deccan Herald, The News Minute, Citizen Matters, Gulf News (links in `public/data/hotspots.json`) | cited, facts only |

**Code**: MIT, see [LICENSE](LICENSE). **Derived data** in `public/data/` remains under the source licences above. OSM-derived files are ODbL.
