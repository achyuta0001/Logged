// Cinematic flood-water overlay. Drop-in upgrade for FloodLayer.
//
// The depth grid is bilinearly up-sampled (default 3x) once per setDepth() into a set of
// per-pixel static attributes (base colour, slope normal, rim/foam weight, flow coords).
// Each animation frame then only touches wet pixels: two scrolling tileable ripple
// height-fields perturb the normal, a 2D shading LUT turns that into diffuse + specular,
// foam sparkles on the wet/dry rim and elongated streaks drift along the D8 flow field.
// The result is drawn into a maplibre `canvas` source (draped on terrain), with a soft
// pre-blurred glow halo underneath. Upload happens once per rendered frame (play/pause),
// so the map is not forced into continuous repaint by the source itself.
import type { Map as MLMap, CanvasSource } from 'maplibre-gl';
import type { TerrainMeta } from '../types';
import { DEPTH_LUT, DEPTH_LUT_MAX } from './colors';
import { beforeLabels } from './mapView';

export interface WaterFxOptions {
  /** up-sampling factor over the grid (2..4). Default 3. */
  scale?: number;
  /** animation frame rate cap. Default 30. */
  fps?: number;
  /** maplibre source/layer id. Default 'flood' (same as FloodLayer). */
  id?: string;
  /** layer to insert beneath. Default: basemap labels anchor. */
  beforeId?: string;
}

export interface WaterFxStats {
  /** moving average of per-frame CPU time (ms), pixel shading + canvas blits */
  frameMs: number;
  /** last setDepth() precompute time (ms) */
  prepMs: number;
  wetPixels: number;
  width: number;
  height: number;
}

const NOISE = 256; // tileable texture size (power of two)
const NMASK = NOISE - 1;
const FLOW_CYCLE = 1.6; // s per flow-map phase
const FLOW_DIST = 28; // hi-res px travelled per phase
const SH = 128; // shading LUT resolution per axis
const SLOPE_Q = 24; // normal units: slope 1.0 == 24

// D8: 0=E,1=SE,2=S,3=SW,4=W,5=NW,6=N,7=NE (row 0 = north, so +y = south)
const D8X = [1, 0.7071, 0, -0.7071, -1, -0.7071, 0, 0.7071];
const D8Y = [0, 0.7071, 1, 0.7071, 0, -0.7071, -1, -0.7071];

