// Shared contract between data pipeline, simulation, impact, and UI.
// Do not change shapes without updating CONTRACT.md.

/** public/data/meta.json */
export interface TerrainMeta {
  pincode: string; // "560098"
  name: string; // "Rajarajeshwari Nagar"
  /** [west, south, east, north] of the grid, degrees */
  bbox: [number, number, number, number];
  width: number; // columns (west -> east)
  height: number; // rows (north -> south)
  cellSizeM: number; // approx metres per cell
  /** GeoJSON Polygon/MultiPolygon geometry of the pincode boundary */
  boundary: GeoJSON.Geometry;
  /** layers inside public/data/grids.bin, all row-major, row 0 = north */
  layers: Record<GridLayerName, LayerInfo>;
  /** pack format (absent = 1); 2 = quantised grids + compact OSM, see src/pack/codec.ts */
  format?: PackFormat;
  stats: { minElev: number; maxElev: number };
  sources: string[];
  /** M4: land outside the grid that drains into it, km² (district 60 m routing, outside cells only) */
  upstreamOutsideKm2?: number;
  /** M4: the part of that land whose runoff the sim routes in (src/sim/inflow.ts) */
  inflow?: InflowPoint[];
  /** M4: edge stretches where outside land drains in; closed to outflow while inflow runs */
  inflowEdge?: InflowEdgeRun[];
}

/** [side, from, to]: side 0 north, 1 south, 2 west, 3 east; from..to inclusive, grid cells along that side */
export type InflowEdgeRun = [number, number, number];

/**
 * One flow path entering the grid from outside it, with its outside catchment summarised for the
 * lumped runoff model in src/sim/inflow.ts (written by scripts/build-data.mjs, see scripts/lib/catchment.mjs).
 */
export interface InflowPoint {
  /** grid cell (row * width + col) where the inflow enters: on the pack's flow path, a few cells inside the edge */
  cell: number;
  /** [lon, lat] where the path crosses into the grid */
  at: [number, number];
  /** contributing area outside the grid, km² */
  areaKm2: number;
  /** mean sealed share of that area, 0..1 */
  impervious: number;
  /** share of the area within ~500 m of a mapped drain, 0..1 (absent = 1) */
  drainShare?: number;
  /** share of the area whose runoff passes a mapped tank on the way, 0..1 */
  tankShare?: number;
  /** flood cushion of those tanks, m³ (filled before they pass water on) */
  tankM3?: number;
  /** share of the area per hour of travel time to the grid edge (time-area histogram, sums to 1) */
  timeArea: number[];
  /** Clark storage coefficient, hours (linear-reservoir attenuation; 0 = translation only) */
  storageH?: number;
}

/** One layer in grids.bin. v1: f32 / u8 as-is. v2: quantised, see src/pack/codec.ts. */
export interface LayerInfo {
  /** byte offset in grids.bin */
  offset: number;
  /** elements */
  length: number;
  dtype: 'f32' | 'u8' | 'u16';
  /** v2: value = base + q * scale (or 2^(q / scale) with log2) */
  scale?: number;
  base?: number;
  log2?: boolean;
  /** v2: q stored as differences along each row */
  delta?: boolean;
  /** v2: u16 bytes stored as a low-byte plane then a high-byte plane */
  shuffle?: boolean;
  /** v2: not stored; filled = elevation + depressionDepth */
  derived?: boolean;
}

export type GridLayerName =
  | 'elevation' // f32 metres
  | 'filled' // f32 metres, depression-filled DEM (priority-flood)
  | 'depressionDepth' // f32 metres, filled - elevation
  | 'flowAccum' // f32 upstream contributing cells (D8, on filled DEM)
  | 'flowDir' // u8 D8 direction 0..7 (0=E,1=SE,2=S,3=SW,4=W,5=NW,6=N,7=NE), 255 = outlet/none
  | 'hand' // f32 metres, height above nearest drainage
  | 'impervious' // f32 0..1 fraction of sealed surface
  | 'drainMask' // u8 1 = storm drain / stream / canal present
  | 'lakeMask' // u8 1 = lake / tank / pond
  | 'boundaryMask'; // u8 1 = inside pincode boundary

export interface Terrain {
  meta: TerrainMeta;
  grids: Record<GridLayerName, Float32Array | Uint8Array>;
}

/** public/data/osm.geojson features carry these properties */
export type OsmKind =
  | 'building'
  | 'road'
  | 'water'
  | 'drain'
  | 'school'
  | 'hospital'
  | 'clinic'
  | 'bus_stop'
  | 'metro'
  | 'market'
  | 'police'
  | 'fire_station'
  | 'worship'
  | 'park'
  | 'substation';

