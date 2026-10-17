import type { Depression, ImpactReport } from '../types';
import { SEVERITY_COLOR, SEVERITY_LABEL } from '../map/colors';
import { FACILITY_LABEL } from '../map/features';
import { esc, fmtArea, fmtDay, fmtDepth, fmtHour, fmtNum } from './format';
import { iconSvg } from './icons';

export interface RightHandlers {
  onDepression(d: Depression): void;
  onRoad(name: string): void;
}

export class RightPanel {
  private el: HTMLElement;
  private h: RightHandlers;
  private deps: Depression[];

  constructor(el: HTMLElement, deps: Depression[], h: RightHandlers) {
    this.el = el;
    this.h = h;
    this.deps = deps.slice(0, 6);
    el.innerHTML = `
      <header class="imp-head">
        <div>
          <h2 class="imp-title">Impact at <span id="imp-time">–</span></h2>
          <div class="imp-day" id="imp-day"></div>
        </div>
        <div class="sev" id="imp-sev">–</div>
      </header>
      <div class="kpis">
        <div class="kpi water"><span class="kpi-v" id="k-area">–</span><span class="kpi-l">Under more than 10 cm of water</span></div>
        <div class="kpi"><span class="kpi-v" id="k-2w">–</span><span class="kpi-l">Road closed to two-wheelers</span></div>
        <div class="kpi"><span class="kpi-v" id="k-car">–</span><span class="kpi-l">Road closed to cars</span></div>
        <div class="kpi"><span class="kpi-v" id="k-bld">–</span><span class="kpi-l">Buildings with water over the plinth</span></div>
        <div class="kpi wide"><span class="kpi-v" id="k-fac">–</span><span class="kpi-l" id="k-fac-l">Facilities cut off</span></div>
      </div>
      <section class="sec">
        <h3>What it means for daily life</h3>
        <div class="life" id="life"></div>
      </section>
      <section class="sec">
        <h3>Lowest spots</h3>
        <ol class="rank" id="deps"></ol>
      </section>
      <section class="sec">
        <h3>Deepest roads</h3>
        <ol class="rank" id="roads"></ol>
      </section>
    `;
  }

  update(time: number, r: ImpactReport | undefined, depth: Float32Array | null) {
    const $ = (id: string) => this.el.querySelector('#' + id) as HTMLElement;
    $('imp-time').textContent = fmtHour(time);
    $('imp-day').textContent = fmtDay(time);
    if (!r) return;
    const sev = $('imp-sev');
    sev.textContent = SEVERITY_LABEL[r.overall] ?? r.overall;
    sev.style.setProperty('--c', SEVERITY_COLOR[r.overall] ?? '#888');
    sev.dataset.sev = r.overall;
    $('k-area').innerHTML = r.floodedAreaKm2 >= 0.01 ? `${r.floodedAreaKm2.toFixed(2)}<small>km²</small>` : fmtArea(r.floodedAreaKm2 * 1e6).replace(/ (\S+)$/, '<small>$1</small>');
    $('k-2w').innerHTML = `${fmtNum(r.roads.impassableTwoWheelerKm)}<small>km</small>`;
    $('k-car').innerHTML = `${fmtNum(r.roads.impassableCarKm)}<small>km</small>`;
    $('k-bld').innerHTML = `${r.buildings.groundFloorWet.toLocaleString('en-IN')}<small>of ${r.buildings.total.toLocaleString('en-IN')}</small>`;
    const fac = r.facilities.filter((f) => f.severity !== 'none' && f.severity !== 'low');
    const byKind = new Map<string, number>();
    for (const f of fac) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
    $('k-fac').innerHTML = `${fac.length}<small>${fac.length === 1 ? 'place' : 'places'}</small>`;
    $('k-fac-l').textContent = fac.length
      ? [...byKind.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `${n} ${(FACILITY_LABEL[k] ?? k).toLowerCase()}${n > 1 ? (k === 'bus_stop' ? 's' : 's') : ''}`)
          .join(', ')
      : 'Schools, hospitals, stops and substations are reachable';
    for (const id of ['k-2w', 'k-car', 'k-bld', 'k-fac']) $(id).parentElement!.classList.toggle('hot', parseFloat($(id).textContent ?? '0') > 0);

    const life = $('life');
    life.innerHTML = r.dailyLife.length
      ? r.dailyLife
          .slice(0, 6)
          .map(
            (d) => `<article class="card" style="--c:${SEVERITY_COLOR[d.severity]}">
          <div class="card-ico">${iconSvg(d.icon, 20)}</div>
          <div><h4>${esc(d.title)}</h4><p>${esc(d.detail)}</p></div></article>`,
          )
          .join('')
      : `<p class="empty">No disruption expected at this hour. Scrub the timeline to the heaviest rain, or pick a scenario on the left.</p>`;

    const deps = $('deps');
    deps.innerHTML = this.deps
      .map((d, i) => {
        let now = 0;
        if (depth) for (const c of d.cells) if (depth[c] > now) now = depth[c];
        return `<li><button data-dep="${i}"><span class="rk-name">${esc(d.label ?? `Low spot ${d.id}`)}</span>
          <span class="rk-meta">${fmtArea(d.areaM2)}, up to ${d.maxDepthM.toFixed(1)} m deep</span>
          <span class="rk-v ${now >= 0.15 ? 'wet' : ''}">${fmtDepth(now)}</span></button></li>`;
      })
      .join('');
    deps.querySelectorAll<HTMLButtonElement>('[data-dep]').forEach((b) => b.addEventListener('click', () => this.h.onDepression(this.deps[Number(b.dataset.dep)])));

    const roads = $('roads');
    const worst = r.roads.worst.filter((w) => w.depthM >= 0.05).slice(0, 6);
    roads.innerHTML = worst.length
      ? worst
          .map((w) => `<li><button data-road="${esc(w.name)}"><span class="rk-name">${esc(w.name || 'Unnamed road')}</span><span class="rk-meta">${passText(w.depthM)}</span><span class="rk-v wet">${fmtDepth(w.depthM)}</span></button></li>`)
          .join('')
      : '<li class="empty">All roads passable.</li>';
    roads.querySelectorAll<HTMLButtonElement>('[data-road]').forEach((b) => b.addEventListener('click', () => this.h.onRoad(b.dataset.road!)));
  }
}

function passText(d: number) {
  if (d > 0.5) return 'Closed to buses and cars';
  if (d > 0.3) return 'Closed to cars, buses only';
  if (d > 0.15) return 'Closed to two-wheelers';
  return 'Passable with care';
}
