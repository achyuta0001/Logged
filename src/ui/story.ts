// "Why RR Nagar floods" (sourced context) + "Model vs reported" comparison list.
import type { Depression, Hotspot } from '../types';
import { esc } from './format';
import { iconSvg } from './icons';
import { distM, fmtEventDate, fmtModelDepth, latestEvent, probeDepth } from './tour';
import './story.css';

export interface StoryOptions {
  hotspots: Hotspot[];
  onFocus(coord: [number, number]): void;
  getModelDepthAt?(lng: number, lat: number): number | undefined;
  /** optional: big terrain basins with no nearby report are listed as "No report" */
  depressions?: Depression[];
  /** optional: renders a "Take the tour" button */
  onTour?(): void;
  /** start with the "Why" card collapsed (default: open) */
  collapsed?: boolean;
  /** show the sourced "Why RR Nagar floods" card (560098 only; default true) */
  why?: boolean;
}

export interface StoryPanel {
  el: HTMLElement;
  /** re-read model depths (call after each simulation run / hour change) */
  refresh(): void;
  setModelDepthFn(fn: StoryOptions['getModelDepthAt']): void;
  destroy(): void;
}

/** depth at which a reported spot counts as "flooding" in the model (two-wheeler impassable) */
export const MATCH_DEPTH_M = 0.15;

const FACTS: { lead: string; text: string; href: string; by: string }[] = [
  {
    lead: 'Built for 75, hit by 125.',
    text: 'Older storm drains were designed for rain peaks of about 75 mm an hour. Recent storms have peaked near 125 mm an hour.',
    href: 'https://www.deccanherald.com/specials/point-blank/monsoon-flood-fury-not-yet-battle-ready-734464.html',
    by: 'Deccan Herald',
  },
  {
    lead: 'Streams paved over.',
    text: "Bengaluru has lost 376 of its 793 km of streams (Gubbi Labs, 2014). RR Nagara division had the most vulnerable storm-drain points, 39, on BBMP's 2020 list.",
    href: 'https://citizenmatters.in/bengaluru-rain-flooding-stormwater-drains-vulnerable-areas-list-46205',
    by: 'Citizen Matters',
  },
  {
    lead: 'On the Vrishabhavathi.',
    text: 'RR Nagar is a major catchment of the Vrishabhavathi. In June 2020, rain washed away a retaining wall along the river on Mysuru Road.',
    href: 'https://www.deccanherald.com/india/karnataka/bengaluru/rain-washes-away-retaining-wall-along-vrishabhavathi-853812.html',
    by: 'Deccan Herald',
  },
  {
    lead: '177.6 mm in one day.',
    text: 'On 20 October 2024, RR Nagar recorded 177.6 mm of rain, more than 140 mm of it overnight.',
    href: 'https://www.deccanherald.com/india/karnataka/bengaluru/homes-flooded-roads-choked-yet-again-after-another-rain-spell-3240856',
    by: 'Deccan Herald',
  },
  {
    lead: 'About 20 bottlenecks.',
    text: 'In May 2022 the Chief Minister said RR Nagar had about 20 storm-drain bottlenecks, along with encroachment on drains.',
    href: 'https://www.thenewsminute.com/article/bengaluru-residents-upset-choked-stormwater-drains-lead-flooding-164116',
    by: 'The News Minute',
  },
];

type Agree = 'match' | 'low' | 'norep' | 'na' | 'out';
const PILL: Record<Agree, string> = { match: 'Match', low: 'Model low', norep: 'No report', na: 'Not run', out: 'Outside model' };
const PILL_TIP: Record<Agree, string> = {
  match: `Reported flooding, and the model floods this spot to ${MATCH_DEPTH_M} m or more`,
  low: `Reported flooding, but the model keeps this spot below ${MATCH_DEPTH_M} m. The model may be missing something here`,
  norep: 'The model floods this spot, but we found no news report of flooding here',
  na: 'Run a forecast or scenario to compare',
  out: 'This spot lies outside the area the flood model covers',
};

interface Row {
  name: string;
  coord: [number, number];
  meta: string;
  sort: number;
  depth?: number;
  agree: Agree;
  href?: string;
}

