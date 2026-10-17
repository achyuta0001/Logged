// Impact section: four headline numbers, the top daily-life cards (expandable),
// and the deepest roads / lowest spots lists (collapsed by default).
import type { Depression, ImpactReport, Severity } from '../types';
import { SEVERITY_COLOR, SEVERITY_LABEL } from '../map/colors';
import { FACILITY_LABEL } from '../map/features';
import { esc, fmtArea, fmtDay, fmtDepth, fmtHour, fmtNum } from './format';
import { iconSvg } from './icons';
import { load, save } from './store';

export interface ImpactHandlers {
  onDepression(d: Depression): void;
  onRoad(name: string): void;
}

const TOP_CARDS = 3;

export class ImpactView {
  private el: HTMLElement;
  private h: ImpactHandlers;
  private deps: Depression[];
  private allCards: boolean;
  private last: { sev: Severity; area: number } | null = null;

  constructor(el: HTMLElement, deps: Depression[], h: ImpactHandlers) {
    this.el = el;
    this.h = h;
    this.deps = deps.slice(0, 6);
    this.allCards = load('imp.allCards', false);
    el.innerHTML = `
      <div class="imp-at"><span>At <b id="imp-time">–</b> <span id="imp-day"></span></span><span class="sev" id="imp-sev">–</span></div>
      <div class="kpis" role="list">
        <div class="kpi water" role="listitem"><span class="kpi-v" id="k-area">–</span><span class="kpi-l">under water</span></div>
        <div class="kpi" role="listitem" title="Length of road deeper than 15 cm"><span class="kpi-v" id="k-2w">–</span><span class="kpi-l">shut to 2‑wheelers</span></div>
        <div class="kpi" role="listitem" title="Length of road deeper than 30 cm"><span class="kpi-v" id="k-car">–</span><span class="kpi-l">shut to cars</span></div>
        <div class="kpi" role="listitem" id="k-bld-box" title="Buildings with water above plinth height (25 cm)"><span class="kpi-v" id="k-bld">–</span><span class="kpi-l">buildings wet</span></div>
      </div>
      <p class="imp-fac" id="k-fac" hidden></p>
      <div class="life" id="life"></div>
      <button class="more" id="life-more" type="button" aria-controls="life" aria-expanded="false" hidden></button>
      ${this.sub('roads', 'Deepest roads')}
      ${this.sub('deps', 'Lowest spots')}
    `;
    el.querySelector('#life-more')!.addEventListener('click', () => {
      this.allCards = !this.allCards;
      save('imp.allCards', this.allCards);
      this.syncCards();
    });
    el.querySelector('#life')!.addEventListener('click', (e) => {
      const c = (e.target as HTMLElement).closest<HTMLButtonElement>('.card');
      if (c) c.setAttribute('aria-expanded', String(c.getAttribute('aria-expanded') !== 'true'));
    });
    el.querySelectorAll<HTMLButtonElement>('.sub-toggle').forEach((b) => {
      const key = b.dataset.sub!;
      const set = (open: boolean) => {
        b.setAttribute('aria-expanded', String(open));
        (el.querySelector(`#sub-${key}`) as HTMLElement).hidden = !open;
      };
      set(load(`imp.${key}`, false));
      b.addEventListener('click', () => {
        const open = b.getAttribute('aria-expanded') !== 'true';
        set(open);
        save(`imp.${key}`, open);
      });
    });
    el.querySelector('#sub-deps')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-dep]');
      if (b) this.h.onDepression(this.deps[Number(b.dataset.dep)]);
    });
    el.querySelector('#sub-roads')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-road]');
      if (b) this.h.onRoad(b.dataset.road!);
    });
  }

  private sub(key: string, title: string) {
    return `<div class="subsec">
      <button class="sub-toggle" type="button" data-sub="${key}" aria-expanded="false" aria-controls="sub-${key}">
        <span>${title}</span><span class="sub-n" id="sub-${key}-n"></span>${iconSvg('chevron', 13, 1.8)}
      </button>
      <ol class="rank" id="sub-${key}" hidden></ol>
    </div>`;
  }

  /** One-line summary for the collapsed section header. */
  get summary(): string {
    if (!this.last) return '';
    return this.last.sev === 'none' ? 'Dry at this hour' : `${SEVERITY_LABEL[this.last.sev]} · ${fmtArea(this.last.area * 1e6)} under water`;
  }

  update(time: number, r: ImpactReport | undefined, depth: Float32Array | null) {
    const $ = (id: string) => this.el.querySelector('#' + id) as HTMLElement;
    $('imp-time').textContent = fmtHour(time);
    $('imp-day').textContent = fmtDay(time);
    if (!r) return;
    this.last = { sev: r.overall, area: r.floodedAreaKm2 };
    const sev = $('imp-sev');
    sev.textContent = SEVERITY_LABEL[r.overall] ?? r.overall;
    sev.style.setProperty('--c', SEVERITY_COLOR[r.overall] ?? '#888');
    sev.dataset.sev = r.overall;
    $('k-area').innerHTML =
      r.floodedAreaKm2 >= 0.01 ? `${r.floodedAreaKm2.toFixed(2)}<small>km²</small>` : fmtArea(r.floodedAreaKm2 * 1e6).replace(/ (\S+)$/, '<small>$1</small>');
    $('k-2w').innerHTML = `${fmtNum(r.roads.impassableTwoWheelerKm)}<small>km</small>`;
    $('k-car').innerHTML = `${fmtNum(r.roads.impassableCarKm)}<small>km</small>`;
    $('k-bld').textContent = r.buildings.groundFloorWet.toLocaleString('en-IN');
    $('k-bld-box').title = `Water above plinth height (25 cm) at ${r.buildings.groundFloorWet.toLocaleString('en-IN')} of ${r.buildings.total.toLocaleString('en-IN')} mapped buildings`;
    for (const id of ['k-2w', 'k-car', 'k-bld']) $(id).parentElement!.classList.toggle('hot', parseFloat(($(id).textContent ?? '0').replace(/,/g, '')) > 0);

    const fac = r.facilities.filter((f) => f.severity !== 'none' && f.severity !== 'low');
    const byKind = new Map<string, number>();
    for (const f of fac) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
    const facEl = $('k-fac');
    facEl.hidden = !fac.length;
    facEl.innerHTML = fac.length
      ? `${iconSvg('alert', 13)}<span><b>${fac.length} ${fac.length === 1 ? 'place' : 'places'} cut off:</b> ${[...byKind.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `${n} ${esc((FACILITY_LABEL[k] ?? k).toLowerCase())}${n > 1 ? 's' : ''}`)
          .join(', ')}</span>`
      : '';

    const life = $('life');
    const cards = r.dailyLife;
    life.innerHTML = cards.length
      ? cards
          .map(
            (d, i) => `<button type="button" class="card${i >= TOP_CARDS ? ' extra' : ''}" style="--c:${SEVERITY_COLOR[d.severity]}" aria-expanded="false">
          <span class="card-ico">${iconSvg(d.icon, 16)}</span>
          <span class="card-t"><b>${esc(d.title)}</b><span class="card-d">${esc(d.detail)}</span></span></button>`,
          )
          .join('')
      : `<p class="empty">No disruption expected at this hour. Scrub the timeline to the heaviest rain, or pick a scenario under Rain.</p>`;
    life.dataset.n = String(cards.length);
    this.syncCards();

    const deps = $('sub-deps');
    deps.innerHTML = this.deps
      .map((d, i) => {
        let now = 0;
        if (depth) for (const c of d.cells) if (depth[c] > now) now = depth[c];
        return `<li><button type="button" data-dep="${i}"><span class="rk-name">${esc(d.label ?? `Low spot ${d.id}`)}</span>
          <span class="rk-meta">${fmtArea(d.areaM2)}, up to ${d.maxDepthM.toFixed(1)} m deep</span>
          <span class="rk-v ${now >= 0.15 ? 'wet' : ''}">${fmtDepth(now)}</span></button></li>`;
      })
      .join('');
    $('sub-deps-n').textContent = String(this.deps.length);

    const worst = r.roads.worst.filter((w) => w.depthM >= 0.05).slice(0, 6);
    $('sub-roads').innerHTML = worst.length
      ? worst
          .map(
            (w) =>
              `<li><button type="button" data-road="${esc(w.name)}"><span class="rk-name">${esc(w.name || 'Unnamed road')}</span><span class="rk-meta">${passText(w.depthM)}</span><span class="rk-v wet">${fmtDepth(w.depthM)}</span></button></li>`,
          )
          .join('')
      : '<li class="empty">All roads passable.</li>';
    $('sub-roads-n').textContent = worst.length ? String(worst.length) : '';
  }

  private syncCards() {
    const life = this.el.querySelector('#life') as HTMLElement;
    const n = Number(life.dataset.n ?? 0);
    const more = this.el.querySelector('#life-more') as HTMLButtonElement;
    life.classList.toggle('all', this.allCards);
    more.hidden = n <= TOP_CARDS;
    more.setAttribute('aria-expanded', String(this.allCards));
    more.innerHTML = `<span>${this.allCards ? 'Show fewer' : `Show all ${n}`}</span>${iconSvg('chevron', 12, 1.8)}`;
  }
}

function passText(d: number) {
  if (d > 0.5) return 'Closed to buses and cars';
  if (d > 0.3) return 'Closed to cars, buses only';
  if (d > 0.15) return 'Closed to two-wheelers';
  return 'Passable with care';
}
