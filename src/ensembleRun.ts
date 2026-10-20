// Runs the flood prediction on each weather model's own rain, one model after another, in a second
// worker that exists only while it works (the main prediction keeps its own engine and is never
// touched). A newer run or cancel() terminates that worker, so a stale comparison stops using the
// CPU at once. Results are cached per rain + drainage settings, so switching between the best
// estimate and the worst case, or back, does not predict the same model twice.
import type { ImpactReport, RainSeries, SimParams, Terrain } from './types';
import { FloodEngine } from './sim/index';
import { computeImpact } from './impact';
import type { ForecastMember } from './weather';
import { outlookPeak, type MemberResult } from './ensemble';

export interface EnsembleJob {
  members: ForecastMember[];
  params: SimParams;
  /** hours from "now" that the outlook covers (the status talks about the next 48 h) */
  hours: number;
  /** a peak below this flooded area (m²) counts as dry and gets no impact report */
  dryAreaM2: number;
  /** the main run, reused for a member with the same rain (the best estimate costs nothing extra) */
  reuse?: { mm: number[]; area: number[]; impactAt(h: number): ImpactReport | undefined };
}

type Outcome = Omit<MemberResult, 'model' | 'name'>;

export class EnsembleRunner {
  private terrain: Terrain;
  private osm: GeoJSON.FeatureCollection;
  private engine: FloodEngine | null = null;
  private gen = 0;
  private stop: (() => void) | null = null;
  private cache = new Map<string, Outcome>();

  constructor(terrain: Terrain, osm: GeoJSON.FeatureCollection) {
    this.terrain = terrain;
    this.osm = osm;
  }

  /**
   * Predict every member, in order. Resolves null when cancel() or a newer run() supersedes it, or
   * when the model fails (the caller then shows no range). `onMember` hears each result as it lands.
   */
  async run(job: EnsembleJob, onMember?: (done: number, total: number) => void): Promise<MemberResult[] | null> {
    this.cancel();
    const gen = this.gen;
    const out: MemberResult[] = [];
    for (const m of job.members) {
      const s = m.series;
      const key = JSON.stringify([job.params, job.hours, job.dryAreaM2, s.nowIndex, s.mm]);
      let o = this.cache.get(key);
      if (!o && job.reuse && same(job.reuse.mm, s.mm)) o = outcome(s, job, job.reuse.area, job.reuse.impactAt);
      if (!o) {
        const area = await this.predict(s, job.params);
        if (gen !== this.gen || !area) return null;
        await new Promise((r) => setTimeout(r, 0)); // let a frame paint before the impact pass
        if (gen !== this.gen) return null;
        const eng = this.engine!;
        o = outcome(s, job, area, (h) => {
          const snap = eng.snapshot(h);
          return snap ? computeImpact(this.terrain, this.osm, snap) : undefined;
        });
      }
      this.cache.set(key, o);
      out.push({ model: m.model, name: m.name, ...o });
      onMember?.(out.length, job.members.length);
    }
    this.release(); // the second worker and its hourly frames (tens of MB on a 9-day run) go
    return out;
  }

  /** Drop the comparison in progress; its worker is terminated. */
  cancel(): void {
    this.gen++;
    this.stop?.();
    this.stop = null;
    this.release();
  }

  dispose(): void {
    this.cancel();
    this.cache.clear();
  }

  private release() {
    this.engine?.dispose();
    this.engine = null;
  }

  /** flooded area per hour for one rain series, or null when superseded or failed */
  private async predict(series: RainSeries, params: SimParams): Promise<number[] | null> {
    const gen = this.gen;
    if (!this.engine) {
      const e = await FloodEngine.create(this.terrain, params).catch((err) => {
        console.warn('[ensemble] engine', err);
        return null;
      });
      if (!e) return null;
      if (gen !== this.gen) {
        e.dispose();
        return null;
      }
      this.engine = e;
    }
    const eng = this.engine;
    eng.setParams(params);
    const t0 = performance.now();
    const ok = await new Promise<boolean>((resolve) => {
      this.stop = () => resolve(false);
      eng.run(series).then(
        () => resolve(true),
        (err) => {
          console.warn('[ensemble]', err);
          resolve(false);
        },
      );
    });
    this.stop = null;
    if (!ok || gen !== this.gen) return null;
    console.info(`[ensemble] ${series.label}: ${series.mm.length} h in ${Math.round(performance.now() - t0)} ms`);
    const n = Math.min(eng.hours, series.mm.length);
    return Array.from({ length: n }, (_, h) => eng.hourStats[h]?.floodedAreaM2 ?? 0);
  }
}

function same(a: number[], b: number[]) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** One member's outlook: the peak in the next `hours` (the status's window) and the impact there. */
function outcome(s: RainSeries, job: EnsembleJob, area: number[], impactAt: (h: number) => ImpactReport | undefined): Outcome {
  const from = Math.max(0, Math.min(area.length - 1, s.nowIndex ?? 0));
  const peak = outlookPeak(area, from, job.hours);
  const a = area[peak] ?? 0;
  const r = a >= job.dryAreaM2 ? impactAt(peak) : undefined;
  return {
    rainMm: s.mm.slice(from, from + job.hours).reduce((x, y) => x + y, 0),
    area,
    peakHour: peak,
    floodedKm2: Math.round(a / 1e3) / 1e3,
    twoWheelerKm: r?.roads.impassableTwoWheelerKm ?? 0,
    carKm: r?.roads.impassableCarKm ?? 0,
    buildingsWet: r?.buildings.groundFloorWet ?? 0,
    severity: r?.overall ?? 'none',
  };
}
