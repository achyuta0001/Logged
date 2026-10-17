// Flood depth overlay: depth grid -> small canvas (1px per cell) -> bilinear upscale
// to a larger canvas used as a maplibre `canvas` source draped on the terrain.
// A cheap time-based shimmer is re-rendered on an rAF loop (throttled).
import type { Map as MLMap, CanvasSource } from 'maplibre-gl';
import type { TerrainMeta } from '../types';
import { DEPTH_LUT, DEPTH_LUT_MAX } from './colors';
import { beforeLabels } from './mapView';

export function gridCorners(meta: TerrainMeta): [[number, number], [number, number], [number, number], [number, number]] {
  const [w, s, e, n] = meta.bbox;
  return [
    [w, n],
    [e, n],
    [e, s],
    [w, s],
  ];
}

export class FloodLayer {
  private map: MLMap;
  private meta: TerrainMeta;
  private small: HTMLCanvasElement;
  private sctx: CanvasRenderingContext2D;
  private img: ImageData;
  private big: HTMLCanvasElement;
  private bctx: CanvasRenderingContext2D;
  private depth: Float32Array | null = null;
  private wet: Int32Array = new Int32Array(0);
  private raf = 0;
  private pauseRaf = 0;
  private last = 0;
  private visible = true;
  private reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private mask: Uint8Array | Float32Array;

  constructor(map: MLMap, meta: TerrainMeta, boundaryMask: Uint8Array | Float32Array) {
    this.map = map;
    this.meta = meta;
    this.mask = boundaryMask;
    const { width, height } = meta;
    this.small = document.createElement('canvas');
    this.small.width = width;
    this.small.height = height;
    this.sctx = this.small.getContext('2d', { willReadFrequently: false })!;
    this.img = this.sctx.createImageData(width, height);
    const scale = Math.max(1, Math.min(4, Math.floor(1280 / Math.max(width, height))));
    this.big = document.createElement('canvas');
    this.big.width = width * scale;
    this.big.height = height * scale;
    this.bctx = this.big.getContext('2d')!;
    this.bctx.imageSmoothingEnabled = true;
    this.bctx.imageSmoothingQuality = 'high';

    map.addSource('flood', { type: 'canvas', canvas: this.big, coordinates: gridCorners(meta), animate: false });
    map.addLayer(
      {
        id: 'flood',
        type: 'raster',
        source: 'flood',
        paint: { 'raster-opacity': 0.92, 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
      },
      beforeLabels(),
    );
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  setDepth(depth: Float32Array | null) {
    this.depth = depth;
    if (!depth) {
      this.wet = new Int32Array(0);
    } else {
      let n = 0;
      for (let i = 0; i < depth.length; i++) if (depth[i] >= 0.02) n++;
      const wet = new Int32Array(n);
      n = 0;
      for (let i = 0; i < depth.length; i++) if (depth[i] >= 0.02) wet[n++] = i;
      this.wet = wet;
    }
    this.render(performance.now());
  }

  setVisible(v: boolean) {
    this.visible = v;
    this.map.setLayoutProperty('flood', 'visibility', v ? 'visible' : 'none');
  }

  private loop(t: number) {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.visible || this.reduced || this.wet.length === 0) return;
    if (t - this.last < 66) return; // ~15 fps shimmer
    this.render(t);
  }

  private render(t: number) {
    this.last = t;
    const data = this.img.data;
    data.fill(0);
    const d = this.depth;
    if (d) {
      const w = this.meta.width;
      const time = t / 1000;
      const lutN = DEPTH_LUT.length / 4 - 1;
      const wet = this.wet;
      const mask = this.mask;
      for (let k = 0; k < wet.length; k++) {
        const i = wet[k];
        const v = d[i];
        let li = ((Math.min(v, DEPTH_LUT_MAX) / DEPTH_LUT_MAX) * lutN) | 0;
        li *= 4;
        const x = i % w;
        const y = (i / w) | 0;
        // two travelling interference waves -> soft caustic shimmer
        const s = Math.sin(x * 0.42 + time * 1.6) * Math.sin(y * 0.37 - time * 1.25) + 0.6 * Math.sin((x + y) * 0.21 + time * 0.9);
        const hl = s > 0.7 ? (s - 0.7) * 110 : 0;
        const o = i * 4;
        const a = DEPTH_LUT[li + 3] * (mask[i] ? 1 : 0.55);
        data[o] = DEPTH_LUT[li] + hl * 0.55;
        data[o + 1] = DEPTH_LUT[li + 1] + hl;
        data[o + 2] = DEPTH_LUT[li + 2] + hl;
        data[o + 3] = Math.min(255, a + hl * 0.5);
      }
    }
    this.sctx.putImageData(this.img, 0, 0);
    this.bctx.clearRect(0, 0, this.big.width, this.big.height);
    this.bctx.drawImage(this.small, 0, 0, this.big.width, this.big.height);
    // Upload the canvas once: play for a frame, then pause (animate:true would re-upload every frame).
    const src = this.map.getSource('flood') as CanvasSource | undefined;
    if (src) {
      src.play();
      this.map.triggerRepaint();
      cancelAnimationFrame(this.pauseRaf);
      this.pauseRaf = requestAnimationFrame(() => (this.pauseRaf = requestAnimationFrame(() => src.pause())));
    }
  }

  destroy() {
    cancelAnimationFrame(this.raf);
  }
}