function gridCorners(meta: TerrainMeta): [[number, number], [number, number], [number, number], [number, number]] {
  const [w, s, e, n] = meta.bbox;
  return [
    [w, n],
    [e, n],
    [e, s],
    [w, s],
  ];
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value noise with period `p` lattice cells over NOISE pixels. */
function valueNoise(rand: () => number, px: number, py: number): Float32Array {
  const lat = new Float32Array(px * py);
  for (let i = 0; i < lat.length; i++) lat[i] = rand();
  const out = new Float32Array(NOISE * NOISE);
  const sx = px / NOISE;
  const sy = py / NOISE;
  for (let y = 0; y < NOISE; y++) {
    const fy = y * sy;
    const y0 = Math.floor(fy);
    let ty = fy - y0;
    ty = ty * ty * (3 - 2 * ty);
    const r0 = (y0 % py) * px;
    const r1 = ((y0 + 1) % py) * px;
    for (let x = 0; x < NOISE; x++) {
      const fx = x * sx;
      const x0 = Math.floor(fx);
      let tx = fx - x0;
      tx = tx * tx * (3 - 2 * tx);
      const c0 = x0 % px;
      const c1 = (x0 + 1) % px;
      const a = lat[r0 + c0] + (lat[r0 + c1] - lat[r0 + c0]) * tx;
      const b = lat[r1 + c0] + (lat[r1 + c1] - lat[r1 + c0]) * tx;
      out[y * NOISE + x] = a + (b - a) * ty;
    }
  }
  return out;
}

interface Textures {
  /** ripple gradient (x, y) in slope units, Int8 */
  rgx: Int8Array;
  rgy: Int8Array;
  /** sparse specks advected along the flow, 0..255 */
  flecks: Uint8Array;
  /** sparkle/foam breakup noise 0..255 */
  foam: Uint8Array;
  /** shading LUT: diffuse multiplier (x256) and additive specular (0..255) */
  diff: Uint16Array;
  spec: Uint8Array;
}

let TEX: Textures | null = null;
function textures(): Textures {
  if (TEX) return TEX;
  const rand = mulberry32(98);
  // ripple height: sum of integer-wavevector sines (tileable) + a bit of value noise
  const h = new Float32Array(NOISE * NOISE);
  const waves: [number, number, number, number][] = [];
  for (let i = 0; i < 14; i++) {
    const ang = rand() * Math.PI * 2;
    const k = 3 + Math.floor(rand() * 13);
    waves.push([Math.round(Math.cos(ang) * k), Math.round(Math.sin(ang) * k), rand() * Math.PI * 2, 1 / Math.sqrt(k)]);
  }
  const vn = valueNoise(rand, 32, 32);
  const tau = (Math.PI * 2) / NOISE;
  for (let y = 0; y < NOISE; y++)
    for (let x = 0; x < NOISE; x++) {
      let s = 0;
      for (const [kx, ky, ph, a] of waves) s += a * Math.sin((kx * x + ky * y) * tau + ph);
      h[y * NOISE + x] = s + vn[y * NOISE + x] * 1.2;
    }
  const rgx = new Int8Array(NOISE * NOISE);
  const rgy = new Int8Array(NOISE * NOISE);
  const G = 70;
  for (let y = 0; y < NOISE; y++)
    for (let x = 0; x < NOISE; x++) {
      const gx = h[y * NOISE + ((x + 1) & NMASK)] - h[y * NOISE + ((x - 1) & NMASK)];
      const gy = h[((y + 1) & NMASK) * NOISE + x] - h[((y - 1) & NMASK) * NOISE + x];
      rgx[y * NOISE + x] = Math.max(-127, Math.min(127, Math.round(gx * G)));
      rgy[y * NOISE + x] = Math.max(-127, Math.min(127, Math.round(gy * G)));
    }
  // flow flecks: sparse soft specks, advected along the flow field (flow-map technique)
  const flecks = new Uint8Array(NOISE * NOISE);
  {
    const fa = valueNoise(rand, 64, 64);
    const fb = valueNoise(rand, 128, 128);
    for (let i = 0; i < flecks.length; i++) {
      const v = fa[i] * 0.6 + fb[i] * 0.4;
      const q = Math.max(0, (v - 0.6) / 0.16);
      flecks[i] = Math.round(Math.min(1, q) * 255);
    }
  }
  const fA = valueNoise(rand, 64, 64);
  const fB = valueNoise(rand, 16, 16);
  const foam = new Uint8Array(NOISE * NOISE);
  for (let i = 0; i < foam.length; i++) foam[i] = Math.round(Math.min(1, Math.max(0, fA[i] * 0.65 + fB[i] * 0.55 - 0.1)) * 255);

  // shading LUT over slope (nx, ny) in [-SH/2, SH/2) * (1/SLOPE_Q)
  const diff = new Uint16Array(SH * SH);
  const spec = new Uint8Array(SH * SH);
  const L = [-0.55, -0.62, 0.56]; // light from north-west, fairly low (image +y = south)
  const ll = Math.hypot(L[0], L[1], L[2]);
  L[0] /= ll;
  L[1] /= ll;
  L[2] /= ll;
  // half vector with the camera roughly overhead-from-south (pitched map)
  const V = [0, 0.45, 0.89];
  const Hx = L[0] + V[0];
  const Hy = L[1] + V[1];
  const Hz = L[2] + V[2];
  const hl = Math.hypot(Hx, Hy, Hz);
  for (let j = 0; j < SH; j++)
    for (let i = 0; i < SH; i++) {
      const nx = -(i - SH / 2) / SLOPE_Q;
      const ny = -(j - SH / 2) / SLOPE_Q;
      const nl = Math.hypot(nx, ny, 1);
      const ndl = (nx * L[0] + ny * L[1] + L[2]) / nl;
      const ndh = Math.max(0, (nx * Hx + ny * Hy + Hz) / (nl * hl));
      const ndv = Math.max(0, (nx * V[0] + ny * V[1] + V[2]) / nl);
      const fres = Math.pow(1 - ndv, 3);
      diff[j * SH + i] = Math.round((0.62 + 0.5 * Math.max(0, ndl) + fres * 0.4) * 256);
      spec[j * SH + i] = Math.min(255, Math.round(Math.pow(ndh, 320) * 255 + Math.pow(ndh, 40) * 18));
    }
  TEX = { rgx, rgy, flecks, foam, diff, spec };
  return TEX;
}

export class WaterFx {
  private map: MLMap;
  private meta: TerrainMeta;
  private mask: Uint8Array | Float32Array;
  private id: string;
  private S: number;
  private W: number; // hi-res width
  private H: number;
  private frameInterval: number;

  private out: HTMLCanvasElement; // canvas source (draped)
  private octx: CanvasRenderingContext2D;
  private fx: HTMLCanvasElement | OffscreenCanvas; // shaded water, written via putImageData
  private fctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private img: ImageData;
  private px32: Uint32Array;
  private glow: HTMLCanvasElement | OffscreenCanvas;
  private gctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private hasGlow = false;

  private dHi: Float32Array; // scratch hi-res depth
  private aHi: Float32Array; // scratch hi-res alpha (0..1)
  private gxHi: Float32Array; // scratch hi-res depth gradient (m per cell)
  private gyHi: Float32Array;

  // per-wet-pixel attributes
  private n = 0;
  private pIdx = new Uint32Array(0);
  private pX = new Uint16Array(0);
  private pY = new Uint16Array(0);
  private pR = new Uint8Array(0);
  private pG = new Uint8Array(0);
  private pB = new Uint8Array(0);
  private pA = new Uint8Array(0);
  private pNx = new Int8Array(0);
  private pNy = new Int8Array(0);
  private pFoam = new Uint8Array(0);
  private pFx = new Int8Array(0);
  private pFy = new Int8Array(0);
  private pFlow = new Uint8Array(0);
  private bbox = [0, 0, 0, 0];

  private depth: Float32Array | null = null;
  private flowVec: Float32Array | null = null; // smoothed (x,y) per cell

  private visible = true;
  private raf = 0;
  private last = 0;
  private hourT = 0;
  private reduced: boolean;
  private mq: MediaQueryList;
  private destroyed = false;
  private pendingPause = false;
  private _stats: WaterFxStats;

  constructor(map: MLMap, meta: TerrainMeta, boundaryMask: Uint8Array | Float32Array, opts: WaterFxOptions = {}) {
    this.map = map;
    this.meta = meta;
    this.mask = boundaryMask;
    this.id = opts.id ?? 'flood';
    const maxSide = Math.max(meta.width, meta.height);
    this.S = Math.max(1, Math.min(opts.scale ?? 3, Math.floor(4096 / maxSide)));
    this.W = meta.width * this.S;
    this.H = meta.height * this.S;
    this.frameInterval = 1000 / (opts.fps ?? 30);
    this.mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reduced = this.mq.matches;
    this.mq.addEventListener?.('change', this.onMotionPref);
    this._stats = { frameMs: 0, prepMs: 0, wetPixels: 0, width: this.W, height: this.H };

    this.out = document.createElement('canvas');
    this.out.width = this.W;
    this.out.height = this.H;
    this.octx = this.out.getContext('2d')!;
    this.octx.imageSmoothingEnabled = true;
    this.octx.imageSmoothingQuality = 'high';

    const mk = (w: number, h: number) => {
      if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    };
    this.fx = mk(this.W, this.H);
    this.fctx = this.fx.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    this.img = this.fctx.createImageData(this.W, this.H);
    this.px32 = new Uint32Array(this.img.data.buffer);
    this.glow = mk(Math.ceil(this.W / 4), Math.ceil(this.H / 4));
    this.gctx = this.glow.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    this.gctx.imageSmoothingEnabled = true;

    this.dHi = new Float32Array(this.W * this.H);
    this.aHi = new Float32Array(this.W * this.H);
    this.gxHi = new Float32Array(this.W * this.H);
    this.gyHi = new Float32Array(this.W * this.H);

    textures();

    map.addSource(this.id, { type: 'canvas', canvas: this.out, coordinates: gridCorners(meta), animate: false });
    map.addLayer(
      {
        id: this.id,
        type: 'raster',
        source: this.id,
        paint: { 'raster-opacity': 1, 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
      },
      opts.beforeId ?? beforeLabels(),
    );
    document.addEventListener('visibilitychange', this.onVis);
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  get stats(): WaterFxStats {
    return this._stats;
  }

  /** Optional: D8 flow directions (meta.layers.flowDir) so streaks drift downhill. */
  setFlowDir(flowDir: Uint8Array | null) {
    this.flowVec = flowDir ? this.smoothFlow(flowDir) : null;
    if (this.depth) this.setDepth(this.depth);
  }

  /** Simulation clock in (fractional) hours; nudges the animation phase so scrubbing feels alive. */
  setTime(hourFraction: number) {
    this.hourT = hourFraction;
    if (this.reduced || !this.isAnimating()) this.render(performance.now());
  }

  setVisible(v: boolean) {
    this.visible = v;
    if (this.map.getLayer(this.id)) this.map.setLayoutProperty(this.id, 'visibility', v ? 'visible' : 'none');
    if (v) this.render(performance.now());
  }

  setDepth(depth: Float32Array | null) {
    const t0 = performance.now();
    this.depth = depth;
    this.prepare(depth);
    this._stats.prepMs = performance.now() - t0;
    this._stats.wetPixels = this.n;
    this.render(performance.now(), true);
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    document.removeEventListener('visibilitychange', this.onVis);
    this.mq.removeEventListener?.('change', this.onMotionPref);
    try {
      if (this.map.getLayer(this.id)) this.map.removeLayer(this.id);
      if (this.map.getSource(this.id)) this.map.removeSource(this.id);
    } catch {
      /* map already gone */
    }
  }

  // ---------------------------------------------------------------- internals

  private onVis = () => {
    if (document.visibilityState === 'visible' && !this.destroyed) {
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(this.loop);
    }
  };

  private onMotionPref = () => {
    this.reduced = this.mq.matches;
    this.render(performance.now());
  };

  private isAnimating() {
    return this.visible && !this.reduced && this.n > 0 && document.visibilityState === 'visible';
  }

  private loop(t: number) {
    if (this.destroyed) return;
    if (document.visibilityState === 'hidden') return; // resumed by onVis
    this.raf = requestAnimationFrame(this.loop);
    if (!this.isAnimating()) return;
    if (t - this.last < this.frameInterval) return;
    this.render(t);
  }

  private smoothFlow(fd: Uint8Array): Float32Array {
    const { width: w, height: h } = this.meta;
    let a = new Float32Array(w * h * 2);
    for (let i = 0; i < w * h; i++) {
      const d = fd[i];
      if (d < 8) {
        a[i * 2] = D8X[d];
        a[i * 2 + 1] = D8Y[d];
      }
    }
    // two separable box passes (radius 2) -> coherent local flow direction
    for (let pass = 0; pass < 2; pass++) {
      const b = new Float32Array(a.length);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let sx = 0;
          let sy = 0;
          for (let k = -2; k <= 2; k++) {
            const xx = Math.min(w - 1, Math.max(0, x + k));
            sx += a[(y * w + xx) * 2];
            sy += a[(y * w + xx) * 2 + 1];
          }
          b[(y * w + x) * 2] = sx / 5;
          b[(y * w + x) * 2 + 1] = sy / 5;
        }
      const c = new Float32Array(a.length);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let sx = 0;
          let sy = 0;
          for (let k = -2; k <= 2; k++) {
            const yy = Math.min(h - 1, Math.max(0, y + k));
            sx += b[(yy * w + x) * 2];
            sy += b[(yy * w + x) * 2 + 1];
          }
          c[(y * w + x) * 2] = sx / 5;
          c[(y * w + x) * 2 + 1] = sy / 5;
        }
      a = c;
    }
    return a;
  }

  /** Build per-wet-pixel static attributes from the depth grid. */
  private prepare(depth: Float32Array | null) {
    const S = this.S;
    const W = this.W;
    const gw = this.meta.width;
    const gh = this.meta.height;
    this.px32.fill(0);
    if (!depth) {
      this.n = 0;
      this.hasGlow = false;
      return;
    }
    const dHi = this.dHi;
    const aHi = this.aHi;
    const gxHi = this.gxHi;
    const gyHi = this.gyHi;
    const mask = this.mask;
    const LUTN = DEPTH_LUT.length / 4 - 1;
    const lutK = LUTN / DEPTH_LUT_MAX;

    // 0. soften the cell lattice: blend with a [1 4 6 4 1] blurred copy so contours come out
    //    rounded instead of stair-stepped once up-sampled (single wet cells survive at ~25%).
    depth = this.soften(depth);
    // central-difference gradient at grid res; interpolating it (instead of differencing the
    // bilinear surface, which is piecewise-flat per cell) avoids blocky per-cell highlights.
    const gG = new Float32Array(gw * gh * 2);
    for (let y = 0; y < gh; y++) {
      const ym = y > 0 ? y - 1 : y;
      const yp = y < gh - 1 ? y + 1 : y;
      for (let x = 0; x < gw; x++) {
        const xm = x > 0 ? x - 1 : x;
        const xp = x < gw - 1 ? x + 1 : x;
        const i = y * gw + x;
        gG[i * 2] = (depth[y * gw + xp] - depth[y * gw + xm]) / (xp - xm || 1);
        gG[i * 2 + 1] = (depth[yp * gw + x] - depth[ym * gw + x]) / (yp - ym || 1);
      }
    }
    // 1. candidate cells: wet (>= 1.5 cm) dilated by one cell
    const wetC = new Uint8Array(gw * gh);
    let any = false;
    for (let i = 0; i < depth.length; i++)
      if (depth[i] >= 0.015) {
        wetC[i] = 1;
        any = true;
      }
    if (!any) {
      this.n = 0;
      this.hasGlow = false;
      return;
    }
    const cand = new Uint8Array(gw * gh);
    let bx0 = gw;
    let by0 = gh;
    let bx1 = -1;
    let by1 = -1;
    for (let y = 0; y < gh; y++)
      for (let x = 0; x < gw; x++) {
        if (!wetC[y * gw + x]) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= gh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= gw) continue;
            cand[yy * gw + xx] = 1;
          }
        }
        if (x < bx0) bx0 = x;
        if (y < by0) by0 = y;
        if (x > bx1) bx1 = x;
        if (y > by1) by1 = y;
      }
    bx0 = Math.max(0, bx0 - 2);
    by0 = Math.max(0, by0 - 2);
    bx1 = Math.min(gw - 1, bx1 + 2);
    by1 = Math.min(gh - 1, by1 + 2);
    // clear scratch in bbox (pixels outside are never read)
    const X0 = bx0 * S;
    const Y0 = by0 * S;
    const X1 = (bx1 + 1) * S;
    const Y1 = (by1 + 1) * S;
    for (let y = Y0; y < Y1; y++) {
      dHi.fill(0, y * W + X0, y * W + X1);
      aHi.fill(0, y * W + X0, y * W + X1);
    }
    this.bbox = [X0, Y0, X1 - X0, Y1 - Y0];

    // 2. bilinear depth + alpha into hi-res scratch
    const Hh = this.H;
    const edgeK = 1 / (8 * S);
    const off = new Float32Array(S);
    for (let s = 0; s < S; s++) off[s] = (s + 0.5) / S - 0.5;
    let count = 0;
    for (let cy = 0; cy < gh; cy++)
      for (let cx = 0; cx < gw; cx++) {
        if (!cand[cy * gw + cx]) continue;
        for (let sy = 0; sy < S; sy++) {
          const gy = cy + off[sy];
          let y0 = Math.floor(gy);
          let ty = gy - y0;
          if (y0 < 0) {
            y0 = 0;
            ty = 0;
          } else if (y0 >= gh - 1) {
            y0 = gh - 2;
            ty = 1;
          }
          const r0 = y0 * gw;
          const r1 = r0 + gw;
          const py = cy * S + sy;
          for (let sx = 0; sx < S; sx++) {
            const gx = cx + off[sx];
            let x0 = Math.floor(gx);
            let tx = gx - x0;
            if (x0 < 0) {
              x0 = 0;
              tx = 0;
            } else if (x0 >= gw - 1) {
              x0 = gw - 2;
              tx = 1;
            }
            const a = depth[r0 + x0] + (depth[r0 + x0 + 1] - depth[r0 + x0]) * tx;
            const b = depth[r1 + x0] + (depth[r1 + x0 + 1] - depth[r1 + x0]) * tx;
            const d = a + (b - a) * ty;
            const pi = py * W + cx * S + sx;
            dHi[pi] = d;
            {
              const i00 = (r0 + x0) * 2;
              const i01 = i00 + 2;
              const i10 = (r1 + x0) * 2;
              const i11 = i10 + 2;
              const gxa = gG[i00] + (gG[i01] - gG[i00]) * tx;
              const gxb = gG[i10] + (gG[i11] - gG[i10]) * tx;
              gxHi[pi] = gxa + (gxb - gxa) * ty;
              const gya = gG[i00 + 1] + (gG[i01 + 1] - gG[i00 + 1]) * tx;
              const gyb = gG[i10 + 1] + (gG[i11 + 1] - gG[i10 + 1]) * tx;
              gyHi[pi] = gya + (gyb - gya) * ty;
            }
            if (d >= 0.02) {
              const li = Math.min(LUTN, (d * lutK) | 0) * 4;
              const ma = mask[r0 + x0] + (mask[r0 + x0 + 1] - mask[r0 + x0]) * tx;
              const mb = mask[r1 + x0] + (mask[r1 + x0 + 1] - mask[r1 + x0]) * tx;
              const m = ma + (mb - ma) * ty;
              // soften the 2 cm threshold into a 2–5 cm feather -> no hard pixel edge
              const fe = Math.min(1, (d - 0.02) / 0.03);
              const al = (DEPTH_LUT[li + 3] / 255) * (0.5 + 0.5 * m);
              // fade out over the last ~8 cells of the grid so the data extent never shows as a hard cut
              const px = cx * S + sx;
              const edge = Math.min(px, W - 1 - px, py, Hh - 1 - py) * edgeK;
              aHi[pi] = Math.max(al, 0.38 * fe * (0.5 + 0.5 * m)) * (edge < 1 ? edge * edge * (3 - 2 * edge) : 1);
              count++;
            }
          }
        }
      }

    // 3. allocate attribute arrays
    if (this.pIdx.length < count) {
      const cap = Math.ceil(count * 1.25);
      this.pIdx = new Uint32Array(cap);
      this.pX = new Uint16Array(cap);
      this.pY = new Uint16Array(cap);
      this.pR = new Uint8Array(cap);
      this.pG = new Uint8Array(cap);
      this.pB = new Uint8Array(cap);
      this.pA = new Uint8Array(cap);
      this.pNx = new Int8Array(cap);
      this.pNy = new Int8Array(cap);
      this.pFoam = new Uint8Array(cap);
      this.pFx = new Int8Array(cap);
      this.pFy = new Int8Array(cap);
      this.pFlow = new Uint8Array(cap);
    }
    const fv = this.flowVec;
    const invS = 1 / S;
    const NK = (SLOPE_Q * S) / 0.6; // depth slope -> normal units (0.6 m across one cell == slope 1)
    let k = 0;
    for (let y = Y0; y < Y1; y++) {
      for (let x = X0; x < X1; x++) {
        const pi = y * W + x;
        const al = aHi[pi];
        if (al <= 0) continue;
        const d = dHi[pi];
        // continuous (bilinearly interpolated) gradient, metres per hi-res pixel
        const gx = gxHi[pi] * invS;
        const gy = gyHi[pi] * invS;
        // normal of the "depth relief": water bulges where deeper -> highlights read as body
        let nx = -gx * NK;
        let ny = -gy * NK;
        const nl = Math.hypot(nx, ny);
        if (nl > 60) {
          nx *= 60 / nl;
          ny *= 60 / nl;
        }
        // rim: screen-space distance (px) to the 2 cm shoreline contour, via the depth
        // gradient (like fwidth) -> a crisp ~2 px bright line regardless of shore slope,
        // plus a faint inner fade.
        const gm = Math.hypot(gx, gy);
        const dist = (d - 0.02) / (gm > 1e-4 ? gm : 1e-4);
        const line = Math.max(0, 1 - Math.abs(dist - 1.2) / 1.6);
        const rim = Math.min(1, line + 0.22 * Math.exp(-dist / 5));

        const li = Math.min(LUTN, (d * lutK) | 0) * 4;
        let r = DEPTH_LUT[li];
        let g = DEPTH_LUT[li + 1];
        let b = DEPTH_LUT[li + 2];
        if (r + g + b === 0) {
          r = 170;
          g = 240;
          b = 255;
        }
        // deeper water: darker body (specular/diffuse add the life back)
        const body = 1 - Math.min(0.32, d * 0.18);
        this.pIdx[k] = pi;
        this.pX[k] = x;
        this.pY[k] = y;
        this.pR[k] = r * body;
        this.pG[k] = g * body;
        this.pB[k] = b * body;
        this.pA[k] = Math.min(255, al * 255);
        this.pNx[k] = nx;
        this.pNy[k] = ny;
        this.pFoam[k] = rim * 255;

        // flow coordinates
        let fx = 0.6;
        let fy = 0.8;
        let coh = 0.35;
        if (fv) {
          // bilinear flow vector -> lanes bend continuously instead of per-cell blocks
          const fgx = Math.min(gw - 1.001, Math.max(0, (x + 0.5) * invS - 0.5));
          const fgy = Math.min(gh - 1.001, Math.max(0, (y + 0.5) * invS - 0.5));
          const fx0 = fgx | 0;
          const fy0 = fgy | 0;
          const ftx = fgx - fx0;
          const fty = fgy - fy0;
          const c00 = (fy0 * gw + fx0) * 2;
          const c10 = c00 + gw * 2;
          const vxa = fv[c00] + (fv[c00 + 2] - fv[c00]) * ftx;
          const vxb = fv[c10] + (fv[c10 + 2] - fv[c10]) * ftx;
          const vya = fv[c00 + 1] + (fv[c00 + 3] - fv[c00 + 1]) * ftx;
          const vyb = fv[c10 + 1] + (fv[c10 + 3] - fv[c10 + 1]) * ftx;
          const vx = vxa + (vxb - vxa) * fty;
          const vy = vya + (vyb - vya) * fty;
          const m = Math.hypot(vx, vy);
          if (m > 1e-3) {
            fx = vx / m;
            fy = vy / m;
          }
          coh = Math.min(1, m * 1.15);
        }
        this.pFx[k] = Math.round(fx * 127);
        this.pFy[k] = Math.round(fy * 127);
        // streaks strongest in shallow-to-medium moving sheets, fade in deep ponds and at the rim
        const still = d > 0.5 ? Math.max(0, 1 - (d - 0.5) / 0.8) : 1;
        const inner = Math.min(1, Math.max(0, (d - 0.03) / 0.06));
        this.pFlow[k] = Math.min(255, (Math.min(1, coh * 1.3) * still * inner * 255) | 0);
        k++;
      }
    }
    this.n = k;
    this.buildGlow(depth);
  }

  private soft = new Float32Array(0);
  private tmp = new Float32Array(0);
  private soften(src: Float32Array): Float32Array {
    const w = this.meta.width;
    const h = this.meta.height;
    if (this.soft.length !== src.length) {
      this.soft = new Float32Array(src.length);
      this.tmp = new Float32Array(src.length);
    }
    const t = this.tmp;
    const o = this.soft;
    for (let y = 0; y < h; y++) {
      const r = y * w;
      for (let x = 0; x < w; x++) {
        const a = src[r + Math.max(0, x - 2)];
        const b = src[r + Math.max(0, x - 1)];
        const c = src[r + x];
        const d = src[r + Math.min(w - 1, x + 1)];
        const e = src[r + Math.min(w - 1, x + 2)];
        t[r + x] = (a + 4 * b + 6 * c + 4 * d + e) * 0.0625;
      }
    }
    for (let y = 0; y < h; y++) {
      const r0 = Math.max(0, y - 2) * w;
      const r1 = Math.max(0, y - 1) * w;
      const r2 = y * w;
      const r3 = Math.min(h - 1, y + 1) * w;
      const r4 = Math.min(h - 1, y + 2) * w;
      for (let x = 0; x < w; x++) {
        const bl = (t[r0 + x] + 4 * t[r1 + x] + 6 * t[r2 + x] + 4 * t[r3 + x] + t[r4 + x]) * 0.0625;
        o[r2 + x] = 0.12 * src[r2 + x] + 0.88 * bl;
      }
    }
    return o;
  }

  /** Soft halo: grid-res colour image, down-sampled twice -> blurred when stretched. */
  private buildGlow(depth: Float32Array) {
    const gw = this.meta.width;
    const gh = this.meta.height;
    const small = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(gw, gh) : Object.assign(document.createElement('canvas'), { width: gw, height: gh });
    const sctx = small.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    const im = sctx.createImageData(gw, gh);
    const LUTN = DEPTH_LUT.length / 4 - 1;
    const lutK = LUTN / DEPTH_LUT_MAX;
    for (let i = 0; i < depth.length; i++) {
      const d = depth[i];
      if (d < 0.03) continue;
      const li = Math.min(LUTN, (d * lutK) | 0) * 4;
      const o = i * 4;
      // glow brighter/more saturated than the body
      im.data[o] = Math.min(255, DEPTH_LUT[li] * 0.7 + 40);
      im.data[o + 1] = Math.min(255, DEPTH_LUT[li + 1] * 0.9 + 30);
      im.data[o + 2] = 255;
      im.data[o + 3] = Math.min(255, 60 + Math.min(1, d / 0.6) * 195);
    }
    sctx.putImageData(im, 0, 0);
    const g = this.gctx;
    const gwc = this.glow.width;
    const ghc = this.glow.height;
    g.clearRect(0, 0, gwc, ghc);
    // two-step down/up for a wider, smoother blur
    const half = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(Math.ceil(gw / 3), Math.ceil(gh / 3)) : Object.assign(document.createElement('canvas'), { width: Math.ceil(gw / 3), height: Math.ceil(gh / 3) });
    const hctx = half.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    hctx.imageSmoothingEnabled = true;
    hctx.imageSmoothingQuality = 'high';
    hctx.drawImage(small, 0, 0, half.width, half.height);
    g.imageSmoothingQuality = 'high';
    g.drawImage(half, 0, 0, gwc, ghc);
    g.globalAlpha = 0.6;
    g.drawImage(small, 0, 0, gwc, ghc);
    g.globalAlpha = 1;
    this.hasGlow = true;
  }

  private render(now: number, force = false) {
    if (this.destroyed) return;
    if (!this.visible && !force) return;
    this.last = now;
    const t0 = performance.now();
    const tex = TEX!;
    const time = (this.reduced ? 0 : now / 1000) + this.hourT * 4.0;
    const n = this.n;
    if (n > 0) {
      const px = this.px32;
      const { rgx, rgy, flecks, foam, diff, spec } = tex;
      // ripple layer offsets (pixels), two directions + different scales
      const o1x = (time * 9.0) | 0;
      const o1y = (time * 5.5) | 0;
      const o2x = (-time * 6.0) | 0;
      const o2y = (time * 8.0) | 0;
      const fo = (time * 3.0) | 0;
      // flow map: two phases half a cycle apart, cross-faded with a triangle weight
      const ph1 = (time / FLOW_CYCLE) % 1;
      const ph2 = (ph1 + 0.5) % 1;
      const o1 = (ph1 * FLOW_DIST * 2) | 0; // (f*127 * o) >> 8 == f * ph * FLOW_DIST px
      const o2 = (ph2 * FLOW_DIST * 2) | 0;
      const w1 = (256 * (1 - Math.abs(2 * ph1 - 1))) | 0;
      const w2 = 256 - w1;
      const pulse = 0.5 + 0.5 * Math.sin(time * 1.7);
      const pIdx = this.pIdx;
      const pX = this.pX;
      const pY = this.pY;
      const pR = this.pR;
      const pG = this.pG;
      const pB = this.pB;
      const pA = this.pA;
      const pNx = this.pNx;
      const pNy = this.pNy;
      const pFoam = this.pFoam;
      const pFx = this.pFx;
      const pFy = this.pFy;
      const pFlow = this.pFlow;
      const HALF = SH >> 1;
      const foamPulse = (180 + pulse * 75) | 0;
      for (let k = 0; k < n; k++) {
        const x = pX[k];
        const y = pY[k];
        const i1 = (((y + o1y) & NMASK) << 8) | ((x + o1x) & NMASK);
        const i2 = ((((y * 3) >> 1) + o2y) & NMASK) << 8 | ((((x * 3) >> 1) + o2x) & NMASK);
        let nx = pNx[k] + ((rgx[i1] + rgx[i2]) >> 2);
        let ny = pNy[k] + ((rgy[i1] + rgy[i2]) >> 2);
        nx += HALF;
        ny += HALF;
        if (nx < 0) nx = 0;
        else if (nx >= SH) nx = SH - 1;
        if (ny < 0) ny = 0;
        else if (ny >= SH) ny = SH - 1;
        const si = ny * SH + nx;
        const df = diff[si];
        let sp = spec[si];
        // flow streaks
        const fl = pFlow[k];
        let st = 0;
        if (fl > 8) {
          const fx = pFx[k];
          const fy = pFy[k];
          // sample upstream (p - f*offset); 2 taps per phase, 3 px apart -> short motion-blurred streak
          const ax = x - ((fx * o1) >> 8);
          const ay = y - ((fy * o1) >> 8);
          const bx = x + 97 - ((fx * o2) >> 8);
          const by = y + 53 - ((fy * o2) >> 8);
          const tx = (fx * 3) >> 7;
          const ty = (fy * 3) >> 7;
          const s1 = flecks[((ay & NMASK) << 8) | (ax & NMASK)] + flecks[(((ay - ty) & NMASK) << 8) | ((ax - tx) & NMASK)];
          const s2 = flecks[((by & NMASK) << 8) | (bx & NMASK)] + flecks[(((by - ty) & NMASK) << 8) | ((bx - tx) & NMASK)];
          st = (((s1 * w1 + s2 * w2) >> 9) * fl * 5) >> 10;
        }
        // rim foam, broken up by drifting noise
        const fm = pFoam[k];
        let fa = 0;
        if (fm > 6) {
          const fz = foam[(((y + fo) & NMASK) << 8) | ((x - fo) & NMASK)];
          fa = (fm * fz * foamPulse) >> 16;
        }
        sp += st;
        let r = ((pR[k] * df) >> 8) + sp + ((fa * 150) >> 8);
        let g = ((pG[k] * df) >> 8) + sp + ((fa * 230) >> 8);
        let b = ((pB[k] * df) >> 8) + sp + fa;
        let a = pA[k] + (sp >> 1) + (fa >> 1);
        if (r > 255) r = 255;
        if (g > 255) g = 255;
        if (b > 255) b = 255;
        if (a > 255) a = 255;
        px[pIdx[k]] = (a << 24) | (b << 16) | (g << 8) | r;
      }
    }
    const [bx, by, bw, bh] = this.bbox;
    const o = this.octx;
    o.clearRect(0, 0, this.W, this.H);
    if (n > 0) {
      this.fctx.putImageData(this.img, 0, 0, bx, by, bw, bh);
      if (this.hasGlow) {
        o.globalAlpha = 0.42 + 0.08 * Math.sin(time * 1.3);
        o.drawImage(this.glow, 0, 0, this.W, this.H);
        o.globalAlpha = 1;
      }
      o.drawImage(this.fx, bx, by, bw, bh, bx, by, bw, bh);
    }
    const src = this.map.getSource(this.id) as CanvasSource | undefined;
    if (src) {
      // upload exactly once per rendered frame: play() makes the next map frame re-read the
      // canvas, then we drop back to static so the source never forces continuous repaint.
      src.play();
      if (!this.pendingPause) {
        this.pendingPause = true;
        this.map.once('render', () => {
          this.pendingPause = false;
          src._playing = false;
        });
      }
    }
    const dt = performance.now() - t0;
    this._stats.frameMs = this._stats.frameMs ? this._stats.frameMs * 0.9 + dt * 0.1 : dt;
  }
}
