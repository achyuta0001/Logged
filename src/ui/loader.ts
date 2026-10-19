/** no step for this long: the loader offers Reload (loading carries on, and hides as usual if it ends) */
const STALL_MS = 20000;

export class Loader {
  private el: HTMLElement;
  private bar: HTMLElement;
  private msg: HTMLElement;
  private pct: HTMLElement;
  /** Reload button (index.html): shown on error, and after STALL_MS without progress */
  private reload: HTMLButtonElement | null;
  private stall = 0;
  constructor() {
    this.el = document.getElementById('loader')!;
    this.bar = this.el.querySelector('.ld-bar i') as HTMLElement;
    this.msg = this.el.querySelector('.ld-msg') as HTMLElement;
    this.pct = this.el.querySelector('.ld-pct') as HTMLElement;
    this.reload = this.el.querySelector<HTMLButtonElement>('.ld-reload');
    this.reload?.addEventListener('click', () => location.reload());
  }
  set(frac: number, msg?: string) {
    const p = Math.max(0, Math.min(1, frac));
    this.bar.style.transform = `scaleX(${p})`;
    this.pct.textContent = `${Math.round(p * 100)}%`;
    if (msg) this.msg.textContent = msg;
    this.watch();
  }
  /** big label + name line (pincode and locality, or the district) */
  setTitle(big: string, name: string) {
    (this.el.querySelector('.ld-pin') as HTMLElement).textContent = big;
    (this.el.querySelector('.ld-name') as HTMLElement).textContent = name;
  }
  show(msg: string) {
    this.el.classList.remove('done', 'error');
    this.el.classList.add('overlay');
    this.set(0, msg);
  }
  hide() {
    this.el.classList.add('done');
    this.watch();
  }
  error(msg: string) {
    this.el.classList.add('error');
    this.msg.textContent = msg;
    clearTimeout(this.stall);
    if (this.reload) this.reload.hidden = false;
  }
  /** (re)start the stall timer while the loader is up; hide Reload until it runs out */
  private watch() {
    clearTimeout(this.stall);
    if (this.reload) this.reload.hidden = true;
    const idle = () => this.el.classList.contains('done') || this.el.classList.contains('error');
    if (idle()) return;
    this.stall = window.setTimeout(() => {
      if (idle()) return;
      this.msg.textContent = `${this.msg.textContent ?? ''} · taking longer than usual`;
      if (this.reload) this.reload.hidden = false;
    }, STALL_MS);
  }
}
