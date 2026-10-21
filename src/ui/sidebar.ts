// The one left sidebar: a header that answers "will it flood?", then collapsible sections.
// Minimises to a slim icon rail (desktop/tablet) and becomes a bottom sheet on phones.
import type { Severity } from '../types';
import { SEVERITY_COLOR } from '../map/colors';
import { iconSvg } from './icons';
import { load, save } from './store';

export type SectionId = 'commute' | 'city' | 'place' | 'impact' | 'rain' | 'map' | 'story' | 'spots' | 'drainage' | 'sources';
/** what the sidebar is showing: the Bengaluru Urban overview, one pincode, or the Commute tab */
export type Scope = 'city' | 'pin' | 'commute';
/** the two views at the top of the sidebar */
export type Tab = 'explore' | 'commute';
export type Mode = 'phone' | 'tablet' | 'desktop';
/** phone bottom-sheet detents */
export type Detent = 'peek' | 'half' | 'full';

interface SectionDef {
  id: SectionId;
  title: string;
  icon: string;
  /** open on a first visit */
  open: boolean;
  /** shown only in this scope (default: the pincode view); 'explore': the city overview and a pincode; 'both': everywhere */
  scope?: Scope | 'explore' | 'both';
}

export const SECTIONS: SectionDef[] = [
  { id: 'commute', title: 'My commute', icon: 'commute', open: true, scope: 'commute' },
  { id: 'city', title: 'Pincodes', icon: 'flood', open: true, scope: 'city' },
  { id: 'place', title: 'Your place', icon: 'pin', open: false },
  { id: 'impact', title: 'Impact', icon: 'alert', open: true },
  { id: 'rain', title: 'Rain', icon: 'rain', open: true },
  { id: 'map', title: 'Map layers', icon: 'layers', open: false },
  { id: 'story', title: 'Why RR Nagar floods', icon: 'book', open: false },
  { id: 'spots', title: 'Reported flood spots', icon: 'news', open: false, scope: 'explore' },
  { id: 'drainage', title: 'Drainage assumptions', icon: 'sliders', open: false },
  { id: 'sources', title: 'Sources and licences', icon: 'info', open: false, scope: 'both' },
];

export interface SidebarHandlers {
  onTour(): void;
  onFocus(): void;
  /** the one-line status was clicked: jump to the hour it talks about */
  onStatus(): void;
  /** the sidebar's footprint on the map changed (rail, mode, phone peek height) */
  onFootprint(): void;
  /** "Bengaluru Urban" back button in a pincode view */
  onBack?(): void;
  /** the Explore | Commute switch at the top */
  onTab?(tab: Tab): void;
}

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** the status reads green when nothing floods */
const statusColor = (sev: Severity) => (sev === 'none' ? '#30d158' : SEVERITY_COLOR[sev] ?? SEVERITY_COLOR.none);

/**
 * Show or hide the "Your place" section. It also follows #place-mount automatically:
 * hidden while the mount is empty, shown as soon as something is mounted into it.
 */
export function showPlaceSection(show = true): void {
  document.getElementById('sec-place')?.toggleAttribute('hidden', !show);
  document.querySelector('.rail [data-rail="place"]')?.toggleAttribute('hidden', !show);
}

export class Sidebar {
  readonly panel: HTMLElement;
  readonly rail: HTMLElement;
  private h: SidebarHandlers;
  private mode: Mode = 'desktop';
  private railed = false;
  private sheet: Detent = 'peek';
  private scroller: HTMLElement;
  private head: HTMLElement;
  private peek = 0;
  private live: HTMLElement;
  private liveTimer = 0;
  private said = '';

