// "Reported flood spots": the news-report spots of the region on screen as a sidebar list, so the
// keyboard and screen readers reach what the map only draws (src/map/newsLayer.ts). One Tab stop:
// the arrow keys, Home and End move between spots; Enter or Space shows one on the map with the
// card a tap on its circle opens, and focus stays in the list (Esc closes the card, src/ui/layout.ts).
import type { NewsSpot } from '../commute/spots';
import { NEWS_COLOR, reportLine } from '../map/newsLayer';
import type { Sidebar } from './sidebar';
import { esc } from './format';

/** rows shown until "Show all" */
const FEW = 8;

export class SpotList {
  private sb: Sidebar;
  private spots: NewsSpot[] = [];
  private all = false;
  /** the row holding the list's one Tab stop */
  private at = 0;
  private ul!: HTMLUListElement;
  private more!: HTMLButtonElement;

  /** The section stays hidden until set() brings spots, and with none. */
  constructor(sb: Sidebar) {
    this.sb = sb;
    sb.setHidden('spots', true);
  }

  /** List the region's spots; `onPick` runs on Enter, Space or a click. */
  set(spots: NewsSpot[], onPick: (s: NewsSpot) => void) {
    if (!spots.length) return;
    // most flood days reported first, then the most recent
    this.spots = [...spots].sort((a, b) => b.count - a.count || b.lastYear - a.lastYear || a.name.localeCompare(b.name));
    this.at = 0;
    this.sb.setHidden('spots', false);
    this.sb.setSummary('spots', `${spots.length} spot${spots.length === 1 ? '' : 's'}`);
    const body = this.sb.body('spots');
    body.innerHTML = `<div class="spots">
      <p class="sec-lede">Places named in news reports of flooding, most reported first. Pick one to see it on the map.</p>
      <ul class="spot-list" style="--c:${NEWS_COLOR}"></ul>
      <button type="button" class="spot-more"></button>
    </div>`;
    // listeners on the list, never on the section body: that outlives the region
    const ul = (this.ul = body.querySelector('.spot-list') as HTMLUListElement);
    this.more = body.querySelector('.spot-more') as HTMLButtonElement;
    ul.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.spot-row');
      if (!b) return;
      this.move(Number(b.dataset.i), false);
      onPick(this.spots[Number(b.dataset.i)]);
    });
    ul.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const last = ul.children.length - 1;
      const cur = Number((e.target as HTMLElement).closest<HTMLElement>('.spot-row')?.dataset.i ?? this.at);
      const to: Record<string, number> = { ArrowDown: Math.min(last, cur + 1), ArrowUp: Math.max(0, cur - 1), Home: 0, End: last };
      if (!Object.hasOwn(to, e.key)) return;
      e.preventDefault();
      this.move(to[e.key]);
    });
    this.more.addEventListener('click', () => {
      this.all = !this.all;
      this.render();
    });
    this.render();
  }

  private render() {
    const shown = this.all ? this.spots : this.spots.slice(0, FEW);
    this.at = Math.min(this.at, shown.length - 1);
    this.ul.innerHTML = shown
      .map(
        (s, i) => `<li><button type="button" class="spot-row" data-i="${i}" tabindex="${i === this.at ? 0 : -1}" aria-label="${esc(`${s.name}. ${reportLine(s)}`)}">
          <i class="spot-dot${s.kind === 'underpass' ? ' ring' : ''}" aria-hidden="true"></i>
          <span class="spot-name"><b>${esc(s.name)}</b><span>${esc(reportLine(s))}</span></span>
        </button></li>`,
      )
      .join('');
    this.more.hidden = this.spots.length <= FEW;
    this.more.textContent = this.all ? 'Show fewer' : `Show all ${this.spots.length}`;
  }

  /** move the Tab stop (roving tabindex) to row i, and focus it */
  private move(i: number, focus = true) {
    const rows = this.ul.querySelectorAll<HTMLButtonElement>('.spot-row');
    if (!rows[i]) return;
    rows[this.at]?.setAttribute('tabindex', '-1');
    rows[i].tabIndex = 0;
    this.at = i;
    if (focus) rows[i].focus();
  }
}