export interface OsmProps {
  id: string; // e.g. "way/123"
  kind: OsmKind;
  name?: string;
  /** roads: OSM highway value */
  highway?: string;
  /** buildings: estimated height in metres */
  height?: number;
  /** grid cell index of centroid (row * width + col) */
  cell: number;
  /** roads/drains: grid cells sampled along the line (unique, in order) */
  cells?: number[];
  /** roads: length in metres */
  lengthM?: number;
}

/** public/data/depressions.json */
export interface Depression {
  id: number;
  /** [lon, lat] */
  centroid: [number, number];
  areaM2: number;
  maxDepthM: number;
  volumeM3: number;
  /** contributing catchment area draining into it, m2 */
  catchmentM2: number;
  /** grid cell indices inside the depression */
  cells: number[];
  /** nearest OSM place / road name if known */
  label?: string;
}

/** public/data/hotspots.json — historically reported flood locations (news/BBMP) */
export interface Hotspot {
  name: string;
  /** [lon, lat] */
  coord: [number, number];
  events: { date: string; summary: string; source: string }[];
}

export interface RainSeries {
  source: 'forecast' | 'scenario';
  label: string;
  /** hourly timestamps, ms epoch */
  times: number[];
  /** mm in each hour */
  mm: number[];
  /** 0..100 per hour, forecast only */
  probability?: number[];
  /** index of "now" in the series, forecast only */
  nowIndex?: number;
}

export interface SimParams {
  /** storm drain capacity removed from drainMask cells, mm/hr equivalent over the catchment */
  drainCapacityMmHr: number; // default ~50 (major drains designed ~70-75 mm/hr per DH 2019; local network + ~20 bottlenecks in RR Nagar make effective capacity lower)
  /** infiltration on pervious ground, mm/hr */
  infiltrationMmHr: number; // default ~10
  /** fraction of drains blocked by silt/garbage 0..1 */
  drainBlockage: number; // default 0.4
}

export interface SimSnapshot {
  hourIndex: number;
  /** water depth per cell, metres */
  depth: Float32Array;
  maxDepth: Float32Array; // running max over the run
  totalVolumeM3: number;
  floodedAreaM2: number; // cells with depth > 0.1 m inside boundary
}

export type Severity = 'none' | 'low' | 'moderate' | 'high' | 'severe';

export interface ImpactReport {
  floodedAreaKm2: number;
  roads: { totalKm: number; impassableCarKm: number; impassableTwoWheelerKm: number; worst: { name: string; depthM: number }[] };
  buildings: { total: number; groundFloorWet: number; severe: number };
  facilities: { id: string; kind: OsmKind; name: string; depthM: number; severity: Severity }[];
  busStopsCut: number;
  /** human-readable daily-life consequences, ordered by importance */
  dailyLife: { icon: string; title: string; detail: string; severity: Severity }[];
  overall: Severity;
}

// ---------------------------------------------------------------- multi-region (Bengaluru Urban)

/** Pack format version. 1 = f32 grids (560098 reference pack); 2 = quantised grids (see CONTRACT.md). */
export type PackFormat = 1 | 2;

/** One pincode in public/data/pins/index.json */
export interface PinEntry {
  /** "560098" */
  code: string;
  /** locality name from OSM (`name` / `note` of the postal_code relation, else the largest place inside) */
  name: string;
  /** other locality names inside the pincode (search) */
  localities?: string[];
  /** OSM relation id of the boundary=postal_code relation */
  relation: number;
  /** [west, south, east, north] of the boundary */
  bbox: [number, number, number, number];
  /** [lon, lat] */
  centroid: [number, number];
  areaKm2: number;
  /** share of the pincode's area inside Bengaluru Urban (0..1) */
  districtShare: number;
  /** precomputed flood-susceptibility index 0..1 (see README "Susceptibility index") */
  susceptibility?: number;
  /** a data pack exists for this pincode */
  pack?: PackInfo;
}

export interface PackInfo {
  /** pack folder, relative to the packs root (e.g. "560098"); "." = the legacy pack in public/data */
  path: string;
  format: PackFormat;
  /** total bytes of the pack files (uncompressed) and gzipped */
  bytes: number;
  gzipBytes: number;
  /** ISO date of the build */
  built: string;
  sources: string[];
  /** upstream area draining in from outside the padded bbox, km² (M4) */
  upstreamOutsideKm2?: number;
  /** part of upstreamOutsideKm2 whose runoff the pack's sim routes in (meta.inflow), km² (M4) */
  inflowKm2?: number;
}

export interface PinIndex {
  version: 1;
  generated: string;
  district: { relation: number; name: string };
  /** how pincodes were selected (documented rule) */
  rule: string;
  pins: PinEntry[];
}
