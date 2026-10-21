// Short plain-language lines from the plan (src/commute/plan.ts) for the Commute tab: the update
// banner when a re-check changes the advice for the same trip. Pure, no DOM (node tests run it).
import type { CommutePlan } from '../../commute/types.ts';
import { BUCKET_MS } from '../../commute/config.ts';
import { fmtHHMM } from '../../commute/verdict.ts';

/** a likely-or-worse window (first and last half-hour bucket, ms) as "09:00–10:00" IST */
export const windowText = (w: [number, number]): string => `${fmtHHMM(w[0])}–${fmtHHMM(w[1] + BUCKET_MS)}`;

/**
 * The banner after a re-check changed the advice for the same trip, e.g.
 * "Update: now Leave by 08:15 — Silk Board Junction likely waterlogged 09:00–10:00".
 * The detail names the first hotspot behind the advice, when it has a window.
 */
export function updateLine(
  headline: string,
  plan: Pick<CommutePlan, 'drivers'>,
  nameOf: (id: string) => string,
  windowOf: (id: string) => [number, number] | null | undefined,
): string {
  const id = plan.drivers[0];
  const w = id ? windowOf(id) : null;
  return `Update: now ${headline}${id && w ? ` — ${nameOf(id)} likely waterlogged ${windowText(w)}` : ''}`;
}
