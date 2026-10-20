// The "My commute" card in the sidebar: home and office (offline search over pincodes and areas,
// "Use my location", or a tap on the map), the usual departure (Morning / Evening + time), an
// optional return trip; then the routes, the hotspots on the chosen one, the city's next three
// hours, and the "Why" card for one hotspot. DOM only: src/ui/commute/view.ts does the work.
import type { LngLat } from '../../commute/spots';
import type { CommuteHotspot, HotspotOutlook, RiskLevel, RouteCandidate, RouteRisk } from '../../commute/types';
import { fmtHHMM } from '../../commute/verdict';
import { esc } from '../format';
import { iconSvg } from '../icons';
import { LEVEL_COLOR, LEVEL_TEXT, TYPE_LABEL, explainRows, pill, rank } from './levels';
import { EVENING, MORNING, cleanHHMM, presetOf, type CommuteState, type Leg } from './state';

export type End = 'home' | 'office';
export interface PlaceHit {
  label: string;
  sub: string;
  coord: LngLat;
}

export interface PanelHandlers {
  change(s: CommuteState): void;
  search(q: string): PlaceHit[];
  /** start picking a point on the map for this end */
  pick(end: End): void;
  /** the reader's position (asks for permission) */
  locate(end: End): void;
  route(id: RouteCandidate['id']): void;
  leg(id: Leg['id']): void;
  hotspot(id: string | null): void;
  share(): Promise<boolean>;
}

