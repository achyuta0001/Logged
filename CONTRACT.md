# Flood prototype — module contract (pincode 560098, RR Nagar, Bengaluru)

Shared types: `src/types.ts` (source of truth). Stack: Vite + vanilla TS + maplibre-gl v5. No React.

## File ownership (each agent edits ONLY its own files)
| Owner | Files |
|---|---|
| data   | `scripts/**`, `public/data/**` |
| sim    | `src/sim/**`, `src/weather.ts`, `src/impact.ts`, `src/terrain.ts` |
| ui     | `index.html`, `src/main.ts`, `src/map/**`, `src/ui/**`, `src/style.css` |
| research | `public/data/hotspots.json` |
| water-fx | `src/map/waterFx.ts`, `src/map/rainFx.ts`, `src/map/fxDemo.ts`, `fx-demo.html` |
| story  | `src/ui/story.ts`, `src/ui/tour.ts`, `src/ui/story.css`, `src/ui/storyDemo.ts`, `story-demo.html` |

## Data artefacts (written by `node scripts/build-data.mjs`)
- `public/data/meta.json` — `TerrainMeta`
- `public/data/grids.bin` — concatenated little-endian layers, offsets/lengths (in elements) in `meta.layers`; offsets in BYTES are `offset` field (byte offset, 4-byte aligned)
- `public/data/osm.geojson` — FeatureCollection, properties `OsmProps`
- `public/data/depressions.json` — `Depression[]` sorted by volume desc
- `public/data/hotspots.json` — `Hotspot[]`

## Module APIs (sim agent)
```ts
// src/terrain.ts
export async function loadTerrain(base = '/data'): Promise<Terrain>
export function cellToLngLat(meta, cell): [number, number]
export function lngLatToCell(meta, lng, lat): number   // -1 if outside

// src/weather.ts
export async function fetchForecast(lat, lon): Promise<RainSeries>   // Open-Meteo, past 2 days + 7 day hourly
export const SCENARIOS: { id: string; label: string; description: string; build(): RainSeries }[]

// src/sim/index.ts  (runs in a Web Worker internally)
export class FloodEngine {
  static async create(terrain: Terrain, params?: Partial<SimParams>): Promise<FloodEngine>
  setParams(p: Partial<SimParams>): void
  /** run whole series, emitting one snapshot per hour; cached so scrubbing is instant */
  run(series: RainSeries, onProgress?: (hour: number, total: number) => void): Promise<void>
  snapshot(hourIndex: number): SimSnapshot | undefined
  get hours(): number
}

// src/impact.ts
export function computeImpact(terrain: Terrain, osm: GeoJSON.FeatureCollection, snap: SimSnapshot): ImpactReport
```
Depth colour ramp (UI): 0.02–0.1 m pale cyan, 0.1–0.3 cyan, 0.3–0.6 blue, 0.6–1.0 deep blue, >1 m violet.
Thresholds: two-wheeler impassable > 0.15 m, car > 0.30 m, bus > 0.50 m, ground floor wet > 0.25 m (plinth), severe > 0.6 m.

## Licensing rule (hard)
Open source project. Every source must be free, keyless, openly licensed, attributed:
- Map data: © OpenStreetMap contributors (ODbL) via Overpass/Nominatim (cached, polite rate)
- Basemap: OpenFreeMap (no key) / CARTO dark raster; satellite: EOX Sentinel-2 cloudless (CC BY 4.0)
- Terrain: AWS Terrain Tiles (Mapzen/Tilezen, SRTM etc.), Copernicus GLO-30
- Weather: Open-Meteo (CC BY 4.0, no key)
- npm deps: MIT/BSD/ISC/Apache only. No Esri/Mapbox/Google/login-gated data.

## Round 2 ownership (declutter + "Your place" + model fidelity)
| Owner | Files |
|---|---|
| layout | `index.html`, `src/style.css`, `src/main.ts`, `src/ui/**` except `src/ui/place.*`, `src/map/features.ts`, `src/map/analysisLayers.ts`, `src/map/mapView.ts`, `src/map/colors.ts` |
| place  | `src/place/**`, `src/ui/place.ts`, `src/ui/place.css`, `src/map/routeLayer.ts`, `place-demo.html` |
| model  | `scripts/**`, `public/data/**` (except `hotspots.json`), `src/sim/**` |
| integrator | `package.json`, `README.md`, `CONTRACT.md`, wiring `mountPlace` into `main.ts` after layout is done |

