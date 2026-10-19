// Impact section: four headline numbers, the top daily-life cards (expandable),
// and the deepest roads / lowest spots lists (collapsed by default).
import type { Depression, ImpactReport, Severity } from '../types';
import { areaRangeText, rangeText, type EnsembleSummary, type Range } from '../ensemble';
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
/** the four headline numbers, in order */
const KPI_IDS = ['k-area', 'k-2w', 'k-car', 'k-bld'];

export class ImpactView {
  private el: HTMLElement;
  private h: ImpactHandlers;
  private deps: Depression[];
  private allCards: boolean;
  private last: { sev: Severity; area: number } | null = null;
  /** the per-model list is open (remembered); how many models it lists (0 = none shown) */
  private ensOpen = false;
  private ensN = 0;

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
      <div class="ens" id="ens" hidden><p class="ens-note" id="ens-note"></p><p class="ens-worst" id="ens-worst" hidden></p><button class="more" id="ens-more" type="button" aria-controls="ens-list" aria-expanded="false" hidden></button><ol class="ens-list" id="ens-list" hidden></ol></div>
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
    // the range across weather models, quietly under each number (setEnsemble)
    for (const id of KPI_IDS) {
      const r = document.createElement('span');
      r.className = 'kpi-r';
      r.id = `${id}-r`;
      r.hidden = true;
      el.querySelector(`#${id}`)!.parentElement!.append(r);
    }
    this.ensOpen = load('imp.models', false);
    el.querySelector('#ens-more')!.addEventListener('click', () => {
      this.ensOpen = !this.ensOpen;
      save('imp.models', this.ensOpen);
      this.syncEns();
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

  /**
   * The prediction range across weather models (live forecast only): `pending` models still being
   * predicted, then the summary. Nothing shows for null or when every model stays dry.
   */
  setEnsemble(s: EnsembleSummary | null, pending = 0) {
    const $ = (id: string) => this.el.querySelector('#' + id) as HTMLElement;
    const show = !!s && !s.dry && !pending;
    $('ens').hidden = !show && !pending;
    $('ens-note').textContent = pending ? `Comparing ${pending} weather models…` : show ? `Ranges: 48 h peak across ${s!.n} weather models` : '';
    const ranges: [string, Range | undefined, (v: number) => string][] = [
      ['k-2w', s?.twoWheelerKm, (v) => fmtNum(v)],
      ['k-car', s?.carKm, (v) => fmtNum(v)],
      ['k-bld', s?.buildingsWet, (v) => Math.round(v).toLocaleString('en-IN')],
    ];
    const sr = `<span class="ens-sr">Across ${s?.n ?? 0} weather models: </span>`;
    const area = $('k-area-r');
    area.innerHTML = show ? sr + areaRangeText(s!.floodedKm2).replace(/ (\S+)$/, '<small>$1</small>') : '';
    for (const [id, r, f] of ranges) $(`${id}-r`).innerHTML = show && r ? `${sr}${rangeText(r, f)}${id === 'k-bld' ? '' : '<small>km</small>'}` : '';
    for (const id of KPI_IDS) {
      const r = $(`${id}-r`);
      r.hidden = !show;
      r.title = show ? `Lowest to highest across ${s!.n} weather models, each at its peak in the next 48 h` : '';
    }
    const w = show ? s!.worse : null;
    const worst = $('ens-worst');
    worst.hidden = !w;
    worst.innerHTML = w
      ? `Worst model: <b>${esc(w.name)}</b> → <span class="sev" style="--c:${SEVERITY_COLOR[w.severity]}" data-sev="${w.severity}">${SEVERITY_LABEL[w.severity]}</span>`
      : '';
    $('ens-list').innerHTML = show
      ? s!.members
          .map(
            (m) => `<li class="ens-row" style="--c:${SEVERITY_COLOR[m.severity]}">
          <span class="ens-name">${esc(m.name)}</span><span class="ens-v">${fmtArea(m.floodedKm2 * 1e6)}</span>
          <span class="ens-meta">${fmtNum(m.rainMm, m.rainMm < 10 ? 1 : 0)} mm in 48 h</span><span class="ens-sev" data-sev="${m.severity}"><i aria-hidden="true"></i>${SEVERITY_LABEL[m.severity]}</span></li>`,
          )
          .join('')
      : '';
    this.ensN = show ? s!.n : 0;
    this.syncEns();
  }

  private syncEns() {
    const more = this.el.querySelector('#ens-more') as HTMLButtonElement;
    const list = this.el.querySelector('#ens-list') as HTMLElement;
    more.hidden = !this.ensN;
    list.hidden = !this.ensN || !this.ensOpen;
    more.setAttribute('aria-expanded', String(this.ensOpen));
    more.innerHTML = `<span>${this.ensOpen ? 'Hide per model' : 'Show per model'}</span>${iconSvg('chevron', 12, 1.8)}`;
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
