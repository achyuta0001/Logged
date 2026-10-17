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
