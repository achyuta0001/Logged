// City-wide road graph file (public/data/roads/graph-<hash>.bin.gz), written by
// scripts/route/build-graph.mjs and read by the router (src/route/graph.ts). Shared by both so the
// encoder and the decoder cannot drift apart. No DOM, no network: runs in node, a page and a worker.
//
// Layout (little-endian), then gzip -9 over the whole file:
//   "RGR1"  u32 header byte length  header JSON (GraphHeader)  streams, in STREAMS order
// Each stream is a byte column: unsigned LEB128 varints (zz = zigzag for signed deltas) or raw u8.
//   nodes    per node: zz(dx), zz(dy) of the 1e-5 deg coordinate from the previous node (nodes are in
//            Hilbert order, so neighbours are close and deltas small)
//   signal   u8 per node: 1 = highway=traffic_signals at this junction
//   eu, ev   per edge: eu - previous eu (edges sorted by eu), zz(ev - eu)
//   eflags   u8: FWD (u -> v allowed), BWD (v -> u), BRIDGE (flyover / bridge deck), TUNNEL (underpass)
//   eclass   u8 index into header.speeds.classes; emax u8 tagged maxspeed km/h (0 = none)
//   esig     u8 traffic signals strictly inside the edge
//   ename, eref  name / ref index + 1 into the names table (0 = none)
//   elen     length in decimetres
//   ways     per edge: count, then per OSM way along it: zz(id - previous id), vertex index where it starts
//   geo      per edge: interior vertex count, then zz(dx), zz(dy) per vertex (from node u, 1e-5 deg)
//   names    UTF-8, '\n'-separated
//   lm       per landmark, per node: zz(delta) of the undirected travel time from the landmark, whole
//            seconds rounded down (an ALT lower bound; see src/route/search.ts)
import type { SpeedTable } from './config.ts';

export const GRAPH_MAGIC = 'RGR1';
export const GRAPH_VERSION = 1;
/** coordinates are stored in units of 1e-5 deg (~1.1 m) */
export const COORD_SCALE = 1e5;

export const FWD = 1;
export const BWD = 2;
export const BRIDGE = 4;
export const TUNNEL = 8;

export const STREAMS = ['nodes', 'signal', 'eu', 'ev', 'eflags', 'eclass', 'emax', 'esig', 'ename', 'eref', 'elen', 'ways', 'geo', 'names', 'lm'] as const;

export interface GraphHeader {
  version: number;
  /** ISO time of the build */
  built: string;
  /** OSM source and licence, e.g. the Geofabrik extract and "ODbL 1.0, (c) OpenStreetMap contributors" */
  source: string;
  licence: string;
  /** [w, s, e, n] of the area the graph was cut to */
  bbox: number[];
  speeds: SpeedTable;
  /** node index of each landmark (the file stores `lm` landmark-major; decodeGraph returns it node-major) */
  landmarks: number[];
  n: number;
  m: number;
  /** total way references and polyline vertices (for preallocation) */
  wayRefs: number;
  points: number;
  /** byte length of each stream, in STREAMS order */
  streams: Record<string, number>;
  /** free-form build statistics (kept / dropped ways, components, timings) */
  stats?: Record<string, unknown>;
}

/** The whole graph as flat arrays (what the file holds, decoded). */
export interface RawGraph {
  header: GraphHeader;
  nodeLng: Float64Array;
  nodeLat: Float64Array;
  nodeSignal: Uint8Array;
  eU: Int32Array;
  eV: Int32Array;
  eFlags: Uint8Array;
  eClass: Uint8Array;
  eMaxspeed: Uint8Array;
  eSignals: Uint8Array;
  /** index into names, -1 = none */
  eName: Int32Array;
  eRef: Int32Array;
  /** metres */
  eLen: Float32Array;
  /** OSM ways of edge e: wayId[wayOff[e] .. wayOff[e+1]), each starting at polyline vertex wayAt[..] */
  wayOff: Int32Array;
  wayId: Float64Array;
  wayAt: Int32Array;
  /** full polyline of edge e (u ... v): geoLng/geoLat[geoOff[e] .. geoOff[e+1]) */
  geoOff: Int32Array;
  geoLng: Float64Array;
  geoLat: Float64Array;
  names: string[];
  /** undirected seconds (floored) from each landmark, node-major: lm[v * landmarks.length + l] */
  lm: Uint16Array;
}

// ------------------------------------------------------------------------------------------ varints

const zz = (v: number) => (v >= 0 ? v * 2 : -v * 2 - 1);
const unzz = (u: number) => (u % 2 === 0 ? u / 2 : -(u + 1) / 2);

