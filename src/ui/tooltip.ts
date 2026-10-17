export class Tooltip {
  private el: HTMLElement;
  constructor() {
    this.el = document.getElementById('tip')!;
  }
  show(x: number, y: number, html: string) {
    const el = this.el;
    el.innerHTML = html;
    el.hidden = false;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x + 16;
    let top = y + 16;
    if (left + r.width > vw - 8) left = x - r.width - 16;
    if (top + r.height > vh - 8) top = y - r.height - 16;
    el.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, top)}px)`;
  }
  hide() {
    this.el.hidden = true;
  }
}
