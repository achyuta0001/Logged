export class Loader {
  private el: HTMLElement;
  private bar: HTMLElement;
  private msg: HTMLElement;
  private pct: HTMLElement;
  constructor() {
    this.el = document.getElementById('loader')!;
    this.bar = this.el.querySelector('.ld-bar i') as HTMLElement;
    this.msg = this.el.querySelector('.ld-msg') as HTMLElement;
    this.pct = this.el.querySelector('.ld-pct') as HTMLElement;
  }
  set(frac: number, msg?: string) {
    const p = Math.max(0, Math.min(1, frac));
    this.bar.style.transform = `scaleX(${p})`;
    this.pct.textContent = `${Math.round(p * 100)}%`;
    if (msg) this.msg.textContent = msg;
  }
  show(msg: string) {
    this.el.classList.remove('done');
    this.el.classList.add('overlay');
    this.set(0, msg);
  }
  hide() {
    this.el.classList.add('done');
  }
  error(msg: string) {
    this.el.classList.add('error');
    this.msg.textContent = msg;
  }
}
