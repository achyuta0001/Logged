// Waterlogging levels in the Commute tab: colours (shared by pills, pins and route lines), words,
// and a hotspot's RiskExplain in plain language. Never "safe": the lowest level only says that no
// waterlogging is expected from the forecast.
import type { CommuteHotspot, HotspotType, RiskExplain, RiskLevel } from '../../commute/types.ts';

export const LEVELS: RiskLevel[] = ['clear', 'watch', 'likely', 'severe'];
const RANK: Record<RiskLevel, number> = { clear: 0, watch: 1, likely: 2, severe: 3 };
export const rank = (l: RiskLevel) => RANK[l] ?? 0;
export const worstLevel = (ls: Iterable<RiskLevel>): RiskLevel => {
  let w: RiskLevel = 'clear';
  for (const l of ls) if (rank(l) > rank(w)) w = l;
  return w;
};

/** same hues as the rest of the app: teal (the commute check's "likely clear"), caution, warn, danger */
export const LEVEL_COLOR: Record<RiskLevel, string> = { clear: '#2fe0d0', watch: '#ffd60a', likely: '#ff9f0a', severe: '#ff453a' };
/** pill text */
export const LEVEL_SHORT: Record<RiskLevel, string> = { clear: 'Clear', watch: 'Watch', likely: 'Likely', severe: 'Severe' };
/** sentence form */
export const LEVEL_TEXT: Record<RiskLevel, string> = {
  clear: 'No waterlogging expected',
  watch: 'Could waterlog',
  likely: 'Likely waterlogged',
  severe: 'Severe waterlogging likely',
};

export const TYPE_LABEL: Record<HotspotType, string> = {
  underpass: 'Underpass',
  junction: 'Junction',
  service_road: 'Service road',
  flyover_ramp: 'Flyover ramp',
  road: 'Road',
  layout: 'Neighbourhood',
};

const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const pill = (l: RiskLevel, text = LEVEL_SHORT[l]) => `<span class="cm-pill" data-level="${l}">${esc(text)}</span>`;

const mm = (v: number) => (v >= 10 ? `${Math.round(v)} mm` : v >= 0.05 ? `${v.toFixed(1)} mm` : 'none');
const rainWord = (v: number) => (v > 7.6 ? 'heavy' : v >= 2.5 ? 'moderate' : v > 0.2 ? 'light' : '');

/** lowness 0..1 (terrain rank in the city) in words */
export function lownessWords(x: number): string {
  if (x >= 0.8) return 'Among the lowest ground in the city';
  if (x >= 0.6) return 'Low-lying ground';
  if (x >= 0.4) return 'Slightly low ground';
  return 'Not especially low ground';
}

/** One hotspot's inputs as short plain sentences: [label, value] pairs for a definition list. */
export function explainRows(e: RiskExplain, h: Pick<CommuteHotspot, 'reportDays' | 'years'>): [string, string][] {
  const rows: [string, string][] = [];
  const nx = rainWord(e.rainNextMmHr);
  rows.push(['Rain in the next hour', `${mm(e.rainNextMmHr)}${nx ? ` (${nx})` : ''}`]);
  rows.push(['Rain in the last 24 hours', mm(e.rainLast24hMm)]);
  rows.push(['Starts to waterlog at', `about ${Math.round(e.thresholdMmHr)} mm in an hour`]);
  rows.push(['Ground', lownessWords(e.lowness)]);
  const yrs = h.years ? (h.years[0] === h.years[1] ? ` in ${h.years[0]}` : `, ${h.years[0]}–${h.years[1]}`) : '';
  rows.push(['Reported flooded', e.reportDays ? `on ${e.reportDays} day${e.reportDays === 1 ? '' : 's'}${yrs}` : 'no sourced reports']);
  if (e.modelDepthM !== undefined && Number.isFinite(e.modelDepthM)) rows.push(['Flood model here', e.modelDepthM >= 0.02 ? `about ${Math.round(e.modelDepthM * 100)} cm of water` : 'dry']);
  return rows;
}
