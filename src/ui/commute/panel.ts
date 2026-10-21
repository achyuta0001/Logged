// The "My commute" card in the sidebar: home, office and up to five more saved places, each found by
// the offline search over pincodes and areas, "Use my location", or a tap on the map (a saved place
// is named, renamed and deleted in its own row); the trip checked, From and To picked from those
// places (home to office unless changed), and its usual departure, optional way back and days; then
// the routes, the hotspots on the chosen one, the city's next three hours, and the "Why" card for
// one hotspot. DOM only: src/ui/commute/view.ts does the work, src/ui/commute/state.ts the logic.
import type { LngLat } from '../../commute/spots';
import type { CommuteHotspot, HotspotOutlook, RiskLevel, RouteCandidate, RouteRisk } from '../../commute/types';
import { fmtHHMM } from '../../commute/verdict';
import { esc, safeHref } from '../format';
import { iconSvg } from '../icons';
import type { CardOutcome } from './card';
import { LEVEL_COLOR, LEVEL_SHORT, LEVEL_TEXT, TYPE_LABEL, explainRows, pill, rank } from './levels';
import { fmtKm, fmtMin, routeReason } from './lines';
import { MAX_LABEL, MAX_PLACES, addPlace, movePlace, renamePlace } from './places';
import {
  EVENING, backWords, chooseEnd, cleanDays, cleanHHMM, endLabel, endOf, swapEnds, timesOf, toWords, tripWords, withTimes, withoutPlace,
  type CommuteState, type EndId, type Leg, type Times,
} from './state';

/** a place field: home, office, a saved place's id, or 'add' (the row that saves a new place) */
export type End = EndId | 'add';
export interface PlaceHit {
  label: string;
  sub: string;
  coord: LngLat;
}

export interface PanelHandlers {
  change(s: CommuteState): void;
  search(q: string): PlaceHit[];
  /** start picking a point on the map for this place */
  pick(end: End): void;
  /** the reader's position (asks for permission) */
  locate(end: End): void;
  route(id: RouteCandidate['id']): void;
  leg(id: Leg['id']): void;
  hotspot(id: string | null): void;
  share(): Promise<boolean>;
  /** draws the checked trip as a picture and shares or saves it; absent, there is no "Share card" */
  card?(): Promise<CardOutcome>;
}