class Writer {
  buf = new Uint8Array(1 << 16);
  len = 0;
  private room(k: number) {
    if (this.len + k <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + k) cap *= 2;
    const b = new Uint8Array(cap);
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }
  /** unsigned LEB128, exact up to 2^53 */
  uv(v: number) {
    if (!(v >= 0) || !Number.isSafeInteger(v)) throw new Error(`varint out of range: ${v}`);
    this.room(8);
    while (v >= 128) {
      this.buf[this.len++] = (v % 128) | 128;
      v = Math.floor(v / 128);
    }
    this.buf[this.len++] = v;
  }
  sv(v: number) {
    this.uv(zz(v));
  }
  bytes(b: Uint8Array) {
    this.room(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  out() {
    return this.buf.subarray(0, this.len);
  }
}

class Reader {
  p = 0;
  readonly b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
  }
  uv(): number {
    let x = this.b[this.p++];
    if (x < 128) return x;
    let v = x & 127, mul = 128;
    for (;;) {
      x = this.b[this.p++];
      v += (x & 127) * mul;
      if (x < 128) return v;
      mul *= 128;
      if (this.p > this.b.length) throw new Error('road graph: truncated varint');
    }
  }
  sv(): number {
    return unzz(this.uv());
  }
}

// ------------------------------------------------------------------------------------------ encode

const q = (deg: number) => Math.round(deg * COORD_SCALE);

/** Serialise a graph (uncompressed; the build gzips it). `header.streams`, `n`, `m` ... are filled in. */
export function encodeGraph(g: Omit<RawGraph, 'header'> & { header: Omit<GraphHeader, 'streams' | 'n' | 'm' | 'wayRefs' | 'points' | 'version'> }): Uint8Array {
  const n = g.nodeLng.length, m = g.eU.length;
  const k = g.header.landmarks.length;
  if (g.lm.length !== k * n) throw new Error(`encodeGraph: lm has ${g.lm.length} values for ${k} landmarks x ${n} nodes`);
  for (let e = 1; e < m; e++) if (g.eU[e] < g.eU[e - 1]) throw new Error('encodeGraph: edges must be sorted by eU');
  const s: Record<string, Writer> = {};
  for (const name of STREAMS) s[name] = new Writer();

  let px = 0, py = 0;
  for (let i = 0; i < n; i++) {
    const x = q(g.nodeLng[i]), y = q(g.nodeLat[i]);
    s.nodes.sv(x - px);
    s.nodes.sv(y - py);
    px = x;
    py = y;
  }
  s.signal.bytes(g.nodeSignal);
  let pu = 0, pw = 0;
  for (let e = 0; e < m; e++) {
    s.eu.uv(g.eU[e] - pu);
    pu = g.eU[e];
    s.ev.sv(g.eV[e] - g.eU[e]);
    s.ename.uv(g.eName[e] + 1);
    s.eref.uv(g.eRef[e] + 1);
    s.elen.uv(Math.max(0, Math.round(g.eLen[e] * 10)));
    const w0 = g.wayOff[e], w1 = g.wayOff[e + 1];
    s.ways.uv(w1 - w0);
    for (let j = w0; j < w1; j++) {
      s.ways.sv(g.wayId[j] - pw);
      pw = g.wayId[j];
      s.ways.uv(g.wayAt[j]);
    }
    const o0 = g.geoOff[e], o1 = g.geoOff[e + 1];
    if (o1 - o0 < 2) throw new Error(`encodeGraph: edge ${e} has ${o1 - o0} vertices`);
    s.geo.uv(o1 - o0 - 2);
    let gx = q(g.nodeLng[g.eU[e]]), gy = q(g.nodeLat[g.eU[e]]);
    for (let j = o0 + 1; j < o1 - 1; j++) {
      const x = q(g.geoLng[j]), y = q(g.geoLat[j]);
      s.geo.sv(x - gx);
      s.geo.sv(y - gy);
      gx = x;
      gy = y;
    }
  }
  s.eflags.bytes(g.eFlags);
  s.eclass.bytes(g.eClass);
  s.emax.bytes(g.eMaxspeed);
  s.esig.bytes(g.eSignals);
  s.names.bytes(new TextEncoder().encode(g.names.map((x) => x.replace(/\n/g, ' ')).join('\n')));
  for (let l = 0; l < k; l++) {
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const v = g.lm[i * k + l];
      s.lm.sv(v - prev);
      prev = v;
    }
  }

  const header: GraphHeader = {
    ...g.header,
    version: GRAPH_VERSION,
    n,
    m,
    wayRefs: g.wayOff[m],
    points: g.geoOff[m],
    streams: Object.fromEntries(STREAMS.map((name) => [name, s[name].len])),
  };
  const hj = new TextEncoder().encode(JSON.stringify(header));
  const total = 8 + hj.length + STREAMS.reduce((a, name) => a + s[name].len, 0);
  const out = new Uint8Array(total);
  out.set(new TextEncoder().encode(GRAPH_MAGIC), 0);
  new DataView(out.buffer).setUint32(4, hj.length, true);
  out.set(hj, 8);
  let p = 8 + hj.length;
  for (const name of STREAMS) {
    out.set(s[name].out(), p);
    p += s[name].len;
  }
  return out;
}