const END_TEXT: Record<End, { name: string; ph: string }> = {
  home: { name: 'Home', ph: 'Area or pincode, e.g. Indiranagar' },
  office: { name: 'Office', ph: 'Area or pincode, e.g. Bellandur' },
};
const fmtMin = (s: number) => {
  const m = Math.max(1, Math.round(s / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
};
const fmtKm = (m: number) => `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
const fmtDate = (d: string) => {
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : d;
};

export class CommutePanel {
  readonly root: HTMLElement;
  private s: CommuteState;
  private h: PanelHandlers;
  private open: End | null = null;
  private active = -1;
  private hits: PlaceHit[] = [];

  constructor(container: HTMLElement, state: CommuteState, h: PanelHandlers) {
    this.s = state;
    this.h = h;
    const field = (end: End) => `
      <div class="cm-end" data-end="${end}">
        <span class="cm-end-ico" aria-hidden="true">${iconSvg(end === 'home' ? 'home' : 'office', 15, 2)}</span>
        <label class="cm-end-lbl" for="cm-${end}-q">${END_TEXT[end].name}</label>
        <input id="cm-${end}-q" class="cm-q" data-end="${end}" type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="cm-${end}-list"
          autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" placeholder="${END_TEXT[end].ph}" />
        <ul class="cm-list" id="cm-${end}-list" role="listbox" aria-label="${END_TEXT[end].name}: places" hidden></ul>
      </div>`;
    container.innerHTML = `
      <div class="cm">
        <div class="cm-why" hidden tabindex="-1" role="region" aria-label="Why this level"></div>
        <form class="cm-trip" aria-label="My commute">
          <div class="cm-ends">${field('home')}${field('office')}</div>
          <div class="cm-row">
            <span class="cm-row-lbl" id="cm-dep-lbl">Leave home</span>
            <div class="segmented small cm-seg" role="group" aria-labelledby="cm-dep-lbl">
              <button type="button" data-t="${MORNING}">Morning</button><button type="button" data-t="${EVENING}">Evening</button>
            </div>
            <input type="time" class="cm-time cm-dep" step="300" aria-labelledby="cm-dep-lbl" />
          </div>
          <div class="cm-row">
            <label class="cm-row-lbl" for="cm-ret-on">Return trip</label>
            <input type="time" class="cm-time cm-ret" step="300" aria-label="Leave the office at" />
            <input id="cm-ret-on" type="checkbox" class="switch" role="switch" />
          </div>
        </form>
        <p class="cm-msg" role="status"></p>
        <div class="cm-result" hidden>
          <div class="segmented cm-legs" role="group" aria-label="Which trip" hidden></div>
          <h3 class="cm-h" id="cm-routes-h">Routes</h3>
          <ol class="cm-routes" aria-labelledby="cm-routes-h"></ol>
          <div class="cm-hits-wrap" hidden><h3 class="cm-h" id="cm-hits-h">On this route</h3><ol class="cm-hits" aria-labelledby="cm-hits-h"></ol></div>
        </div>
        <div class="cm-city" hidden><h3 class="cm-h" id="cm-city-h"></h3><ul class="cm-watch" aria-labelledby="cm-city-h"></ul></div>
        <p class="cm-fine">Advisory only. Levels are estimated from the rain forecast, low ground and past flood reports, not measured on the road. Check traffic updates before you set out.</p>
        <button type="button" class="btn-link cm-share" hidden>Copy link to this commute</button>
      </div>`;
    this.root = container.querySelector('.cm') as HTMLElement;
    this.wire();
    this.syncForm();
  }

  private $<T extends HTMLElement>(sel: string): T {
    return this.root.querySelector(sel) as T;
  }

  // ---------------------------------------------------------------- form
  private wire() {
    const r = this.root;
    r.querySelector('form')!.addEventListener('submit', (e) => e.preventDefault());
    r.querySelectorAll<HTMLInputElement>('.cm-q').forEach((inp) => {
      const end = inp.dataset.end as End;
      inp.addEventListener('focus', () => this.openList(end));
      inp.addEventListener('input', () => this.openList(end));
      inp.addEventListener('blur', () => setTimeout(() => {
        if (!this.root.querySelector(`[data-end="${end}"]`)?.contains(document.activeElement)) this.closeList(true);
      }, 120));
      inp.addEventListener('keydown', (e) => {
        const n = this.optionCount();
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (this.open !== end) this.openList(end);
          this.setActive((this.active + (e.key === 'ArrowDown' ? 1 : n - 1) + n) % n);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (this.active >= 0) this.choose(end, this.active);
        } else if (e.key === 'Escape' && this.open) {
          e.preventDefault();
          e.stopPropagation();
          this.closeList(true);
        }
      });
    });
    r.addEventListener('mousedown', (e) => {
      // keep focus in the field while an option is clicked
      if ((e.target as HTMLElement).closest('.cm-opt')) e.preventDefault();
    });
    r.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const opt = t.closest<HTMLElement>('.cm-opt');
      if (opt && this.open) return this.choose(this.open, Number(opt.dataset.i));
      const seg = t.closest<HTMLButtonElement>('.cm-seg button');
      if (seg) return this.update({ dep: seg.dataset.t! });
      const route = t.closest<HTMLButtonElement>('.cm-route');
      if (route) return this.h.route(route.dataset.route as RouteCandidate['id']);
      const leg = t.closest<HTMLButtonElement>('.cm-legs button');
      if (leg) return this.h.leg(leg.dataset.leg as Leg['id']);
      const spot = t.closest<HTMLButtonElement>('[data-spot]');
      if (spot) return this.h.hotspot(spot.dataset.spot!);
      if (t.closest('.cm-why-close')) return this.h.hotspot(null);
      if (t.closest('.cm-share')) {
        const b = t.closest('.cm-share') as HTMLButtonElement;
        void this.h.share().then((ok) => {
          b.textContent = ok ? 'Link copied' : 'Could not copy the link';
          setTimeout(() => (b.textContent = 'Copy link to this commute'), 2500);
        });
      }
    });
    const dep = this.$<HTMLInputElement>('.cm-dep');
    dep.addEventListener('change', () => {
      const v = cleanHHMM(dep.value);
      if (v) this.update({ dep: v });
    });
    const ret = this.$<HTMLInputElement>('.cm-ret');
    const on = this.$<HTMLInputElement>('#cm-ret-on');
    on.addEventListener('change', () => this.update({ ret: on.checked ? (cleanHHMM(ret.value) ?? EVENING) : null }));
    ret.addEventListener('change', () => {
      const v = cleanHHMM(ret.value);
      if (v) this.update({ ret: v });
    });
  }

  private update(p: Partial<CommuteState>) {
    this.s = { ...this.s, ...p };
    this.syncForm();
    this.h.change(this.s);
  }

  /** set one end from outside (map pick, geolocation, marker drag) */
  setEnd(end: End, label: string, coord: LngLat) {
    this.update({ [end]: { label, coord } } as Partial<CommuteState>);
  }

  get state(): CommuteState {
    return this.s;
  }

  private syncForm() {
    for (const end of ['home', 'office'] as End[]) {
      const inp = this.$<HTMLInputElement>(`#cm-${end}-q`);
      if (document.activeElement !== inp) inp.value = this.s[end]?.label ?? '';
      inp.closest('.cm-end')!.classList.toggle('set', !!this.s[end]);
    }
    const p = presetOf(this.s.dep);
    this.root.querySelectorAll<HTMLButtonElement>('.cm-seg button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.t === MORNING ? 'am' : 'pm') === p)));
    const dep = this.$<HTMLInputElement>('.cm-dep');
    if (document.activeElement !== dep) dep.value = this.s.dep;
    const on = this.$<HTMLInputElement>('#cm-ret-on');
    const ret = this.$<HTMLInputElement>('.cm-ret');
    on.checked = !!this.s.ret;
    ret.hidden = !this.s.ret;
    if (this.s.ret && document.activeElement !== ret) ret.value = this.s.ret;
    this.$<HTMLElement>('.cm-share').hidden = !(this.s.home && this.s.office);
  }

  // ---------------------------------------------------------------- place search (combobox)
  private optionCount() {
    return 2 + this.hits.length;
  }

  private openList(end: End) {
    if (this.open && this.open !== end) this.closeList(false);
    this.open = end;
    const inp = this.$<HTMLInputElement>(`#cm-${end}-q`);
    const list = this.$<HTMLUListElement>(`#cm-${end}-list`);
    const q = inp.value.trim();
    const typed = q && q !== this.s[end]?.label;
    this.hits = typed ? this.h.search(q) : [];
    const opt = (i: number, ico: string, label: string, sub: string) =>
      `<li role="option" id="cm-${end}-o${i}" class="cm-opt" data-i="${i}" aria-selected="false"><span class="cm-opt-ico" aria-hidden="true">${ico}</span><span class="cm-opt-t"><b>${esc(label)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</span></li>`;
    list.innerHTML =
      opt(0, iconSvg('target', 14, 2), 'Use my location', 'Asks your browser for your position') +
      opt(1, iconSvg('pin', 14, 2), 'Pick on the map', 'Tap the map where it is') +
      (this.hits.length
        ? this.hits.map((p, i) => opt(i + 2, iconSvg('flood', 14, 2), p.label, p.sub)).join('')
        : typed
          ? '<li class="cm-none" role="presentation">No pincode or area by that name in Bengaluru Urban</li>'
          : '');
    list.hidden = false;
    inp.setAttribute('aria-expanded', 'true');
    this.setActive(this.hits.length ? 2 : -1);
  }

  private setActive(i: number) {
    if (!this.open) return;
    this.active = i;
    const inp = this.$<HTMLInputElement>(`#cm-${this.open}-q`);
    this.$<HTMLElement>(`#cm-${this.open}-list`).querySelectorAll<HTMLElement>('.cm-opt').forEach((o, j) => {
      o.classList.toggle('active', j === i);
      o.setAttribute('aria-selected', String(j === i));
      if (j === i) o.scrollIntoView({ block: 'nearest' });
    });
    if (i >= 0) inp.setAttribute('aria-activedescendant', `cm-${this.open}-o${i}`);
    else inp.removeAttribute('aria-activedescendant');
  }

  private closeList(restore: boolean) {
    if (!this.open) return;
    const end = this.open;
    const inp = this.$<HTMLInputElement>(`#cm-${end}-q`);
    this.$<HTMLElement>(`#cm-${end}-list`).hidden = true;
    inp.setAttribute('aria-expanded', 'false');
    inp.removeAttribute('aria-activedescendant');
    if (restore && document.activeElement !== inp) inp.value = this.s[end]?.label ?? '';
    this.open = null;
    this.active = -1;
    this.hits = [];
  }

  private choose(end: End, i: number) {
    const hit = this.hits[i - 2];
    this.closeList(false);
    if (i === 0) return this.h.locate(end);
    if (i === 1) return this.h.pick(end);
    if (hit) {
      this.$<HTMLInputElement>(`#cm-${end}-q`).blur();
      this.setEnd(end, hit.label, hit.coord);
    }
  }

  // ---------------------------------------------------------------- messages and results
  say(text: string, tone: 'info' | 'error' = 'info') {
    const m = this.$<HTMLElement>('.cm-msg');
    m.textContent = text;
    m.dataset.tone = tone;
  }

  /** the trip switch (only with a return trip) */
  showLegs(ls: Leg[], current: Leg['id'] | null, now: number, dayWord: (t: number, now: number) => string) {
    const el = this.$<HTMLElement>('.cm-legs');
    el.hidden = ls.length < 2;
    el.innerHTML = ls
      .map((l) => {
        const day = dayWord(l.departure, now);
        return `<button type="button" data-leg="${l.id}" aria-pressed="${l.id === current}">${l.id === 'out' ? 'To office' : 'Back home'} ${l.hhmm}<span class="sr-only">, ${day}</span></button>`;
      })
      .join('');
  }

  /** routes A/B/C and the hotspots met on the chosen one; null hides the result */
  showRoutes(rs: RouteCandidate[] | null, risks: RouteRisk[], chosen: RouteCandidate['id'] | null, departure: number, hs: Map<string, CommuteHotspot>, advised?: RouteCandidate['id']) {
    const res = this.$<HTMLElement>('.cm-result');
    res.hidden = !rs;
    if (!rs) return;
    const riskOf = (id: string) => risks.find((r) => r.route === id);
    this.$<HTMLElement>('.cm-routes').innerHTML = rs
      .map((r) => {
        const rk = riskOf(r.id);
        const l: RiskLevel = rk?.level ?? 'clear';
        const n = rk?.hits.filter((x) => rank(x.level) > 0).length ?? 0;
        return `<li><button type="button" class="cm-route" data-route="${r.id}" aria-pressed="${r.id === chosen}">
          <span class="cm-rid" aria-hidden="true">${r.id}</span>
          <span class="cm-rmain"><span class="cm-rtop"><b>${fmtMin(r.durationS)}</b><span>${fmtKm(r.lengthM)}</span>${r.id === advised ? '<span class="cm-tag">Suggested</span>' : ''}</span><span class="cm-via">${esc(r.via)}</span></span>
          ${pill(l)}<span class="sr-only">${n ? `, ${n} hotspot${n === 1 ? '' : 's'} with water expected` : ''}</span>
        </button></li>`;
      })
      .join('');
    const rk = chosen ? riskOf(chosen) : undefined;
    const hits = rk?.hits ?? [];
    this.$<HTMLElement>('.cm-hits-wrap').hidden = !hits.length;
    this.$<HTMLElement>('.cm-hits').innerHTML = hits
      .map((x) => {
        const h = hs.get(x.id);
        return `<li><button type="button" class="cm-row-btn" data-spot="${esc(x.id)}">
          <time class="cm-at">${fmtHHMM(departure + x.atS * 1000)}</time><span class="cm-name">${esc(h?.name ?? x.id)}</span>${pill(x.level)}</button></li>`;
      })
      .join('');
  }

  /** hotspots at watch or worse anywhere in the city at the scrubber's step */
  showCity(items: { h: CommuteHotspot; level: RiskLevel }[], when: string) {
    const box = this.$<HTMLElement>('.cm-city');
    box.hidden = false;
    this.$<HTMLElement>('#cm-city-h').textContent = items.length ? `Across the city · ${when}` : `Across the city · ${when}: no waterlogging expected`;
    this.$<HTMLElement>('.cm-watch').innerHTML = items
      .slice(0, 12)
      .map(({ h, level }) => `<li><button type="button" class="cm-row-btn" data-spot="${esc(h.id)}"><span class="cm-dot" style="--c:${LEVEL_COLOR[level]}" aria-hidden="true"></span><span class="cm-name">${esc(h.name)}</span>${pill(level)}</button></li>`)
      .join('');
  }

  /** the "Why" card for one hotspot; null closes it */
  showWhy(h: CommuteHotspot | null, o: HotspotOutlook | undefined, arrival?: { t: number; level: RiskLevel }) {
    const el = this.$<HTMLElement>('.cm-why');
    if (!h) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    const b0 = o?.buckets[0];
    const strip = (o?.buckets ?? [])
      .slice(0, 6)
      .map((b, i) => `<li style="--c:${LEVEL_COLOR[b.level]}"><i data-level="${b.level}"></i><span>${i === 0 ? 'Now' : fmtHHMM(b.t)}</span><span class="sr-only">: ${LEVEL_TEXT[b.level]}</span></li>`)
      .join('');
    const rows = b0 ? explainRows(b0.explain, h) : [];
    const src = h.sources
      .slice(0, 3)
      .map((s) => `<li><time>${esc(fmtDate(s.date))}</time> <a href="${encodeURI(s.url)}" target="_blank" rel="noopener">${esc(s.outlet)}</a></li>`)
      .join('');
    el.innerHTML = `
      <div class="cm-why-head">
        <div><h3 class="cm-why-t">${esc(h.name)}</h3><p class="cm-why-sub">${TYPE_LABEL[h.type] ?? 'Place'}${arrival ? ` · when you reach it at ${fmtHHMM(arrival.t)}: ${LEVEL_TEXT[arrival.level].toLowerCase()}` : ''}</p></div>
        <button type="button" class="icon-btn cm-why-close" aria-label="Close ${esc(h.name)}">${iconSvg('close', 13, 2)}</button>
      </div>
      ${strip ? `<p class="cm-why-cap">Next 3 hours, half-hour steps</p><ol class="cm-strip">${strip}</ol>` : ''}
      ${rows.length ? `<p class="cm-why-cap">Now, the inputs</p><dl class="cm-why-dl">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
      ${src ? `<p class="cm-why-cap">Reports</p><ul class="cm-why-src">${src}</ul>` : ''}
      ${h.notes ? `<p class="cm-why-note">${esc(h.notes)}</p>` : ''}`;
    el.hidden = false;
  }

  focusWhy() {
    const el = this.$<HTMLElement>('.cm-why');
    if (!el.hidden) el.focus({ preventScroll: false });
  }

  /** level words for a scrubber step label ("Now" / "18:30") */
  static stepLabel(t: number, k: number) {
    return k === 0 ? 'now' : `at ${fmtHHMM(t)}`;
  }

}