export function mountStoryPanel(container: HTMLElement, opts: StoryOptions): StoryPanel {
  let depthFn = opts.getModelDepthAt;
  const el = document.createElement('section');
  el.className = 'st';
  container.appendChild(el);

  const gauge = `
    <figure class="st-gauge" aria-label="Drain design capacity about 75 millimetres per hour versus recent peaks of about 125 millimetres per hour">
      <div class="st-g-row"><span>Drains designed for</span><div class="st-g-bar"><i style="--w:${(75 / 130) * 100}%"></i></div><b>~75<small>mm/h</small></b></div>
      <div class="st-g-row hot"><span>Recent peaks</span><div class="st-g-bar"><i style="--w:${(125 / 130) * 100}%"></i></div><b>~125<small>mm/h</small></b></div>
    </figure>`;

  const why =
    opts.why === false
      ? ''
      : `
    <details class="st-why"${opts.collapsed ? '' : ' open'}>
      <summary><h2>Why RR Nagar floods</h2>${iconSvg('chevron', 15, 1.8)}</summary>
      ${gauge}
      <ol class="st-facts">${FACTS.map(
        (f) => `<li><p><b>${esc(f.lead)}</b> ${esc(f.text)}</p><a href="${f.href}" target="_blank" rel="noopener">${esc(f.by)}</a></li>`,
      ).join('')}</ol>
    </details>`;
  el.innerHTML = `${why}
    <div class="st-mvr">
      <div class="st-mvr-head"><h2>Model vs reported</h2><span class="st-score" aria-live="polite"></span></div>
      <p class="st-hint">Places where flooding was reported, compared with the deepest street water the model shows within 300 m — reports name neighbourhoods, not exact streets. Click a row to fly there.</p>
      <ul class="st-rows"></ul>
    </div>
    ${opts.onTour ? `<button class="btn primary st-tour" type="button">${iconSvg('play', 14)}<span>Take the guided tour</span></button>` : ''}`;

  const list = el.querySelector('.st-rows') as HTMLUListElement;
  const score = el.querySelector('.st-score') as HTMLElement;

  list.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-lng]');
    if (b) opts.onFocus([Number(b.dataset.lng), Number(b.dataset.lat)]);
  });
  el.querySelector('.st-tour')?.addEventListener('click', () => opts.onTour?.());

  function rows(): Row[] {
    const out: Row[] = [];
    const depths = opts.hotspots.map((h) => probeDepth(depthFn, h.coord));
    // once any spot has a model value the run exists; a missing value then means off-grid
    const ran = depths.some((d) => d !== undefined);
    opts.hotspots.forEach((h, i) => {
      const e = latestEvent(h);
      const depth = depths[i];
      const agree: Agree = !e ? 'norep' : depth === undefined ? (ran ? 'out' : 'na') : depth >= MATCH_DEPTH_M ? 'match' : 'low';
      const n = h.events.length;
      out.push({
        name: h.name,
        coord: h.coord,
        meta: e ? `Last reported ${fmtEventDate(e.date)}${n > 1 ? ` · ${n} reports` : ''}` : 'No dated report',
        sort: depth ?? -1,
        depth,
        agree,
        href: e?.source,
      });
    });
    // modelled ponding with no report nearby (only when a model run is available)
    if (opts.depressions && depthFn) {
      let added = 0;
      for (const d of opts.depressions) {
        if (added >= 4) break;
        if (opts.hotspots.some((h) => distM(h.coord, d.centroid) < 500)) continue;
        const depth = probeDepth(depthFn, d.centroid);
        if (depth === undefined || depth < MATCH_DEPTH_M) continue;
        added++;
        out.push({
          name: d.label ?? `Basin #${d.id}`,
          coord: d.centroid,
          meta: 'Low ground in the terrain model',
          sort: depth,
          depth,
          agree: 'norep',
        });
      }
    }
    // reported rows first (deepest first), then unreported model basins
    return out.sort((a, b) => Number(a.agree === 'norep') - Number(b.agree === 'norep') || b.sort - a.sort);
  }

  function refresh() {
    const rs = rows();
    list.innerHTML = rs
      .map(
        (r) => `<li><button type="button" data-lng="${r.coord[0]}" data-lat="${r.coord[1]}" class="st-row" data-agree="${r.agree}">
          <span class="st-name">${esc(r.name)}</span>
          <span class="st-meta">${esc(r.meta)}</span>
          <span class="st-depth${r.depth !== undefined && r.depth >= MATCH_DEPTH_M ? ' wet' : ''}">${r.depth === undefined ? '–' : esc(fmtModelDepth(r.depth))}</span>
          <span class="st-pill" data-agree="${r.agree}" title="${esc(PILL_TIP[r.agree])}">${PILL[r.agree]}</span>
        </button></li>`,
      )
      .join('');
    const reported = rs.filter((r) => r.agree === 'match' || r.agree === 'low');
    const m = reported.filter((r) => r.agree === 'match').length;
    score.textContent = reported.length ? `${m} of ${reported.length} match` : depthFn ? '' : 'run the model to compare';
    score.classList.toggle('idle', !reported.length);
  }

  refresh();
  return {
    el,
    refresh,
    setModelDepthFn(fn) {
      depthFn = fn;
      refresh();
    },
    destroy() {
      el.remove();
    },
  };
}
