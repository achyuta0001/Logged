// Road classes and typical peak-hour car speeds for the city-wide router (src/route/**).
//
// scripts/route/build-graph.mjs reads this file and writes the table into the graph header; the browser
// computes edge times from the header, never from this file, so a page and the graph it loaded always
// agree (the ALT landmark bounds in the graph are only valid for the speeds they were built with).
// Change a speed, then rebuild the graph (`npm run data:roads`).

/** OSM highway=* values kept as drivable, in class order (index = class id stored per edge) */
export const ROAD_CLASSES = [
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
  'unclassified',
  'residential',
  'living_street',
  'service',
  'road',
] as const;
export type RoadClass = (typeof ROAD_CLASSES)[number];

/**
 * Typical weekday peak-hour car speed by class, km/h, signal waits excluded (they are SIGNAL_S each).
 * Bengaluru peak traffic averages ~17–20 km/h across the city (TomTom Traffic Index 2023–24: ~28–30 min
 * per 10 km in the centre); the arterials (ORR, Hosur Road, Bellary Road) crawl at 20–30 km/h and the
 * access-controlled corridors (NICE Road, the Electronic City elevated tollway, airport road) move at
 * 45–55 km/h. Residential and service lanes are slow for width, speed breakers and parked vehicles.
 */
export const PEAK_KMH: Record<RoadClass, number> = {
  motorway: 50,
  motorway_link: 30,
  trunk: 26,
  trunk_link: 20,
  primary: 21,
  primary_link: 18,
  secondary: 19,
  secondary_link: 16,
  tertiary: 17,
  tertiary_link: 15,
  unclassified: 15,
  residential: 13,
  living_street: 8,
  service: 10,
  road: 12,
};

/**
 * A tagged maxspeed is a legal limit, not a peak-hour speed: it can only lower the class speed, to
 * this share of the limit (a 30 km/h school zone -> 18 km/h; ORR's 60 km/h stays at the trunk 26).
 */
export const MAXSPEED_FACTOR = 0.6;

/** Average wait at a mapped traffic signal (highway=traffic_signals node), s. */
export const SIGNAL_S = 20;

/** Speed table as stored in the graph header (same order as ROAD_CLASSES). */
export interface SpeedTable {
  classes: string[];
  kmh: number[];
  maxspeedFactor: number;
  signalS: number;
}

export const SPEED_TABLE: SpeedTable = {
  classes: [...ROAD_CLASSES],
  kmh: ROAD_CLASSES.map((c) => PEAK_KMH[c]),
  maxspeedFactor: MAXSPEED_FACTOR,
  signalS: SIGNAL_S,
};

/** Travel speed on an edge, m/s: the class speed, lowered by a tagged maxspeed (0 = none). */
export function edgeSpeedMps(t: SpeedTable, cls: number, maxspeed: number): number {
  let kmh = t.kmh[cls] ?? t.kmh[t.kmh.length - 1];
  if (maxspeed > 0) kmh = Math.min(kmh, maxspeed * t.maxspeedFactor);
  return Math.max(3, kmh) / 3.6;
}