  constructor(panel: HTMLElement, rail: HTMLElement, h: SidebarHandlers) {
    this.panel = panel;
    this.rail = rail;
    this.h = h;
    panel.innerHTML = `
      <div class="sb-grip" aria-hidden="true"><i></i></div>
      <header class="sb-head">
        <nav class="sb-tabs" aria-label="View"><a href="?" data-tab="explore" aria-current="page">Explore</a><a href="?commute=1" data-tab="commute">Commute</a></nav>
        <button class="sb-back" id="sb-back" type="button" hidden aria-label="Back to the Bengaluru Urban overview">${iconSvg('chevron', 12, 2)}<span>Bengaluru Urban</span></button>
        <div class="sb-top">
          <div class="sb-pin" title="Pincode 560098">560098</div>
          <div class="sb-tools">
            <button class="capsule-btn tinted tour-btn" id="tour-btn" type="button" aria-label="Start the guided tour">${iconSvg('play', 11)}<span>Tour</span></button>
            <button class="icon-btn" id="focus-btn" type="button" aria-label="Focus on the map (H)" aria-keyshortcuts="H" data-tip="Focus on the map · H">${iconSvg('focus', 16)}</button>
            <button class="icon-btn" id="sb-min" type="button" aria-controls="sidebar" aria-expanded="true" aria-label="Minimise the sidebar ([)" aria-keyshortcuts="[" data-tip="Minimise · [">${iconSvg('panel_close', 17)}</button>
          </div>
        </div>
        <div class="sb-name">Rajarajeshwari Nagar, Bengaluru</div>
        <button class="sb-status" id="sb-status" type="button" data-sev="none" disabled>
          <i class="sb-dot" aria-hidden="true"></i><span class="sb-answer">Working out the flood outlook</span>
        </button>
        <div class="sb-context" id="sb-context"></div>
        <div class="sb-range" id="sb-range" hidden></div>
        <p class="sb-caveat" id="sb-caveat" hidden></p>
      </header>
      <div class="sb-scroll" id="sb-scroll">
        ${SECTIONS.map(
          (s) => `<section class="sb-sec" id="sec-${s.id}" data-sec="${s.id}"${s.id === 'place' ? ' hidden' : ''}>
            <h2 class="sb-h"><button type="button" class="sb-toggle" id="sec-${s.id}-btn" aria-expanded="false" aria-controls="sec-${s.id}-body">
              <span class="sb-ico">${iconSvg(s.icon, 16)}</span><span class="sb-title">${s.title}</span><span class="sb-sum" data-sum></span><span class="sb-chev">${iconSvg('chevron', 14, 1.8)}</span>
            </button></h2>
            <div class="sb-body" id="sec-${s.id}-body" role="region" aria-labelledby="sec-${s.id}-btn"><div class="sb-inner"><div class="sb-content">${
              s.id === 'place' ? '<div id="place-mount"></div>' : ''
            }</div></div></div>
          </section>`,
        ).join('')}
      </div>`;
    rail.innerHTML = `
      <button class="rail-btn rail-expand" type="button" data-act="expand" aria-controls="sidebar" aria-expanded="false" aria-keyshortcuts="[" aria-label="Show the sidebar  [">${iconSvg('panel_open', 18)}</button>
      <span class="rail-sep" aria-hidden="true"></span>
      ${SECTIONS.map(
        (s) => `<button class="rail-btn" type="button" data-rail="${s.id}" aria-label="${s.title}"${s.id === 'place' ? ' hidden' : ''}>${iconSvg(s.icon, 18)}${s.id === 'impact' ? '<i class="rail-dot" aria-hidden="true"></i>' : ''}</button>`,
      ).join('')}
      <span class="rail-fill"></span>
      <button class="rail-btn" type="button" data-act="tour" aria-label="Guided tour">${iconSvg('play', 13)}</button>
      <button class="rail-btn" type="button" data-act="focus" aria-keyshortcuts="H" aria-label="Focus on the map  H">${iconSvg('focus', 18)}</button>`;

    this.scroller = panel.querySelector('#sb-scroll') as HTMLElement;
    this.head = panel.querySelector('.sb-head') as HTMLElement;
    // the outlook is announced politely when it settles; outside the panel, which goes inert when minimised
    this.live = document.createElement('p');
    this.live.className = 'sr-only';
    this.live.setAttribute('role', 'status');
    this.live.setAttribute('aria-live', 'polite');
    document.body.appendChild(this.live);

    for (const s of SECTIONS) this.setOpen(s.id, load(`sec.${s.id}`, s.open), false);
    this.scroller.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.sb-toggle');
      if (!b) return;
      const id = b.closest<HTMLElement>('.sb-sec')!.dataset.sec as SectionId;
      this.setOpen(id, !this.isOpen(id));
    });
    rail.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.rail-btn');
      if (!b) return;
      if (b.dataset.rail) this.reveal(b.dataset.rail as SectionId);
      else if (b.dataset.act === 'expand') this.setMinimised(false);
      else if (b.dataset.act === 'tour') h.onTour();
      else if (b.dataset.act === 'focus') h.onFocus();
    });
    panel.querySelector('#tour-btn')!.addEventListener('click', () => h.onTour());
    panel.querySelector('#focus-btn')!.addEventListener('click', () => h.onFocus());
    panel.querySelector('#sb-min')!.addEventListener('click', () => this.toggle());
    panel.querySelector('#sb-status')!.addEventListener('click', () => h.onStatus());
    panel.querySelector('#sb-back')!.addEventListener('click', () => h.onBack?.());
    (panel.querySelector('.sb-tabs') as HTMLElement).addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-tab]');
      if (!a || !h.onTab || e.metaKey || e.ctrlKey || e.shiftKey) return; // modified clicks open a new tab as usual
      e.preventDefault();
      if (a.getAttribute('aria-current') !== 'page') h.onTab(a.dataset.tab as Tab);
    });

    // "Your place" stays hidden until something is mounted into it
    const mount = panel.querySelector('#place-mount') as HTMLElement;
    new MutationObserver(() => showPlaceSection(mount.childElementCount > 0)).observe(mount, { childList: true });

    this.wireSheet();
    new ResizeObserver(() => this.measurePeek()).observe(this.head);
  }

  // ---------- region ----------
  private scope: Scope = 'pin';

  /** Header for the current region: big label (pincode or "Bengaluru"), a name line, and a back button. */
  setRegion(big: string, name: string, opts: { title?: string; back?: boolean; tour?: boolean } = {}) {
    const pin = this.panel.querySelector('.sb-pin') as HTMLElement;
    pin.textContent = big;
    pin.title = opts.title ?? (/^\d{6}$/.test(big) ? `Pincode ${big}` : big);
    pin.classList.toggle('word', !/^\d+$/.test(big));
    (this.panel.querySelector('.sb-name') as HTMLElement).textContent = name;
    (this.panel.querySelector('#sb-back') as HTMLElement).hidden = !opts.back;
    (this.panel.querySelector('#tour-btn') as HTMLElement).hidden = opts.tour === false;
    (this.rail.querySelector('[data-act="tour"]') as HTMLElement).hidden = opts.tour === false;
  }

  /** Show the sections of one scope (city overview or pincode) and hide the rest. */
  setScope(scope: Scope) {
    this.scope = scope;
    for (const s of SECTIONS) {
      const on = s.scope === 'both' || (s.scope === 'explore' ? scope !== 'commute' : (s.scope ?? 'pin') === scope);
      const sec = this.panel.querySelector(`#sec-${s.id}`) as HTMLElement;
      const rb = this.rail.querySelector(`[data-rail="${s.id}"]`) as HTMLElement;
      sec.classList.toggle('off-scope', !on);
      rb.classList.toggle('off-scope', !on);
    }
    document.body.classList.toggle('scope-city', scope === 'city');
    document.body.classList.toggle('scope-commute', scope === 'commute');
    this.setTab(scope === 'commute' ? 'commute' : 'explore');
    this.measurePeek();
  }

  /** Mark the current view in the Explore | Commute switch. */
  setTab(tab: Tab) {
    this.panel.querySelectorAll<HTMLAnchorElement>('.sb-tabs a').forEach((a) => {
      if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  get currentScope(): Scope {
    return this.scope;
  }

  /** The prediction range across weather models, one secondary line under the status context; empty hides it. */
  setRange(text: string) {
    const el = this.panel.querySelector('#sb-range') as HTMLElement;
    if (el.textContent === text && el.hidden === !text) return;
    el.textContent = text;
    el.hidden = !text;
    this.measurePeek();
  }

  /** One quiet line under the status (e.g. inflow from outside the modelled area); null hides it. */
  setCaveat(text: string | null, tip?: string) {
    const el = this.panel.querySelector('#sb-caveat') as HTMLElement;
    el.hidden = !text;
    el.innerHTML = text ? `${iconSvg('info', 12)}<span>${text}</span>` : '';
    if (tip) el.title = tip;
    else el.removeAttribute('title');
    this.measurePeek();
  }

  setTitle(id: SectionId, title: string) {
    (this.panel.querySelector(`#sec-${id} .sb-title`) as HTMLElement).textContent = title;
    this.rail.querySelector(`[data-rail="${id}"]`)?.setAttribute('aria-label', title);
  }

  /** Hide a section in the current scope (e.g. no sourced story for this pincode). */
  setHidden(id: SectionId, hidden: boolean) {
    this.panel.querySelector(`#sec-${id}`)?.classList.toggle('empty', hidden);
    this.rail.querySelector(`[data-rail="${id}"]`)?.classList.toggle('empty', hidden);
  }

  /** Empty every section body except the Your-place mount (between regions). */
  clearBodies() {
    for (const s of SECTIONS) {
      const b = this.body(s.id);
      if (s.id === 'place') continue;
      b.replaceChildren();
      this.setSummary(s.id, '');
    }
  }

  // ---------- sections ----------
  body(id: SectionId): HTMLElement {
    return this.panel.querySelector(`#sec-${id} .sb-content`) as HTMLElement;
  }

  isOpen(id: SectionId): boolean {
    return this.panel.querySelector(`#sec-${id}`)!.classList.contains('open');
  }

  setOpen(id: SectionId, open: boolean, persist = true) {
    const sec = this.panel.querySelector(`#sec-${id}`) as HTMLElement;
    sec.classList.toggle('open', open);
    sec.querySelector('.sb-toggle')!.setAttribute('aria-expanded', String(open));
    if (persist) save(`sec.${id}`, open);
  }

  /** Short text shown on a section's header while it is collapsed. */
  setSummary(id: SectionId, text: string) {
    const el = this.panel.querySelector(`#sec-${id} [data-sum]`) as HTMLElement;
    if (el.textContent !== text) el.textContent = text;
  }

  /** Expand the sidebar, open a section and scroll to it. */
  reveal(id: SectionId) {
    if (id === 'place') showPlaceSection(true);
    this.setMinimised(false);
    this.setOpen(id, true);
    const sec = this.panel.querySelector(`#sec-${id}`) as HTMLElement;
    requestAnimationFrame(() => {
      this.scroller.scrollTo({ top: Math.max(0, sec.offsetTop - 2), behavior: reduced() ? 'auto' : 'smooth' });
      (sec.querySelector('.sb-toggle') as HTMLElement).focus({ preventScroll: true });
    });
  }

  // ---------- status ----------
  setStatus(sev: Severity, html: string, context: string, jumpLabel?: string, color?: string) {
    const st = this.panel.querySelector('#sb-status') as HTMLButtonElement;
    st.dataset.sev = sev;
    st.style.setProperty('--c', color ?? statusColor(sev));
    st.querySelector('.sb-answer')!.innerHTML = html;
    st.disabled = !jumpLabel;
    const plain = st.textContent?.trim() ?? '';
    if (jumpLabel) {
      st.setAttribute('aria-label', `${plain}. ${jumpLabel}`);
      st.dataset.tip = jumpLabel;
    } else {
      st.removeAttribute('aria-label');
      delete st.dataset.tip;
    }
    (this.panel.querySelector('#sb-context') as HTMLElement).textContent = context;
    // one announcement per settled outlook: quick successive updates collapse into the last one
    clearTimeout(this.liveTimer);
    const say = [plain, context].filter(Boolean).join('. ');
    this.liveTimer = window.setTimeout(() => {
      if (say === this.said) return;
      this.said = say;
      this.live.textContent = say;
    }, 700);
    const dot = this.rail.querySelector('.rail-dot') as HTMLElement;
    dot.style.background = statusColor(sev);
    dot.dataset.sev = sev;
    this.rail.querySelector('[data-rail="impact"]')!.setAttribute('aria-label', `Impact: ${plain}`);
  }

  // ---------- minimise: rail on desktop/tablet, peek on phones ----------
  setMode(mode: Mode) {
    if (mode === this.mode && this.panel.dataset.mode) return;
    this.mode = mode;
    this.panel.dataset.mode = mode;
    // tablets start on the rail (the sidebar overlays the map there); desktops remember
    this.railed = mode === 'tablet' ? true : mode === 'desktop' ? load('sb.rail', false) : false;
    this.sheet = 'peek';
    this.apply();
    this.measurePeek();
  }

  get minimised(): boolean {
    return this.mode === 'phone' ? this.sheet === 'peek' : this.railed;
  }

  /** Phones: move the sheet to a detent. */
  setSheet(d: Detent) {
    if (d === this.sheet) return;
    this.sheet = d;
    this.apply();
  }

  setMinimised(m: boolean, detent: Detent = 'full') {
    if (m === this.minimised) return;
    if (this.mode === 'phone') return this.setSheet(m ? 'peek' : detent);
    this.railed = m;
    if (this.mode === 'desktop') save('sb.rail', m);
    // keep keyboard focus somewhere visible
    const active = document.activeElement as HTMLElement | null;
    this.apply();
    if (active && (m ? this.panel : this.rail).contains(active)) {
      const target = m ? this.rail.querySelector<HTMLElement>('[data-act="expand"]') : this.panel.querySelector<HTMLElement>('#sb-min');
      target?.focus({ preventScroll: true });
    }
    if (this.mode === 'desktop') this.h.onFootprint();
  }

  toggle() {
    this.setMinimised(!this.minimised);
  }

  /** Narrow screens: get out of the way (rail on tablets, peek on phones). */
  getOutOfTheWay() {
    if (this.mode !== 'desktop') this.setMinimised(true);
  }

  private apply() {
    const b = document.body;
    b.classList.toggle('sb-rail', this.mode !== 'phone' && this.railed);
    const phone = this.mode === 'phone';
    b.classList.toggle('sheet-half', phone && this.sheet === 'half');
    b.classList.toggle('sheet-full', phone && this.sheet === 'full');
    const min = this.panel.querySelector('#sb-min') as HTMLButtonElement;
    const label = phone ? (this.sheet === 'full' ? 'Collapse the panel' : 'Expand the panel') : 'Minimise the sidebar ([)';
    min.setAttribute('aria-label', label);
    min.dataset.tip = phone ? '' : 'Minimise · [';
    min.setAttribute('aria-expanded', String(!this.minimised));
    min.innerHTML = phone ? iconSvg('chevron', 16, 1.8) : iconSvg('panel_close', 17);
    // nothing hidden off-screen should be reachable with Tab
    this.scroller.inert = phone && this.sheet === 'peek';
    this.panel.inert = !phone && this.railed;
    this.rail.inert = phone || !this.railed;
  }

  // ---------- phone bottom sheet ----------
  /** Height of the peeking sheet (grip + header), px. 0 when not on a phone. */
  get peekHeight(): number {
    return this.mode === 'phone' ? this.peek : 0;
  }

  private measurePeek() {
    if (this.mode !== 'phone') return;
    const grip = this.panel.querySelector('.sb-grip') as HTMLElement;
    const px = Math.ceil(grip.offsetHeight + this.head.offsetHeight + 4);
    if (Math.abs(px - this.peek) < 1) return;
    this.peek = px;
    document.documentElement.style.setProperty('--peek', `${px}px`);
    this.h.onFootprint();
  }

  private wireSheet() {
    const grip = this.panel.querySelector('.sb-grip') as HTMLElement;
    const order: Detent[] = ['peek', 'half', 'full'];
    let drag: { y: number; y0: number; t: number; v: number; from: Detent; pos: Record<Detent, number> } | null = null;
    let dy = 0;
    const positions = (): Record<Detent, number> => {
      const h = this.panel.offsetHeight;
      const half = Math.min(h - this.peek, Math.max(0, h - window.innerHeight * 0.52));
      return { full: 0, half, peek: Math.max(0, h - this.peek) };
    };
    const down = (e: PointerEvent) => {
      if (this.mode !== 'phone' || e.button > 0) return;
      if ((e.target as HTMLElement).closest('button, a, input, select, textarea')) return;
      const pos = positions();
      drag = { y: e.clientY, y0: pos[this.sheet], t: performance.now(), v: 0, from: this.sheet, pos };
      dy = 0;
      this.panel.classList.add('dragging');
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      const now = performance.now();
      const ndy = e.clientY - drag.y;
      drag.v = (ndy - dy) / Math.max(1, now - drag.t); // px/ms, + is downwards
      drag.t = now;
      dy = ndy;
      const y = Math.max(0, Math.min(drag.pos.peek, drag.y0 + dy));
      this.panel.style.transform = `translateY(${y}px)`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!drag) return;
      const d = drag;
      drag = null;
      this.panel.classList.remove('dragging');
      this.panel.style.transform = '';
      let to: Detent;
      if (Math.abs(dy) < 6) to = order[(order.indexOf(d.from) + 1) % order.length]; // tap cycles peek > half > full > peek
      else if (Math.abs(d.v) > 0.6) to = order[Math.max(0, Math.min(2, order.indexOf(d.from) + (d.v < 0 ? 1 : -1)))]; // flick
      else {
        const y = Math.max(0, Math.min(d.pos.peek, d.y0 + dy));
        to = order.reduce((a, b) => (Math.abs(d.pos[b] - y) < Math.abs(d.pos[a] - y) ? b : a));
      }
      this.setSheet(to);
    };
    grip.addEventListener('pointerdown', down);
    this.head.addEventListener('pointerdown', down);
  }
}