const END_TEXT: Record<'home' | 'office', { name: string; ph: string }> = {
  home: { name: 'Home', ph: 'Area or pincode, e.g. Indiranagar' },
  office: { name: 'Office', ph: 'Area or pincode, e.g. Bellandur' },
};
/** the week, Monday first: [ISO digit, letter, name] */
const DAYS: [string, string, string][] = [['1', 'M', 'Monday'], ['2', 'T', 'Tuesday'], ['3', 'W', 'Wednesday'], ['4', 'T', 'Thursday'], ['5', 'F', 'Friday'], ['6', 'S', 'Saturday'], ['7', 'S', 'Sunday']];
const fmtDate = (d: string) => {
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : d;
};
const CARD = 'Share card';
/** what the "Share card" button says after a try */
const CARD_DONE: Record<CardOutcome, string> = { shared: 'Card shared', saved: 'Card downloaded', cancelled: CARD, retry: 'Card ready: tap to share', failed: 'Could not make the card' };
/** a plus and two opposed arrows, drawn like the app's icons (src/ui/icons.ts has neither) */
const glyph = (d: string, size: number) =>
  `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const PLUS = glyph('M12 5.5v13M5.5 12h13', 14);
const SWAP = glyph('M8.5 19V5M8.5 5 5 8.5M8.5 5 12 8.5M15.5 5v14M15.5 19 12 15.5M15.5 19l3.5-3.5', 16);

/** a place field: a combobox over the place search, "Use my location" and "Pick on the map" */
const combo = (end: End, ph: string, name: string | null, list: string) => `
  <input id="cm-${end}-q" class="cm-q" data-end="${end}" type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="cm-${end}-list"${name ? ` aria-label="${esc(name)}"` : ''}
    autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" placeholder="${esc(ph)}" />
  <ul class="cm-list" id="cm-${end}-list" role="listbox" aria-label="${esc(list)}" hidden></ul>`;
/** a saved place's name field (its own row's, or the add row's) */
const nameField = (end: End, attrs: string) =>
  `<input id="cm-${end}-n" class="cm-name" data-end="${end}" type="text" maxlength="${MAX_LABEL}" autocomplete="off" autocapitalize="words" spellcheck="false" enterkeyhint="${end === 'add' ? 'next' : 'done'}" ${attrs} />`;

export class CommutePanel {
  readonly root: HTMLElement;
  private s: CommuteState;
  /** last time back, kept while the way back is off so switching it on restores it */
  private lastRet: string | null = null;
  private h: PanelHandlers;
  private open: End | null = null;
  private active = -1;
  private hits: PlaceHit[] = [];
  private cardTimer = 0;
  /** the places the From / To chips were last drawn for */
  private chipsFor = '';

  constructor(container: HTMLElement, state: CommuteState, h: PanelHandlers) {
    this.s = state;
    this.h = h;
    const field = (end: 'home' | 'office') => `
      <div class="cm-end" data-end="${end}">
        <span class="cm-end-ico" aria-hidden="true">${iconSvg(end, 15, 2)}</span>
        <label class="cm-end-lbl" for="cm-${end}-q">${END_TEXT[end].name}</label>
        ${combo(end, END_TEXT[end].ph, null, `${END_TEXT[end].name}: places`)}
      </div>`;
    const chips = (which: 'from' | 'to', name: string) =>
      `<div class="cm-pair-row" role="radiogroup" aria-labelledby="cm-${which}-l"><span class="cm-pair-lbl" id="cm-${which}-l">${name}</span><div class="cm-chips" data-which="${which}"></div></div>`;
    container.innerHTML = `
      <div class="cm">
        <div class="cm-update" hidden><p class="cm-update-t"></p><button type="button" class="icon-btn cm-update-x" aria-label="Dismiss the update">${iconSvg('close', 12, 2)}</button></div>
        <p class="sr-only cm-update-sr" role="status"></p>
        <p class="sr-only cm-places-sr" role="status"></p>
        <div class="cm-why" hidden tabindex="-1" role="region" aria-label="Why this level"></div>
        <form class="cm-trip" aria-label="My commute">
          <div class="cm-ends" role="group" aria-label="My places">
            ${field('home')}${field('office')}
            <div class="cm-end cm-saved cm-add" data-end="add">
              <span class="cm-end-ico" aria-hidden="true">${PLUS}</span>
              ${nameField('add', 'placeholder="Name" aria-label="New place: name"')}
              ${combo('add', 'Area or pincode', 'New place: area or pincode', 'New place: places')}
            </div>
            <p class="cm-full" hidden>${MAX_PLACES} places saved, the most kept. Delete one to add another.</p>
          </div>
          <div class="cm-pair">
            <div class="cm-pair-rows">${chips('from', 'From')}${chips('to', 'To')}</div>
            <button type="button" class="icon-btn cm-swap" aria-label="Swap From and To" title="Swap From and To">${SWAP}</button>
          </div>
          <div class="cm-row">
            <label class="cm-row-lbl" for="cm-dep"><span class="cm-dep-t"></span><small class="cm-dep-s"></small></label>
            <input id="cm-dep" type="time" class="cm-time cm-dep" step="300" />
          </div>
          <div class="cm-row">
            <label class="cm-row-lbl" for="cm-ret"><span class="cm-ret-t"></span><small class="cm-ret-s"></small></label>
            <input id="cm-ret" type="time" class="cm-time cm-ret" step="300" />
            <input id="cm-ret-on" type="checkbox" class="switch" role="switch" />
          </div>
          <div class="cm-row">
            <span class="cm-row-lbl" id="cm-days-l">Days<small class="cm-days-s"></small></span>
            <div class="cm-days" role="group" aria-labelledby="cm-days-l">${DAYS.map(([d, l, name]) => `<button type="button" data-day="${d}" aria-pressed="false"><span aria-hidden="true">${l}</span><span class="sr-only">${name}</span></button>`).join('')}</div>
          </div>
        </form>
        <p class="cm-msg" role="status"></p>
        <div class="cm-result" hidden>
          <div class="segmented cm-legs" role="group" aria-label="Which trip" hidden></div>
          <div class="cm-leave-wrap" hidden><h3 class="cm-h" id="cm-leave-h">Best time to leave</h3><ol class="cm-leave" aria-labelledby="cm-leave-h"></ol></div>
          <h3 class="cm-h" id="cm-routes-h">Routes</h3>
          <ol class="cm-routes" aria-labelledby="cm-routes-h"></ol>
          <div class="cm-hits-wrap" hidden><h3 class="cm-h" id="cm-hits-h">On this route</h3><ol class="cm-hits" aria-labelledby="cm-hits-h"></ol></div>
        </div>
        <div class="cm-city" hidden><h3 class="cm-h" id="cm-city-h"></h3><ul class="cm-watch" aria-labelledby="cm-city-h"></ul></div>
        <p class="cm-fine">Advisory only. Levels are estimated from the rain forecast, low ground and past flood reports, not measured on the road. Check traffic updates before you set out.</p>
        <div class="cm-actions">
          <button type="button" class="btn-link cm-share" hidden>Copy link to this commute</button>
          <button type="button" class="btn-link cm-card" hidden>${CARD}</button>
        </div>
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
    // the place fields come and go with the saved places: one listener each on the card
    const field = (t: EventTarget | null, cls: string) => (t instanceof HTMLInputElement && t.classList.contains(cls) ? t : null);
    r.addEventListener('focusin', (e) => {
      const inp = field(e.target, 'cm-q');
      if (inp) this.openList(inp.dataset.end!);
    });
    r.addEventListener('input', (e) => {
      const inp = field(e.target, 'cm-q');
      if (inp) this.openList(inp.dataset.end!);
    });
    r.addEventListener('focusout', (e) => {
      const inp = field(e.target, 'cm-q');
      if (!inp) return;
      const end = inp.dataset.end!;
      setTimeout(() => {
        if (this.open === end && !this.rowOf(end)?.contains(document.activeElement)) this.closeList(true);
      }, 120);
    });
    r.addEventListener('keydown', (e) => {
      const q = field(e.target, 'cm-q');
      if (q) return this.comboKey(e, q.dataset.end!);
      const name = field(e.target, 'cm-name');
      if (name) this.nameKey(e, name);
    });
    r.addEventListener('change', (e) => {
      const name = field(e.target, 'cm-name');
      if (name && name.dataset.end !== 'add') return this.rename(name.dataset.end!, name);
      const t = e.target as HTMLInputElement;
      if (t.type === 'radio' && (t.name === 'cm-from' || t.name === 'cm-to')) this.pickEnd(t.name === 'cm-from' ? 'from' : 'to', t.value);
    });
    r.addEventListener('mousedown', (e) => {
      // keep focus in the field while an option is clicked
      if ((e.target as HTMLElement).closest('.cm-opt')) e.preventDefault();
    });
    r.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const opt = t.closest<HTMLElement>('.cm-opt');
      if (opt && this.open) return this.choose(this.open, Number(opt.dataset.i));
      const del = t.closest<HTMLButtonElement>('.cm-del');
      if (del) return this.remove(del.dataset.del!);
      if (t.closest('.cm-swap')) return this.swap();
      const route = t.closest<HTMLButtonElement>('.cm-route');
      if (route) return this.h.route(route.dataset.route as RouteCandidate['id']);
      const at = t.closest<HTMLButtonElement>('.cm-leave button');
      if (at) return this.setTimes(at.dataset.leg === 'back' ? { ret: at.dataset.at! } : { dep: at.dataset.at! });
      const day = t.closest<HTMLButtonElement>('.cm-days button');
      if (day) {
        const d = day.dataset.day!;
        const days = timesOf(this.s).days;
        // the check is for the next of these days, so at least one stays on
        if (days === d) return this.say('Keep at least one day.');
        return this.setTimes({ days: days.includes(d) ? days.replace(d, '') : cleanDays(days + d) });
      }
      const leg = t.closest<HTMLButtonElement>('.cm-legs button');
      if (leg) return this.h.leg(leg.dataset.leg as Leg['id']);
      const spot = t.closest<HTMLButtonElement>('[data-spot]');
      if (spot) return this.h.hotspot(spot.dataset.spot!);
      if (t.closest('.cm-why-close')) return this.h.hotspot(null);
      if (t.closest('.cm-update-x')) return this.showUpdate(null);
      if (t.closest('.cm-share')) {
        const b = t.closest('.cm-share') as HTMLButtonElement;
        void this.h.share().then((ok) => {
          b.textContent = ok ? 'Link copied' : 'Could not copy the link';
          setTimeout(() => (b.textContent = 'Copy link to this commute'), 2500);
        });
      }
      const card = t.closest<HTMLButtonElement>('.cm-card');
      if (card) this.shareCard(card);
    });
    const dep = this.$<HTMLInputElement>('.cm-dep');
    dep.addEventListener('change', () => {
      const v = cleanHHMM(dep.value);
      if (v) this.setTimes({ dep: v });
    });
    const ret = this.$<HTMLInputElement>('.cm-ret');
    const on = this.$<HTMLInputElement>('#cm-ret-on');
    on.addEventListener('change', () => this.setTimes({ ret: on.checked ? (cleanHHMM(ret.value) ?? EVENING) : null }));
    ret.addEventListener('change', () => {
      const v = cleanHHMM(ret.value);
      // setting a time for the way back is the clearest way to ask for that trip: switch it on too
      if (v) this.setTimes({ ret: v });
    });
  }

  /** "Share card": busy while the picture is drawn, then says how it went for a moment ("tap to share" stays) */
  private shareCard(b: HTMLButtonElement) {
    if (!this.h.card || b.getAttribute('aria-busy') === 'true') return;
    b.setAttribute('aria-busy', 'true');
    b.textContent = 'Making the card…';
    clearTimeout(this.cardTimer);
    void this.h.card().then((r) => {
      b.removeAttribute('aria-busy');
      b.textContent = CARD_DONE[r];
      if (r !== 'retry') this.cardTimer = window.setTimeout(() => (b.textContent = CARD), 2500);
    });
  }

  private set(next: CommuteState) {
    this.s = next;
    this.syncForm();
    this.h.change(this.s);
  }

  /** the checked trip's times (the commute's own, or the other trip's) */
  private setTimes(p: Partial<Times>) {
    this.set(withTimes(this.s, p));
  }

  /** set a place from outside (map pick, geolocation, marker drag) or from its list: home, office, a saved place, or a new one ('add') */
  setEnd(end: End, label: string, coord: LngLat, viaKeys = false) {
    if (end === 'home' || end === 'office') {
      const p = { label, coord };
      return this.set(end === 'home' ? { ...this.s, home: p } : { ...this.s, office: p });
    }
    if (end === 'add') return this.add(label, coord, viaKeys);
    const places = movePlace(this.s.places, end, label, coord);
    if (places !== this.s.places) this.set({ ...this.s, places });
  }

  get state(): CommuteState {
    return this.s;
  }

  /** what a place field shows when it is not being typed in */
  private placeText(end: End): string {
    if (end === 'home' || end === 'office') return this.s[end]?.label ?? '';
    return this.s.places.find((p) => p.id === end)?.where ?? '';
  }

  private rowOf(end: End) {
    return this.root.querySelector<HTMLElement>(`.cm-end[data-end="${end}"]`);
  }

  private syncForm() {
    for (const end of ['home', 'office'] as const) {
      const inp = this.$<HTMLInputElement>(`#cm-${end}-q`);
      // a field is not overwritten while its list is open (being typed in)
      if (this.open !== end) inp.value = this.s[end]?.label ?? '';
      inp.closest('.cm-end')!.classList.toggle('set', !!this.s[end]);
    }
    this.syncPlaces();
    this.syncChips();
    const t = timesOf(this.s);
    const w = tripWords(this.s);
    this.$<HTMLElement>('.cm-dep-t').textContent = w.out;
    this.$<HTMLElement>('.cm-dep-s').textContent = w.outAt;
    this.$<HTMLElement>('.cm-ret-t').textContent = w.back;
    this.$<HTMLElement>('.cm-ret-s').textContent = w.backAt;
    this.$<HTMLElement>('.cm-days-s').textContent = w.days;
    const dep = this.$<HTMLInputElement>('.cm-dep');
    if (document.activeElement !== dep) dep.value = t.dep;
    const on = this.$<HTMLInputElement>('#cm-ret-on');
    const ret = this.$<HTMLInputElement>('.cm-ret');
    on.checked = !!t.ret;
    on.setAttribute('aria-label', `Check the trip ${w.back.charAt(0).toLowerCase()}${w.back.slice(1)} too`);
    // the time back stays visible (dimmed while that trip is off) so both times are easy to find
    ret.classList.toggle('off', !t.ret);
    if (document.activeElement !== ret) ret.value = t.ret ?? this.lastRet ?? EVENING;
    if (t.ret) this.lastRet = t.ret;
    this.root.querySelectorAll<HTMLButtonElement>('.cm-days button').forEach((b) => b.setAttribute('aria-pressed', String(t.days.includes(b.dataset.day!))));
    this.$<HTMLElement>('.cm-share').hidden = !(endOf(this.s, this.s.from) && endOf(this.s, this.s.to));
  }

  // ---------------------------------------------------------------- saved places
  private savedRows(): HTMLElement[] {
    return [...this.root.querySelectorAll<HTMLElement>('.cm-ends > .cm-saved:not(.cm-add)')];
  }

  private makeRow(id: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'cm-end cm-saved set';
    row.dataset.end = id;
    row.innerHTML = `
      <span class="cm-end-ico" aria-hidden="true">${iconSvg('pin', 14, 2)}</span>
      ${nameField(id, 'aria-label="Place name"')}
      ${combo(id, 'Area or pincode', null, '')}
      <button type="button" class="icon-btn cm-del" data-del="${id}">${iconSvg('close', 11, 2.2)}</button>`;
    return row;
  }

  /** one row per saved place, in order, after office; rows are kept (and focus with them) while their place is */
  private syncPlaces() {
    const ids = new Set(this.s.places.map((p) => p.id));
    for (const row of this.savedRows()) {
      if (ids.has(row.dataset.end!)) continue;
      if (this.open === row.dataset.end) this.closeList(false);
      row.remove();
    }
    let prev = this.rowOf('office')!;
    for (const p of this.s.places) {
      const row = this.rowOf(p.id) ?? this.makeRow(p.id);
      if (prev.nextElementSibling !== row) prev.after(row);
      prev = row;
      const name = row.querySelector<HTMLInputElement>('.cm-name')!;
      const q = row.querySelector<HTMLInputElement>('.cm-q')!;
      if (document.activeElement !== name) name.value = p.label;
      if (this.open !== p.id) q.value = p.where;
      q.setAttribute('aria-label', p.label);
      row.querySelector('.cm-list')!.setAttribute('aria-label', `${p.label}: places`);
      const del = row.querySelector<HTMLButtonElement>('.cm-del')!;
      del.setAttribute('aria-label', `Delete ${p.label}`);
      del.title = `Delete ${p.label}`;
    }
    const full = this.s.places.length >= MAX_PLACES;
    if (full && this.open === 'add') this.closeList(false);
    this.$<HTMLElement>('.cm-add').hidden = full;
    this.$<HTMLElement>('.cm-full').hidden = !full;
  }

  /** a new saved place where the add row's search, the map or the location put it, named as typed or after its area */
  private add(where: string, coord: LngLat, viaKeys: boolean) {
    const name = this.$<HTMLInputElement>('#cm-add-n');
    const places = addPlace(this.s.places, where, coord, name.value);
    if (places === this.s.places) {
      return this.say(this.s.places.length >= MAX_PLACES ? `${MAX_PLACES} places are saved, the most kept. Delete one to add another.` : 'That point is outside Bengaluru.', 'error');
    }
    const p = places[places.length - 1];
    name.value = '';
    this.$<HTMLInputElement>('#cm-add-q').value = '';
    this.set({ ...this.s, places });
    this.announce(`Saved ${p.label}. Pick it under From or To.`);
    // from the keyboard: on to the next new place, or to the new place's name when that was the last free row
    if (viaKeys) (places.length < MAX_PLACES ? name : this.$<HTMLInputElement>(`#cm-${p.id}-n`)).focus();
  }

  private rename(id: string, inp: HTMLInputElement) {
    const places = renamePlace(this.s.places, id, inp.value);
    const p = places.find((x) => x.id === id);
    if (!p) return;
    inp.value = p.label;
    if (places === this.s.places) return;
    this.set({ ...this.s, places });
    this.announce(`Renamed to ${p.label}.`);
  }

  /** deletes a saved place; focus goes to the row that takes its place, else the one before, else the add row */
  private remove(id: string) {
    const p = this.s.places.find((x) => x.id === id);
    if (!p) return;
    const i = this.savedRows().findIndex((r) => r.dataset.end === id);
    this.set(withoutPlace(this.s, id));
    const rows = this.savedRows();
    const to = rows[Math.min(i, rows.length - 1)];
    (to?.querySelector<HTMLElement>('.cm-del') ?? this.$<HTMLElement>('#cm-add-n')).focus();
    this.announce(`Deleted ${p.label}.`);
  }

  /** Enter in a name: renames (in the add row: on to its place field); Esc puts the saved name back */
  private nameKey(e: KeyboardEvent, inp: HTMLInputElement) {
    const end = inp.dataset.end!;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (end === 'add') this.$<HTMLInputElement>('#cm-add-q').focus();
      else this.rename(end, inp);
    } else if (e.key === 'Escape' && end !== 'add') {
      const p = this.s.places.find((x) => x.id === end);
      if (p && inp.value !== p.label) {
        e.preventDefault();
        e.stopPropagation();
        inp.value = p.label;
      }
    }
  }

  /** a polite note for screen readers (the change itself is plain to see) */
  private announce(text: string) {
    const el = this.$<HTMLElement>('.cm-places-sr');
    el.textContent = '';
    setTimeout(() => (el.textContent = text), 60);
  }

  // ---------------------------------------------------------------- From / To
  /** two radio groups over home, office and the saved places, redrawn only when those change */
  private syncChips() {
    const opts: [string, string][] = [['home', 'Home'], ['office', 'Office'], ...this.s.places.map((p): [string, string] => [p.id, p.label])];
    const key = JSON.stringify(opts);
    for (const which of ['from', 'to'] as const) {
      const box = this.$<HTMLElement>(`.cm-chips[data-which="${which}"]`);
      if (key !== this.chipsFor) box.innerHTML = opts.map(([id, label]) => `<label class="cm-chip"><input type="radio" name="cm-${which}" value="${id}" /><span>${esc(label)}</span></label>`).join('');
      box.querySelectorAll<HTMLInputElement>('input').forEach((r) => (r.checked = r.value === this.s[which]));
      // on a phone each row scrolls sideways: keep the chosen place in view
      const on = box.querySelector('input:checked')?.parentElement;
      if (on && box.scrollWidth > box.clientWidth) {
        const b = box.getBoundingClientRect(), c = on.getBoundingClientRect();
        if (c.left < b.left) box.scrollLeft -= b.left - c.left + 8;
        else if (c.right > b.right) box.scrollLeft += c.right - b.right + 8;
      }
    }
    this.chipsFor = key;
  }

  private pickEnd(which: 'from' | 'to', id: string) {
    const next = chooseEnd(this.s, which, id);
    if (next === this.s) return;
    const swapped = which === 'from' ? next.to !== this.s.to : next.from !== this.s.from;
    this.set(next);
    // picking the place at the other end swapped the two: say so, as the other group changed out of sight
    if (swapped) this.announceTrip();
  }

  private swap() {
    this.set(swapEnds(this.s));
    this.announceTrip();
  }

  private announceTrip() {
    this.announce(`From ${endLabel(this.s, this.s.from)} to ${endLabel(this.s, this.s.to)}.`);
  }

  // ---------------------------------------------------------------- place search (combobox)
  private optionCount() {
    return 2 + this.hits.length;
  }

  private comboKey(e: KeyboardEvent, end: End) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (this.open !== end) this.openList(end);
      const n = this.optionCount();
      this.setActive((this.active + (e.key === 'ArrowDown' ? 1 : n - 1) + n) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this.open === end && this.active >= 0) this.choose(end, this.active, true);
    } else if (e.key === 'Escape' && this.open) {
      e.preventDefault();
      e.stopPropagation();
      this.closeList(true);
    }
  }

  private openList(end: End) {
    if (this.open && this.open !== end) this.closeList(false);
    this.open = end;
    const inp = this.$<HTMLInputElement>(`#cm-${end}-q`);
    const list = this.$<HTMLUListElement>(`#cm-${end}-list`);
    const q = inp.value.trim();
    const typed = q && q !== this.placeText(end);
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
    const inp = this.root.querySelector<HTMLInputElement>(`#cm-${end}-q`);
    const list = this.root.querySelector<HTMLElement>(`#cm-${end}-list`);
    this.open = null;
    this.active = -1;
    this.hits = [];
    if (!inp || !list) return;
    list.hidden = true;
    inp.setAttribute('aria-expanded', 'false');
    inp.removeAttribute('aria-activedescendant');
    if (restore && document.activeElement !== inp) inp.value = this.placeText(end);
  }

  /** an option: the location or a map pick (asked of the view), or a search hit; from the keyboard, focus stays in the field */
  private choose(end: End, i: number, viaKeys = false) {
    const hit = this.hits[i - 2];
    this.closeList(false);
    if (i === 0) return this.h.locate(end);
    if (i === 1) return this.h.pick(end);
    if (!hit) return;
    const inp = this.$<HTMLInputElement>(`#cm-${end}-q`);
    if (!viaKeys) inp.blur();
    this.setEnd(end, hit.label, hit.coord, viaKeys);
  }

  // ---------------------------------------------------------------- messages and results
  say(text: string, tone: 'info' | 'error' = 'info') {
    const m = this.$<HTMLElement>('.cm-msg');
    m.textContent = text;
    m.dataset.tone = tone;
  }

  /**
   * The quiet banner at the top when a re-check changed the advice for the same trip (announced
   * politely); null takes it away. Focus on its dismiss button moves to the chosen route.
   */
  showUpdate(text: string | null) {
    const el = this.$<HTMLElement>('.cm-update');
    const sr = this.$<HTMLElement>('.cm-update-sr');
    if (!text) {
      if (el.hidden) return;
      const had = el.contains(document.activeElement);
      el.hidden = true;
      sr.textContent = '';
      if (had) this.root.querySelector<HTMLElement>('.cm-route[aria-pressed="true"]')?.focus() ?? this.$<HTMLElement>('.cm-dep').focus();
      return;
    }
    this.$<HTMLElement>('.cm-update-t').textContent = text;
    el.hidden = false;
    sr.textContent = text;
  }

  /**
   * Best time to leave: the least risky route's level for each 15-min departure around the chosen one.
   * A tap moves that trip's time there (state, so it is saved and shared like a typed time).
   */
  showLeaveStrip(items: { hhmm: string; level: RiskLevel }[], current: string, leg: Leg['id']) {
    const wrap = this.$<HTMLElement>('.cm-leave-wrap');
    wrap.hidden = items.length < 2;
    this.$<HTMLElement>('.cm-leave').innerHTML = items
      .map(
        (x) =>
          `<li><button type="button" data-at="${x.hhmm}" data-leg="${leg}" data-level="${x.level}" aria-pressed="${x.hhmm === current}" style="--c:${LEVEL_COLOR[x.level]}"><time>${x.hhmm}</time><span class="sr-only">: ${LEVEL_SHORT[x.level]}</span></button></li>`,
      )
      .join('');
  }

  /** the trip switch (only with a way back): "To office 09:00" / "Back home 18:00", or the saved places' names */
  showLegs(ls: Leg[], current: Leg['id'] | null, now: number, dayWord: (t: number, now: number) => string) {
    const el = this.$<HTMLElement>('.cm-legs');
    el.hidden = ls.length < 2;
    el.innerHTML = ls
      .map((l) => {
        const day = dayWord(l.departure, now);
        return `<button type="button" data-leg="${l.id}" aria-pressed="${l.id === current}">${esc(l.id === 'out' ? toWords(l.to) : backWords(l.to))} ${l.hhmm}<span class="sr-only">, ${day}</span></button>`;
      })
      .join('');
  }

  /**
   * Routes A/B/C, each with a line on how it differs from the fastest, and the hotspots met on the
   * chosen one; null hides the result. `covered` false: no rain forecast for the trip yet.
   */
  showRoutes(rs: RouteCandidate[] | null, risks: RouteRisk[], chosen: RouteCandidate['id'] | null, departure: number, hs: Map<string, CommuteHotspot>, advised?: RouteCandidate['id'], covered = true) {
    const res = this.$<HTMLElement>('.cm-result');
    res.hidden = !rs;
    this.$<HTMLElement>('.cm-card').hidden = !rs || !this.h.card;
    if (!rs) return;
    const riskOf = (id: string) => risks.find((r) => r.route === id);
    const nameOf = (id: string) => hs.get(id)?.name ?? id;
    this.$<HTMLElement>('.cm-routes').innerHTML = rs
      .map((r) => {
        const rk = riskOf(r.id);
        const l: RiskLevel = rk?.level ?? 'clear';
        const n = rk?.hits.filter((x) => rank(x.level) > 0).length ?? 0;
        const why = routeReason(r.id, rs, risks, nameOf, covered);
        return `<li><button type="button" class="cm-route" data-route="${r.id}" aria-pressed="${r.id === chosen}">
          <span class="cm-rid" aria-hidden="true">${r.id}</span>
          <span class="cm-rmain"><span class="cm-rtop"><b>${fmtMin(r.durationS)}</b><span>${fmtKm(r.lengthM)}</span>${r.id === advised ? '<span class="cm-tag">Suggested</span>' : ''}</span><span class="cm-via">${esc(r.via)}</span>${why ? `<span class="cm-reason">${esc(why)}</span>` : ''}</span>
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
      .map((s) => {
        const href = safeHref(s.url);
        return `<li><time>${esc(fmtDate(s.date))}</time> ${href ? `<a href="${href}" target="_blank" rel="noopener">${esc(s.outlet)}</a>` : esc(s.outlet)}</li>`;
      })
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
