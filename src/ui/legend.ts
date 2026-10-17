// Compact map key: a depth ramp by default, expanding to the full key
// (roads, buildings, places, reported floods). Lives with the map's own controls.
import type { IControl } from 'maplibre-gl';
import { DEPTH_LEGEND } from '../map/colors';
import { iconSvg } from './icons';
import { load, save } from './store';

export class Legend implements IControl {
  private el: HTMLElement;

  constructor() {
    const el = document.createElement('div');
    el.className = 'maplibregl-ctrl legend';
    el.innerHTML = `
      <button type="button" class="lg-toggle" aria-expanded="false" aria-controls="lg-key" aria-label="Map key: water depth from 2 centimetres to over 1 metre. Show the full key">
        <span class="lg-cap">Water</span><span class="lg-s">2 cm</span><i class="lg-ramp" style="background:linear-gradient(90deg,${DEPTH_LEGEND.map((l) => l.color).join(',')})"></i><span class="lg-s">1 m+</span>${iconSvg('chevron', 12, 1.8)}
      </button>
      <div class="lg-key" id="lg-key" hidden>
        <ul class="lg-depth">${DEPTH_LEGEND.map((l) => `<li><i style="background:${l.color}"></i>${l.label}</li>`).join('')}</ul>
        <ul class="lg-rows">
          <li><i class="lg-line" style="--c:#ffc24d"></i>Road shut to two-wheelers <span>&gt; 15 cm</span></li>
          <li><i class="lg-line" style="--c:#ff8a2a"></i>Road shut to cars <span>&gt; 30 cm</span></li>
          <li><i class="lg-line" style="--c:#ff4458"></i>Road shut to buses <span>&gt; 50 cm</span></li>
          <li><i class="lg-bld"></i>Building with water inside</li>
          <li><i class="lg-fac">${iconSvg('school', 10, 2.2)}</i>Place cut off by water</li>
          <li><i class="lg-ring"></i>Flood reported here before</li>
        </ul>
      </div>`;
    this.el = el;
    const btn = el.querySelector('.lg-toggle') as HTMLButtonElement;
    const set = (open: boolean) => {
      btn.setAttribute('aria-expanded', String(open));
      (el.querySelector('#lg-key') as HTMLElement).hidden = !open;
      el.classList.toggle('open', open);
    };
    set(load('legend.open', false));
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') !== 'true';
      set(open);
      save('legend.open', open);
    });
  }

  onAdd(): HTMLElement {
    return this.el;
  }

  onRemove(): void {
    this.el.remove();
  }
}