// ------------------------------------------------------------------------------------------ decode

/** Parse an (inflated) graph file. */
export function decodeGraph(bytes: Uint8Array): RawGraph {
  const magic = new TextDecoder().decode(bytes.subarray(0, 4));
  if (magic !== GRAPH_MAGIC) throw new Error(`road graph: bad magic "${magic}"`);
  const hl = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + hl))) as GraphHeader;
  if (header.version !== GRAPH_VERSION) throw new Error(`road graph: version ${header.version}, this app reads ${GRAPH_VERSION}`);
  const st: Record<string, Uint8Array> = {};
  let p = 8 + hl;
  for (const name of STREAMS) {
    const len = header.streams[name] ?? 0;
    st[name] = bytes.subarray(p, p + len);
    p += len;
  }
  if (p > bytes.length) throw new Error('road graph: truncated file');
  const { n, m } = header;
  const k = header.landmarks.length;

  const nodeLng = new Float64Array(n), nodeLat = new Float64Array(n);
  const qx = new Int32Array(n), qy = new Int32Array(n);
  {
    const r = new Reader(st.nodes);
    let x = 0, y = 0;
    for (let i = 0; i < n; i++) {
      x += r.sv();
      y += r.sv();
      qx[i] = x;
      qy[i] = y;
      nodeLng[i] = x / COORD_SCALE;
      nodeLat[i] = y / COORD_SCALE;
    }
  }
  const eU = new Int32Array(m), eV = new Int32Array(m), eName = new Int32Array(m), eRef = new Int32Array(m);
  const eLen = new Float32Array(m);
  const wayOff = new Int32Array(m + 1), wayId = new Float64Array(header.wayRefs), wayAt = new Int32Array(header.wayRefs);
  const geoOff = new Int32Array(m + 1), geoLng = new Float64Array(header.points), geoLat = new Float64Array(header.points);
  {
    const ru = new Reader(st.eu), rv = new Reader(st.ev), rn = new Reader(st.ename), rr = new Reader(st.eref), rl = new Reader(st.elen);
    const rw = new Reader(st.ways), rg = new Reader(st.geo);
    let u = 0, pw = 0, wj = 0, gj = 0;
    for (let e = 0; e < m; e++) {
      u += ru.uv();
      const v = u + rv.sv();
      eU[e] = u;
      eV[e] = v;
      eName[e] = rn.uv() - 1;
      eRef[e] = rr.uv() - 1;
      eLen[e] = rl.uv() / 10;
      const cw = rw.uv();
      wayOff[e] = wj;
      for (let j = 0; j < cw; j++) {
        pw += rw.sv();
        wayId[wj] = pw;
        wayAt[wj++] = rw.uv();
      }
      geoOff[e] = gj;
      const ci = rg.uv();
      let x = qx[u], y = qy[u];
      geoLng[gj] = nodeLng[u];
      geoLat[gj++] = nodeLat[u];
      for (let j = 0; j < ci; j++) {
        x += rg.sv();
        y += rg.sv();
        geoLng[gj] = x / COORD_SCALE;
        geoLat[gj++] = y / COORD_SCALE;
      }
      geoLng[gj] = nodeLng[v];
      geoLat[gj++] = nodeLat[v];
    }
    wayOff[m] = wj;
    geoOff[m] = gj;
  }
  const lm = new Uint16Array(k * n);
  {
    const r = new Reader(st.lm);
    for (let l = 0; l < k; l++) {
      let prev = 0;
      for (let i = 0; i < n; i++) {
        prev += r.sv();
        lm[i * k + l] = prev;
      }
    }
  }
  const names = st.names.length ? new TextDecoder().decode(st.names).split('\n') : [];
  return {
    header,
    nodeLng,
    nodeLat,
    nodeSignal: st.signal.slice(),
    eU,
    eV,
    eFlags: st.eflags.slice(),
    eClass: st.eclass.slice(),
    eMaxspeed: st.emax.slice(),
    eSignals: st.esig.slice(),
    eName,
    eRef,
    eLen,
    wayOff,
    wayId,
    wayAt,
    geoOff,
    geoLng,
    geoLat,
    names,
    lm,
  };
}

/** gzip magic (RFC 1952): a host that sends Content-Encoding: gzip hands over inflated bytes, so sniff. */
export const isGzip = (b: Uint8Array) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

/** Inflate gzip bytes with the platform's DecompressionStream (browsers, workers, node >= 18). */
export async function gunzip(b: Uint8Array): Promise<Uint8Array> {
  if (!isGzip(b)) return b;
  if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot inflate gzip (no DecompressionStream)');
  const stream = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
