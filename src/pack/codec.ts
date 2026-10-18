// Pack format v2 grid codec, shared by the data build (node, via type stripping) and the app.
//
// Each layer is stored as integers q and decoded to the same Float32Array / Uint8Array the v1
// format holds, so nothing downstream changes:
//   u16 + scale/base       value = base + q * scale            (elevation, HAND: ~mm steps)
//   u16 + log2             value = 2 ** (q / scale)            (flowAccum: upstream cells)
//   u8  + scale            value = q * scale                   (impervious 0..1)
//   u8                     value = q                           (flowDir, masks)
//   delta                  q stored as differences along each row (first column: from the row above)
//   shuffle                u16 bytes split into a low-byte plane and a high-byte plane
//   derived                not stored: filled = elevation + depressionDepth
// Delta + shuffle turn a smooth surface into long runs of small numbers that gzip well.
import type { GridLayerName, LayerInfo } from '../types.ts';

export interface EncodeSpec {
  dtype: 'u16' | 'u8';
  scale?: number;
  base?: number;
  log2?: boolean;
  delta?: boolean;
  shuffle?: boolean;
}

/** quantise + encode one layer; returns the bytes and the LayerInfo (offset filled in by the caller) */
export function encodeLayer(values: ArrayLike<number>, width: number, spec: EncodeSpec): { bytes: Uint8Array; info: Omit<LayerInfo, 'offset'> } {
  const n = values.length;
  const scale = spec.scale ?? 1;
  const base = spec.base ?? 0;
  const max = spec.dtype === 'u16' ? 65535 : 255;
  const q = spec.dtype === 'u16' ? new Uint16Array(n) : new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    const x = spec.log2 ? Math.log2(Math.max(1, v)) * scale : (v - base) / scale;
    q[i] = Math.max(0, Math.min(max, Math.round(x)));
  }
  let out: Uint16Array | Uint8Array = q;
  if (spec.delta) {
    // wrap-around arithmetic: the decoder adds back mod 2^16 / 2^8, so any step size round-trips
    const d = spec.dtype === 'u16' ? new Uint16Array(n) : new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const prev = i % width === 0 ? (i >= width ? q[i - width] : 0) : q[i - 1];
      d[i] = (q[i] - prev) & max;
    }
    out = d;
  }
  let bytes = new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  if (spec.shuffle && spec.dtype === 'u16') {
    const s = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) {
      s[i] = bytes[2 * i];
      s[n + i] = bytes[2 * i + 1];
    }
    bytes = s;
  } else bytes = Uint8Array.from(bytes);
  const info: Omit<LayerInfo, 'offset'> = { length: n, dtype: spec.dtype };
  if (spec.scale !== undefined) info.scale = spec.scale;
  if (spec.base !== undefined) info.base = spec.base;
  if (spec.log2) info.log2 = true;
  if (spec.delta) info.delta = true;
  if (spec.shuffle && spec.dtype === 'u16') info.shuffle = true;
  return { bytes, info };
}

/** bytes of one stored layer in grids.bin */
export function layerBytes(l: LayerInfo): number {
  if (l.derived) return 0;
  return l.length * (l.dtype === 'f32' ? 4 : l.dtype === 'u16' ? 2 : 1);
}

/** decode one stored layer from grids.bin into its v1 typed array */
export function decodeLayer(buf: ArrayBuffer, l: LayerInfo, width: number): Float32Array | Uint8Array {
  const n = l.length;
  if (l.dtype === 'f32') return l.offset % 4 === 0 ? new Float32Array(buf, l.offset, n) : new Float32Array(buf.slice(l.offset, l.offset + n * 4));
  const raw = new Uint8Array(buf, l.offset, n * (l.dtype === 'u16' ? 2 : 1));
  let q: Uint16Array | Uint8Array;
  if (l.dtype === 'u16') {
    q = new Uint16Array(n);
    if (l.shuffle) for (let i = 0; i < n; i++) q[i] = raw[i] | (raw[n + i] << 8);
    else for (let i = 0; i < n; i++) q[i] = raw[2 * i] | (raw[2 * i + 1] << 8);
  } else q = l.delta ? Uint8Array.from(raw) : raw;
  if (l.delta) {
    const mask = l.dtype === 'u16' ? 0xffff : 0xff;
    for (let i = 0; i < n; i++) {
      const prev = i % width === 0 ? (i >= width ? q[i - width] : 0) : q[i - 1];
      q[i] = (q[i] + prev) & mask;
    }
  }
  const scale = l.scale ?? 1;
  const base = l.base ?? 0;
  if (l.dtype === 'u8' && l.scale === undefined && l.base === undefined) return q as Uint8Array;
  const out = new Float32Array(n);
  if (l.log2) for (let i = 0; i < n; i++) out[i] = 2 ** (q[i] / scale);
  else for (let i = 0; i < n; i++) out[i] = base + q[i] * scale;
  return out;
}

/** v2 encoding of every pack layer (data build); `filled` is derived, not stored */
export function v2Specs(g: { elevation: ArrayLike<number>; hand: ArrayLike<number> }): Partial<Record<GridLayerName, EncodeSpec>> {
  let lo = Infinity, hi = -Infinity, hmax = 0;
  for (let i = 0; i < g.elevation.length; i++) {
    lo = Math.min(lo, g.elevation[i]);
    hi = Math.max(hi, g.elevation[i]);
    hmax = Math.max(hmax, g.hand[i]);
  }
  const base = Math.floor(lo) - 1;
  // millimetres while the range fits in 16 bits (~65 m), coarser steps for hillier packs
  const step = (range: number) => Math.max(0.001, Math.ceil((range / 65000) * 1e4) / 1e4);
  return {
    elevation: { dtype: 'u16', base, scale: step(hi + 1 - base), delta: true, shuffle: true },
    depressionDepth: { dtype: 'u16', base: 0, scale: 0.001, shuffle: true },
    flowAccum: { dtype: 'u16', log2: true, scale: 2048 },
    flowDir: { dtype: 'u8' },
    hand: { dtype: 'u16', base: 0, scale: step(hmax + 1), delta: true, shuffle: true },
    impervious: { dtype: 'u8', base: 0, scale: 1 / 250 },
    drainMask: { dtype: 'u8' },
    lakeMask: { dtype: 'u8' },
    boundaryMask: { dtype: 'u8' },
  };
}
