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
  layers: Record<GridLayerName, { offset: number; length: number; dtype: 'f32' | 'u8' }>;
  stats: { minElev: number; maxElev: number };
  sources: string[];
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
}

export interface PinIndex {
  version: 1;
  generated: string;
  district: { relation: number; name: string };
  /** how pincodes were selected (documented rule) */
  rule: string;
  pins: PinEntry[];
}
