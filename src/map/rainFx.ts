// Screen-space rain: three parallax layers of angled streaks, a faint cold haze that
// thickens with intensity, and (> 50 mm/hr) a rare, soft lightning flash.
// prefers-reduced-motion: a single static frame of sparse streaks, no flashes.

interface Drop {
  x: number;
  y: number;
  len: number;
  speed: number;
  layer: number;
}

const LAYERS = [
  // far -> near
  { alpha: 0.13, width: 0.7, len: 10, speed: 900, share: 0.52 },
  { alpha: 0.2, width: 0.9, len: 17, speed: 1350, share: 0.33 },
  { alpha: 0.28, width: 1.2, len: 26, speed: 1900, share: 0.15 },
];

export class RainFx {
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private drops: Drop[] = [];
  private intensity = 0;
  private visible = true;
  private raf = 0;
  private last = 0;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private ro: ResizeObserver;
  private mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  private reduced = this.mq.matches;
  private flash = 0; // current flash energy 0..1
  private flashSeq: number[] = []; // pending flash pulse times (ms)
  private nextStrike = 0;
  private wind = 0.2; // dx per dy
  private destroyed = false;

  constructor(container: HTMLElement) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: '2',
      transition: 'opacity 600ms ease',
      opacity: '0',
    });
    this.canvas.setAttribute('aria-hidden', 'true');
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.mq.addEventListener?.('change', this.onMotion);
    document.addEventListener('visibilitychange', this.onVis);
    this.loop = this.loop.bind(this);
  }

  /** Rain rate in mm/hr. 0 = off. Density saturates around 120 mm/hr. */
  setIntensity(mmPerHour: number) {
    const v = Math.max(0, mmPerHour || 0);
    const was = this.intensity;
    this.intensity = v;
    this.syncDrops();
    if (v > 50 && was <= 50) this.nextStrike = performance.now() + 1500 + Math.random() * 4000;
    this.wind = 0.14 + Math.min(0.22, v / 400);
    this.updateOpacity();
    this.kick();
  }

  setVisible(v: boolean) {
    this.visible = v;
    this.updateOpacity();
    this.kick();
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.mq.removeEventListener?.('change', this.onMotion);
    document.removeEventListener('visibilitychange', this.onVis);
    this.canvas.remove();
  }

  // ------------------------------------------------------------------ internals

  private onMotion = () => {
    this.reduced = this.mq.matches;
    this.kick();
  };

  private onVis = () => this.kick();

  private active() {
    return this.visible && this.intensity > 0 && !this.destroyed;
  }

  private updateOpacity() {
    this.canvas.style.opacity = this.active() ? '1' : '0';
  }

  private kick() {
    cancelAnimationFrame(this.raf);
    if (!this.active()) return;
    if (this.reduced) {
      this.drawStatic();
      return;
    }
    if (document.visibilityState === 'hidden') return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  private resize() {
    const r = this.container.getBoundingClientRect();
    this.dpr = Math.min(1.5, window.devicePixelRatio || 1);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.drops = [];
    this.syncDrops();
    if (this.reduced && this.active()) this.drawStatic();
  }

  private targetCount() {
    const v = this.intensity;
    if (v <= 0) return 0;
    // perceptual: light rain is sparse; heavy rain dense but never a white wall
    const k = Math.min(1, Math.log1p(v) / Math.log1p(120));
    const area = (this.w * this.h) / (1600 * 1000);
    return Math.round((60 + 1400 * k * k) * Math.max(0.3, area));
  }

  private spawn(layer: number, anywhere: boolean): Drop {
    const L = LAYERS[layer];
    return {
      x: Math.random() * (this.w + this.h * 0.4) - this.h * 0.3,
      y: anywhere ? Math.random() * this.h : -L.len - Math.random() * this.h * 0.2,
      len: L.len * (0.7 + Math.random() * 0.6),
      speed: L.speed * (0.85 + Math.random() * 0.3),
      layer,
    };
  }

  private syncDrops() {
    const n = this.targetCount();
    const d = this.drops;
    if (d.length > n) d.length = n;
    while (d.length < n) {
      const r = Math.random();
      const layer = r < LAYERS[0].share ? 0 : r < LAYERS[0].share + LAYERS[1].share ? 1 : 2;
      d.push(this.spawn(layer, true));
    }
  }

  private loop(t: number) {
    if (!this.active() || this.reduced || document.visibilityState === 'hidden') return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, (t - this.last) / 1000);
    if (dt < 1 / 61) return;
    this.last = t;
    this.step(dt, t);
    this.draw();
  }

  private step(dt: number, t: number) {
    const wind = this.wind;
    for (const p of this.drops) {
      const dy = p.speed * dt;
      p.y += dy;
      p.x += dy * wind;
      if (p.y - p.len > this.h || p.x > this.w + 40) {
        const np = this.spawn(p.layer, false);
        p.x = np.x;
        p.y = np.y;
        p.len = np.len;
        p.speed = np.speed;
      }
    }
    // lightning: only for intense convective rain, rare and soft
    if (this.intensity > 50) {
      if (t >= this.nextStrike) {
        const base = t;
        // double/triple flicker like a real return stroke
        this.flashSeq = [base, base + 90 + Math.random() * 60];
        if (Math.random() < 0.5) this.flashSeq.push(base + 260 + Math.random() * 120);
        const rate = Math.min(1, (this.intensity - 50) / 70);
        this.nextStrike = t + (14000 - rate * 8000) * (0.6 + Math.random() * 0.8);
      }
    }
    while (this.flashSeq.length && t >= this.flashSeq[0]) {
      this.flashSeq.shift();
      this.flash = Math.max(this.flash, 0.55 + Math.random() * 0.45);
    }
    this.flash *= Math.exp(-dt * 7);
    if (this.flash < 0.01) this.flash = 0;
  }

  private draw() {
    const c = this.ctx;
    const dpr = this.dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    const k = Math.min(1, this.intensity / 100);

    // cold haze, heavier toward the top (looking into the storm), plus a soft vignette
    const haze = c.createLinearGradient(0, 0, 0, this.h);
    haze.addColorStop(0, `rgba(120,150,190,${0.05 + 0.13 * k})`);
    haze.addColorStop(0.55, `rgba(70,95,130,${0.02 + 0.05 * k})`);
    haze.addColorStop(1, 'rgba(10,20,35,0)');
    c.fillStyle = haze;
    c.fillRect(0, 0, this.w, this.h);

    const wind = this.wind;
    c.lineCap = 'round';
    const lit = 1 + this.flash * 1.6;
    for (let l = 0; l < LAYERS.length; l++) {
      const L = LAYERS[l];
      c.strokeStyle = `rgba(200,225,255,${Math.min(0.9, L.alpha * (0.75 + 0.5 * k) * lit)})`;
      c.lineWidth = L.width;
      c.beginPath();
      for (const p of this.drops) {
        if (p.layer !== l) continue;
        c.moveTo(p.x, p.y);
        c.lineTo(p.x - p.len * wind, p.y - p.len);
      }
      c.stroke();
    }

    if (this.flash > 0) {
      const f = this.flash;
      const g = c.createRadialGradient(this.w * 0.3, -this.h * 0.1, 0, this.w * 0.3, -this.h * 0.1, this.h * 1.4);
      g.addColorStop(0, `rgba(215,225,255,${0.32 * f})`);
      g.addColorStop(0.5, `rgba(170,190,255,${0.14 * f})`);
      g.addColorStop(1, `rgba(120,140,220,${0.04 * f})`);
      c.fillStyle = g;
      c.fillRect(0, 0, this.w, this.h);
    }
  }

  private drawStatic() {
    // reduced motion: one quiet still frame, no flashes
    this.flash = 0;
    this.draw();
  }
}
