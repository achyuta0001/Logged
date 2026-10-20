// Every weight, threshold and time constant of the commute tool, in one place: the risk engine
// (src/commute/risk.ts), the hotspot rain fetch (src/commute/forecast.ts) and the planner
// (src/commute/plan.ts). Change numbers here, not in the modules. scripts/commute/backtest.mjs
// replays past flood days with these same values and writes backtest/REPORT.md.
//
// The model, in one paragraph: a hotspot's score in a 30-minute bucket is the forecast rain there
// divided by the rain at which that kind of place starts to waterlog, plus a share of the last hour's
// rain (water still standing). That rain ratio is then raised by up to half again for each of three
// things that make a place flood sooner: a wet day before (antecedent rain), low ground, and a record
// of news reports. A flood-model depth at the spot, when a pincode model has run, adds its own term
// and sets a floor. The score maps to clear / watch / likely / severe. "Clear" is only the lowest
// level: it never means the road is safe.
import type { HotspotType, RiskLevel } from './types.ts';

// ------------------------------------------------------------------ time

/** risk is worked out per bucket of this many minutes */
export const BUCKET_MIN = 30;
export const BUCKET_MS = BUCKET_MIN * 60_000;
/** the default outlook runs from now to this many hours ahead; any later horizon up to the end of the forecast can be asked for */
export const HORIZON_H = 3;

// ------------------------------------------------------------------ thresholds

/**
 * Rain (mm/h, as the forecast model gives it) at which a hotspot of each type typically starts to
 * waterlog, before the adjustments below. Forecast and reanalysis rain is a mean over a model cell of
 * ~9 km (Open-Meteo best match for Bengaluru is ECMWF IFS, checked 2026-10-20): the 30-60 mm/h that a
 * gauge records in a flood-day cloudburst shows up there as 4-12 mm/h (PROGRESS.md, "Real storms").
 * So these sit far below the street-level intensities in the news. Order, from the reports: an
 * underpass floods first (a sump under a road or railway, its pump often fails), then junctions,
 * service roads and flyover ramps (low points where several drains meet), then plain roads, then
 * layouts (homes flood later than the streets around them).
 */
export const TYPE_THRESHOLD_MMHR: Record<HotspotType, number> = {
  underpass: 5,
  junction: 7,
  service_road: 7,
  flyover_ramp: 7,
  road: 8,
  layout: 10,
};

/**
 * Multiplies every threshold (type default or per hotspot). 1.4 was chosen on the backtest's training
 * days only (half of the 63 report days and their control days; best critical success index among
 * 0.25-2), so an underpass is flagged from 7 mm/h of model rain and a road from 11.2 mm/h before the
 * other terms. backtest/REPORT.md gives the scores on the held-out days.
 */
export const THRESHOLD_SCALE = 1.4;

// ------------------------------------------------------------------ score

export const SCORE = {
  /** share of the last hour's rain (mm) still counted as standing water, as mm/h: street water drains in 1-2 h */
  persist: 0.5,
  /** 24 h rain (mm) at which drains, soil and tanks count as full */
  antecedentSatMm: 50,
  /** the rain terms grow by up to this share when the last 24 h were that wet */
  antecedentW: 0.5,
  /** ... and by up to this share for lowness 1 (the lowest ground) */
  lownessW: 0.5,
  /** ... and by up to this share for a place reported flooded on `historySatDays` or more days (log scale) */
  historyW: 0.5,
  historySatDays: 6,
  /** flood-model water at the spot (m) that adds `depthW` to the score; less adds proportionally less */
  depthSatM: 0.3,
  depthW: 2,
  /** below this effective rain (mm/h: rain now + persist x last hour) a bucket is clear, unless the flood model has water there */
  minRainMmHr: 0.5,
};

/** score at which each level starts; anything lower is clear */
export const LEVEL_FROM: Record<Exclude<RiskLevel, 'clear'>, number> = { watch: 0.35, likely: 1, severe: 2 };

/**
 * Flood-model water at the spot that sets a minimum level whatever the rain: 5 cm wet, 15 cm stalls
 * two-wheelers, 30 cm stops cars (CONTRACT.md thresholds).
 */
export const DEPTH_FLOOR_M: Record<Exclude<RiskLevel, 'clear'>, number> = { watch: 0.05, likely: 0.15, severe: 0.3 };

// ------------------------------------------------------------------ forecast fetch

export const FORECAST = {
  url: 'https://api.open-meteo.com/v1/forecast',
  /** hotspots within one cell of this size (km) share one forecast point */
  clusterKm: 2,
  /** locations per request (Open-Meteo takes comma-separated latitude / longitude lists) */
  maxLocations: 100,
  /** past day for the antecedent and last-hour rain, then the forecast days */
  pastDays: 1,
  forecastDays: 3,
  /** one fetch per browser session per this long */
  cacheTtlMs: 30 * 60_000,
  /**
   * Ask for 15-minute precipitation as well as hourly. For Bengaluru Open-Meteo fills it by
   * interpolating the hourly model (15-minute models cover only Central Europe and North America),
   * so it sharpens the timing a little and adds no new information. Hourly is used when it is missing.
   */
  minutely15: true,
};

// ------------------------------------------------------------------ planner

export const PLAN = {
  /** a hotspot within this many metres of a route line is on the route */
  bufferM: 150,
  /** "leave by" is this much before the last departure that misses the water; "leave after" this much after the first */
  marginMin: 15,
  /** departure times are tried at this step */
  stepMin: 5,
  /** earlier / later departures are searched this far either side; if every route is likely or worse throughout, the advice is to work from home */
  rangeH: 2,
};