Integration hooks: layout provides an empty `<div id="place-mount">` inside a collapsible "Your place" sidebar section (hidden while empty).
Place exports `mountPlace(container, opts) -> { setHour(h), refresh(), destroy() }` (see place agent brief).
Public APIs stay stable: `createMap`, `loadDataset`/`OsmFC` (src/ui/api.ts), `FloodEngine`, `computeImpact`, `loadTerrain`.

## Multi-region (Bengaluru Urban)

### Packs
A pack is one pincode's data, in one folder:

| File | Content |
|---|---|
| `meta.json` | `TerrainMeta` (`format` absent = 1, or 2) |
| `grids.bin` | grid layers, see below |
| `osm.geojson` | `OsmProps` features (format 2: stored only as `osm.geojson.gz`) |
| `depressions.json` | `Depression[]` (format 2: stored only as `depressions.json.gz`) |
| `hotspots.json` | optional, `Hotspot[]` with source URLs |
| `pack.json` | written by the build: `{ code, format, cellSizeM, bytes, gzipBytes, built, files, sources }` |

Locations: the 560098 reference pack stays in `public/data/` (format 1, `pack.path: "."`). Every other pack is in `<packs root>/<code>/`. The packs root defaults to `public/data/pins`, and `?packs=<url>` or `VITE_PACKS_URL` can point it at a hosted copy.

`public/data/pins/index.json` is a `PinIndex` (`src/types.ts`) listing every pincode in the district, with `pack` set when a pack exists. `public/data/city/city.geojson` holds the district outline (`kind: "district"`) and simplified pincode polygons (`kind: "pin"`, with `code`, `name` and `s` = susceptibility).

### Format 2 (`src/pack/codec.ts`)
Grid layers are quantised and decoded on load into the same typed arrays as format 1, so the sim, impact and UI are unchanged.

| Layer | Stored as |
|---|---|
| `elevation` | u16, `base + q*scale` (≈1–3 mm steps), row-delta, byte-shuffled |
| `depressionDepth` | u16 mm, byte-shuffled |
| `filled` | `derived: true`, not stored (elevation + depressionDepth) |
| `flowAccum` | u16, `2^(q/2048)` |
| `hand` | u16, `base + q*scale`, row-delta, byte-shuffled |
| `impervious` | u8, `q/250` |
| `flowDir`, `drainMask`, `lakeMask`, `boundaryMask` | u8 as-is |

`osm.geojson` (format 2) rounds coordinates to 1e-5° (≈1 m) and leaves out `cell` and `cells`. `src/pack/osm.ts` rebuilds them on load with the same sampling the build uses.

Format-2 packs store `osm.geojson` and `depressions.json` gzipped (level 9) as `<name>.gz`, with no plain copy (`scripts/lib/pack-files.mjs`), because GitHub Pages serves files as they are and the site must stay under 1 GB. `src/pack/fetch.ts` asks for the `.gz` first, inflates it with the browser's `DecompressionStream` (or reads it as JSON when the host already inflated it), and falls back to the plain file: the 560098 reference pack, packs built before this layout and the dev server keep working. `pack.json` `files` lists the stored names; `bytes` and `gzipBytes` stay the uncompressed and gzipped totals.

### Region modules
| Module | Role |
|---|---|
| `src/region/packs.ts` | `packsRoot`, `loadPinIndex` (falls back to the reference pack), `packBase`, `validatePinIndex`, `validateMeta`, `searchPins` |
| `src/region/city.ts` | `loadCity`, `openCity(shell, city)`: the overview region |
| `src/main.ts` | the shell (sidebar, timeline, layout and loader, created once) plus `openPin(shell, entry, base)`. Each region returns `{ destroy, reframe, ... }`, and `destroy()` removes the map, the worker, the panels and the listeners it added. |
