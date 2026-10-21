// City-wide drivable road graph for the commute router (src/route/**).
//
//   node scripts/route/build-graph.mjs                 -> public/data/roads/{index.json, graph-<hash>.bin.gz}
//        [--pbf .cache/osm/blr-region.osm.pbf] [--out public/data/roads] [--bbox w,s,e,n]
//        [--landmarks 12] [--opl roads.opl]  (an OPL file with way node locations, instead of the pbf)
//
// Input is the Bengaluru OSM extract (.cache/osm/blr-region.osm.pbf, from scripts/osm-extract.sh or
// pages.yml; ODbL). osmium-tool, which the pack pipeline already needs, cuts the drivable highway ways
// in the bbox (whole ways) with their node locations, the traffic-signal nodes and the turn
// restriction relations; no npm dependency. The rest is plain JS:
//   1. keep motorway .. residential, living_street and road; service ways only when named, or when
//      an unnamed service network joins two parts of the road network that are otherwise separate
//      ("needed for connectivity"). Drop area=yes, car access no/private/..., reversible lanes,
//      driveways and parking aisles. oneway=yes/-1, junction=roundabout and motorways set direction.
//   2. split ways at shared nodes, then merge chains through degree-2 nodes whose two sides carry the
//      same class, speed, name, ref, bridge/tunnel and direction; each edge keeps its polyline and the
//      OSM way ids along it (with the vertex where each starts), for hotspot matching.
//   3. keep the largest strongly connected component (every kept node can reach every other: no snap
//      onto an island or a one-way trap), number nodes in Hilbert order, sort edges by node.
//   4. ALT landmarks: undirected lower-bound travel times from 12 peripheral nodes ("farthest" choice).
//   5. turn restrictions (type=restriction: no_* and only_*, via a node or via ways; not conditional
//      ones, nor those with except=motorcar) become arc sequences from, via, to. A via node, and each
//      end of a via way, is kept as a junction in step 2. A member way that gives no arc at the via
//      node (not drivable, not there, wrong way), or two (passing through it), drops the restriction
//      (counted in the stats).
// The file format is src/route/format.ts; speeds are src/route/config.ts, copied into the header.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { ROAD_CLASSES, SPEED_TABLE, edgeSpeedMps } from '../../src/route/config.ts';
import { BRIDGE, BWD, encodeGraph, FWD, TUNNEL } from '../../src/route/format.ts';

/** Bengaluru Urban (OSM relation 2020589), [w, s, e, n] */
export const BLR_BBOX = [77.38, 12.73, 77.79, 13.18];
/** a little past the district so trips that start near its edge still find their roads */
export const PAD = 0.02;
export const DEFAULT_BBOX = [BLR_BBOX[0] - PAD, BLR_BBOX[1] - PAD, BLR_BBOX[2] + PAD, BLR_BBOX[3] + PAD];
/** MG Road: the kept strongly connected network is the one this junction is in */
const CENTRE = [77.6075, 12.9755];
export const DEFAULT_LANDMARKS = 12;

const CLASS_IDX = new Map(ROAD_CLASSES.map((c, i) => [c, i]));
const SERVICE_SKIP = new Set(['driveway', 'parking_aisle', 'drive-through', 'emergency_access', 'parking']);
const ACCESS_NO = new Set(['no', 'private', 'agricultural', 'forestry', 'emergency', 'military', 'psv', 'bus', 'delivery', 'permit']);
const M_LAT = 110574;
const mLng = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

// ------------------------------------------------------------------------------------------ OPL input

const unesc = (s) => (s.includes('%') ? s.replace(/%([0-9a-fA-F]+)%/g, (_, h) => String.fromCodePoint(parseInt(h, 16))) : s);

function parseTags(f) {
  const tags = {};
  if (f) for (const kv of f.split(',')) {
    const i = kv.indexOf('=');
    if (i > 0) tags[unesc(kv.slice(0, i))] = unesc(kv.slice(i + 1));
  }
  return tags;
}

/**
 * OPL with way node locations (osmium add-locations-to-ways) -> ways, traffic-signal node ids and
 * type=restriction relations ({ id, tags, members: [{ type: 'n' | 'w' | 'r', ref, role }] }).
 * A way node without a location (outside the extract) has NaN coordinates; the way is split there.
 */
export function parseOpl(text) {
  const ways = [];
  const signals = new Set();
  const restrictions = [];
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    const kind = line[0];
    if (kind !== 'w' && kind !== 'n' && kind !== 'r') continue;
    const fields = line.split(' ');
    const id = Number(fields[0].slice(1));
    let tagsF = '', refsF = '';
    for (let i = 1; i < fields.length; i++) {
      if (fields[i][0] === 'T') tagsF = fields[i].slice(1);
      else if (fields[i][0] === 'N' || fields[i][0] === 'M') refsF = fields[i].slice(1);
    }
    if (kind === 'n') {
      if (/(^|,)highway=traffic_signals(,|$)/.test(tagsF)) signals.add(id);
      continue;
    }
    if (kind === 'r') {
      const tags = parseTags(tagsF);
      if (tags.type !== 'restriction') continue;
      const members = [];
      if (refsF)
        for (const r of refsF.split(',')) {
          const at = r.indexOf('@');
          members.push({ type: r[0], ref: Number(r.slice(1, at)), role: unesc(r.slice(at + 1)) });
        }
      restrictions.push({ id, tags, members });
      continue;
    }
    const ids = [], xs = [], ys = [];
    if (refsF)
      for (const r of refsF.split(',')) {
        const xi = r.indexOf('x'), yi = r.indexOf('y');
        ids.push(Number(r.slice(1, xi < 0 ? undefined : xi)));
        xs.push(xi < 0 || yi < 0 || yi === xi + 1 ? NaN : Number(r.slice(xi + 1, yi)));
        ys.push(xi < 0 || yi < 0 || yi === r.length - 1 ? NaN : Number(r.slice(yi + 1)));
      }
    ways.push({ id, tags: parseTags(tagsF), ids, xs, ys });
  }
  return { ways, signals, restrictions };
}

// ------------------------------------------------------------------------------------------ tags

function carAllowed(tags) {
  for (const k of ['motorcar', 'motor_vehicle', 'vehicle', 'access']) {
    const v = tags[k];
    if (v !== undefined) return !ACCESS_NO.has(v.split(';')[0].trim());
  }
  return true;
}

/** allowed directions along the way's node order (FWD / BWD bits); 0 = not routable (reversible lanes) */
export function directionOf(tags) {
  const v = tags['oneway:motorcar'] ?? tags['oneway:motor_vehicle'] ?? tags.oneway;
  if (v === 'yes' || v === 'true' || v === '1') return FWD;
  if (v === '-1' || v === 'reverse') return BWD;
  if (v === 'reversible' || v === 'alternating') return 0;
  if (v === 'no' || v === 'false' || v === '0') return FWD | BWD;
  if (tags.junction === 'roundabout' || tags.junction === 'circular') return FWD;
  if (tags.highway === 'motorway' || tags.highway === 'motorway_link') return FWD;
  return FWD | BWD;
}

export function maxspeedOf(tags) {
  const v = (tags['maxspeed:motorcar'] ?? tags.maxspeed ?? '').trim();
  const m = /^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?$/i.exec(v);
  if (!m) return 0;
  const k = parseFloat(m[1]) * (m[2] && m[2].toLowerCase() === 'mph' ? 1.609 : 1);
  return k >= 5 && k <= 200 ? Math.round(k) : 0;
}

/**
 * What a type=restriction relation means for cars: 'no' (no_left_turn, no_right_turn, no_straight_on,
 * no_u_turn, no_entry, no_exit), 'only' (only_*), or null: not a turn restriction, not for cars
 * (restriction:hgv=* alone, except=motorcar) or only at times (restriction:conditional, hour_on ...).
 */
export function restrictionOf(tags) {
  if (tags.type !== 'restriction') return null;
  const except = (tags.except ?? '').split(';').map((s) => s.trim());
  if (except.includes('motorcar') || except.includes('motor_vehicle') || except.includes('vehicle')) return null;
  if (tags.day_on || tags.day_off || tags.hour_on || tags.hour_off) return null;
  const m = /^(no|only)_(left_turn|right_turn|straight_on|u_turn|entry|exit)$/.exec((tags['restriction:motorcar'] ?? tags.restriction ?? '').trim());
  return m ? m[1] : null;
}

const named = (tags) => !!(tags.name || tags['name:en'] || tags.ref);

/** 'core', 'service' (unnamed service: kept only where it joins separate parts), or why it is dropped */
export function classify(tags) {
  if (!CLASS_IDX.has(tags.highway)) return 'class';
  if (tags.area === 'yes') return 'area';
  if (!carAllowed(tags)) return 'access';
  if (!directionOf(tags)) return 'reversible';
  if (tags.highway === 'service') {
    if (SERVICE_SKIP.has(tags.service)) return 'service-type';
    if (!named(tags)) return 'service';
  }
  return 'core';
}

// ------------------------------------------------------------------------------------------ helpers

function makeUF(n) {
  const p = new Int32Array(n);
  for (let i = 0; i < n; i++) p[i] = i;
  const find = (x) => {
    while (p[x] !== x) {
      p[x] = p[p[x]];
      x = p[x];
    }
    return x;
  };
  return { find, union: (a, b) => void (p[find(a)] = find(b)) };
}

class Heap {
  k = new Float64Array(1024);
  v = new Int32Array(1024);
  size = 0;
  push(key, val) {
    if (this.size === this.k.length) {
      const k2 = new Float64Array(this.size * 2), v2 = new Int32Array(this.size * 2);
      k2.set(this.k);
      v2.set(this.v);
      this.k = k2;
      this.v = v2;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p];
      this.v[i] = this.v[p];
      i = p;
    }
    this.k[i] = key;
    this.v[i] = val;
  }
  pop() {
    const top = this.v[0];
    const key = this.k[--this.size], val = this.v[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= key) break;
      this.k[i] = this.k[c];
      this.v[i] = this.v[c];
      i = c;
    }
    this.k[i] = key;
    this.v[i] = val;
    return top;
  }
}

/** Hilbert index of (x, y) on a 65536 x 65536 grid */
function hilbert(x, y) {
  const n = 65536;
  let d = 0;
  for (let s = n / 2; s >= 1; s /= 2) {
    const rx = x & s ? 1 : 0, ry = y & s ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = n - 1 - x;
        y = n - 1 - y;
      }
      const t = x;
      x = y;
      y = t;
    }
  }
  return d;
}

const flip = (d) => (d & FWD ? BWD : 0) | (d & BWD ? FWD : 0);

// ------------------------------------------------------------------------------------------ build

/**
 * Build the routable graph from parsed OPL. Returns { graph, stats }: `graph` is what encodeGraph
 * takes (header without the stream sizes), `stats` the counts reported by the CLI.
 */
export function buildGraph({ ways, signals, restrictions = [] }, opts = {}) {
  const bbox = opts.bbox ?? DEFAULT_BBOX;
  const nLandmarks = opts.landmarks ?? DEFAULT_LANDMARKS;
  const stats = { waysRead: ways.length, dropped: {}, coreWays: 0, serviceWays: 0, serviceJoins: 0, turnsRead: restrictions.length, turnsSkipped: {} };
  const skipTurn = (why) => (stats.turnsSkipped[why] = (stats.turnsSkipped[why] ?? 0) + 1);

  // ---- 1. which ways
  const core = [], svc = [];
  for (const w of ways) {
    const c = classify(w.tags);
    if (c === 'core') core.push(w);
    else if (c === 'service') svc.push(w);
    else stats.dropped[c] = (stats.dropped[c] ?? 0) + 1;
  }

  const dense = new Map();
  const nx = [], ny = [];
  const inside = (x, y) => x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3];
  /** runs of a way's located vertices in the bbox, each reaching one vertex past it */
  const piecesOf = (w) => {
    const n = w.ids.length, ok = new Uint8Array(n), keep = new Uint8Array(n), out = [];
    for (let i = 0; i < n; i++) ok[i] = Number.isFinite(w.xs[i]) && Number.isFinite(w.ys[i]) ? 1 : 0;
    for (let i = 0; i < n; i++)
      if (ok[i] && inside(w.xs[i], w.ys[i])) {
        keep[i] = 1;
        if (i > 0 && ok[i - 1]) keep[i - 1] = 1;
        if (i + 1 < n && ok[i + 1]) keep[i + 1] = 1;
      }
    let s = -1;
    for (let i = 0; i <= n; i++) {
      if (i < n && keep[i]) {
        if (s < 0) s = i;
        continue;
      }
      if (s >= 0) {
        const nodes = [];
        for (let j = s; j < i; j++) {
          let d = dense.get(w.ids[j]);
          if (d === undefined) {
            d = nx.length;
            dense.set(w.ids[j], d);
            nx.push(w.xs[j]);
            ny.push(w.ys[j]);
          }
          if (nodes[nodes.length - 1] !== d) nodes.push(d);
        }
        if (nodes.length >= 2) out.push({ w, nodes });
        s = -1;
      }
    }
    return out;
  };
  const corePieces = core.flatMap(piecesOf);
  const svcPieces = svc.flatMap(piecesOf);
  const N = nx.length;

  // unnamed service networks that join two or more otherwise separate parts, shortest first
  const ufCore = makeUF(N), isCore = new Uint8Array(N);
  for (const p of corePieces)
    for (let i = 0; i < p.nodes.length; i++) {
      isCore[p.nodes[i]] = 1;
      if (i) ufCore.union(p.nodes[i - 1], p.nodes[i]);
    }
  const ufSvc = makeUF(N);
  for (const p of svcPieces) for (let i = 1; i < p.nodes.length; i++) ufSvc.union(p.nodes[i - 1], p.nodes[i]);
  const groups = new Map();
  for (const p of svcPieces) {
    const r = ufSvc.find(p.nodes[0]);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = { pieces: [], len: 0 }));
    g.pieces.push(p);
    for (let i = 1; i < p.nodes.length; i++) {
      const a = p.nodes[i - 1], b = p.nodes[i];
      g.len += Math.hypot((nx[b] - nx[a]) * mLng(ny[a]), (ny[b] - ny[a]) * M_LAT);
    }
  }
  const keptSvc = [];
  for (const g of [...groups.values()].sort((a, b) => a.len - b.len)) {
    const roots = new Set();
    for (const p of g.pieces) for (const u of p.nodes) if (isCore[u]) roots.add(ufCore.find(u));
    if (roots.size < 2) continue;
    const [r0, ...rest] = roots;
    for (const r of rest) ufCore.union(r0, r);
    keptSvc.push(...g.pieces);
    stats.serviceJoins++;
  }
  const sel = corePieces.concat(keptSvc);
  stats.coreWays = new Set(corePieces.map((p) => p.w.id)).size;
  stats.serviceWays = new Set(keptSvc.map((p) => p.w.id)).size;

  // ---- 2. segments between shared nodes
  const names = [], nameIx = new Map();
  const intern = (s) => {
    s = (s ?? '').replace(/\s+/g, ' ').trim();
    if (!s) return -1;
    let i = nameIx.get(s);
    if (i === undefined) {
      i = names.length;
      names.push(s);
      nameIx.set(s, i);
    }
    return i;
  };
  const attrIx = new Map(), attrs = [];
  const wayAttr = new Map();
  const attrOf = (w) => {
    let a = wayAttr.get(w);
    if (a !== undefined) return a;
    const t = w.tags;
    const cls = CLASS_IDX.get(t.highway);
    const max = maxspeedOf(t);
    const name = intern(t.name || t['name:en']);
    const ref = intern(t.ref);
    const bt = (t.bridge && t.bridge !== 'no' ? BRIDGE : 0) | (t.tunnel && t.tunnel !== 'no' ? TUNNEL : 0);
    const key = `${cls}|${max}|${name}|${ref}|${bt}`;
    a = attrIx.get(key);
    if (a === undefined) {
      a = attrs.length;
      attrs.push({ cls, max, name, ref, bt });
      attrIx.set(key, a);
    }
    wayAttr.set(w, a);
    return a;
  };

  const refs = new Int32Array(N);
  for (const p of sel) for (const u of p.nodes) refs[u]++;
  const pinned = new Uint8Array(N);
  // car turn restrictions (step 5): their via nodes and the ends of via ways are never merged through
  const rels = [];
  const wayNodes = new Map(); // OSM way id -> its OSM node ids, for the ways restrictions name
  for (const r of restrictions) {
    const kind = restrictionOf(r.tags);
    if (!kind) {
      skipTurn('not-car');
      continue;
    }
    rels.push({ r, only: kind === 'only' ? 1 : 0 });
    for (const x of r.members) if (x.type === 'w') wayNodes.set(x.ref, null);
  }
  if (rels.length) for (const w of ways) if (wayNodes.has(w.id)) wayNodes.set(w.id, w.ids);
  for (const { r } of rels)
    for (const x of r.members) {
      if (x.role !== 'via') continue;
      const ids = x.type === 'n' ? [x.ref] : x.type === 'w' && wayNodes.get(x.ref) ? [wayNodes.get(x.ref)[0], wayNodes.get(x.ref).at(-1)] : [];
      for (const id of ids) {
        const d = dense.get(id);
        if (d !== undefined) pinned[d] = 1;
      }
    }
  const sA = [], sB = [], sAttr = [], sDir = [], sWay = [], sOff = [0], sNodes = [];
  const addSeg = (p, i0, i1) => {
    const a = p.nodes[i0], b = p.nodes[i1];
    if (a === b) {
      // a closed loop hanging off one node: split it in the middle so both halves can be routed
      if (i1 - i0 < 2) return;
      const mid = (i0 + i1) >> 1;
      pinned[p.nodes[mid]] = 1;
      addSeg(p, i0, mid);
      addSeg(p, mid, i1);
      return;
    }
    sA.push(a);
    sB.push(b);
    sAttr.push(attrOf(p.w));
    sDir.push(directionOf(p.w.tags));
    sWay.push(p.w.id);
    for (let i = i0; i <= i1; i++) sNodes.push(p.nodes[i]);
    sOff.push(sNodes.length);
  };
  for (const p of sel) {
    let s = 0;
    for (let i = 1; i < p.nodes.length; i++)
      if (i === p.nodes.length - 1 || refs[p.nodes[i]] >= 2) {
        addSeg(p, s, i);
        s = i;
      }
  }
  const S = sA.length;

  // ---- 2b. merge chains through degree-2 nodes with the same attributes
  const deg = new Int32Array(N + 1);
  for (let s = 0; s < S; s++) {
    deg[sA[s] + 1]++;
    deg[sB[s] + 1]++;
  }
  for (let i = 0; i < N; i++) deg[i + 1] += deg[i];
  const incOff = Int32Array.from(deg);
  const fill = Int32Array.from(deg);
  const inc = new Int32Array(incOff[N]);
  for (let s = 0; s < S; s++) {
    inc[fill[sA[s]]++] = s * 2;
    inc[fill[sB[s]]++] = s * 2 + 1;
  }
  const degree = (u) => incOff[u + 1] - incOff[u];
  const mergeable = (x) => {
    if (degree(x) !== 2 || pinned[x]) return false;
    const e1 = inc[incOff[x]], e2 = inc[incOff[x] + 1];
    const s1 = e1 >> 1, s2 = e2 >> 1;
    if (s1 === s2 || sAttr[s1] !== sAttr[s2]) return false;
    const d1 = e1 & 1 ? sDir[s1] : flip(sDir[s1]); // s1 travelled into x
    const d2 = e2 & 1 ? flip(sDir[s2]) : sDir[s2]; // s2 travelled out of x
    return d1 === d2;
  };
  const used = new Uint8Array(S);
  const edges = [];
  for (let r = 0; r < N; r++) {
    if (degree(r) === 0 || mergeable(r)) continue;
    for (let j = incOff[r]; j < incOff[r + 1]; j++) {
      let s = inc[j] >> 1;
      if (used[s]) continue;
      let atEnd = inc[j] & 1; // r is the B end of s: travel B -> A
      const nodes = [], ways = [];
      const dir = atEnd ? flip(sDir[s]) : sDir[s];
      const attr = sAttr[s];
      let next;
      for (;;) {
        used[s] = 1;
        const at = nodes.length ? nodes.length - 1 : 0;
        if (!ways.length || ways[ways.length - 1][0] !== sWay[s]) ways.push([sWay[s], at]);
        const o0 = sOff[s], o1 = sOff[s + 1];
        if (atEnd) for (let i = o1 - 1 - (nodes.length ? 1 : 0); i >= o0; i--) nodes.push(sNodes[i]);
        else for (let i = o0 + (nodes.length ? 1 : 0); i < o1; i++) nodes.push(sNodes[i]);
        next = atEnd ? sA[s] : sB[s];
        if (!mergeable(next)) break;
        const a = inc[incOff[next]], b = inc[incOff[next] + 1];
        const o = (a >> 1) === s ? b : a;
        s = o >> 1;
        atEnd = o & 1;
      }
      if (next === r) continue; // a loop back to its start
      edges.push({ u: r, v: next, nodes, ways, dir, attr });
    }
  }
  stats.segments = S;
  stats.edgesMerged = edges.length;

  // ---- 3. largest strongly connected component (containing the junction nearest the centre)
  const E = edges.length;
  const outOff = new Int32Array(N + 1), inOff = new Int32Array(N + 1);
  for (const e of edges) {
    if (e.dir & FWD) {
      outOff[e.u + 1]++;
      inOff[e.v + 1]++;
    }
    if (e.dir & BWD) {
      outOff[e.v + 1]++;
      inOff[e.u + 1]++;
    }
  }
  for (let i = 0; i < N; i++) {
    outOff[i + 1] += outOff[i];
    inOff[i + 1] += inOff[i];
  }
  const outAdj = new Int32Array(outOff[N]), inAdj = new Int32Array(inOff[N]);
  {
    const fo = Int32Array.from(outOff), fi = Int32Array.from(inOff);
    for (const e of edges) {
      if (e.dir & FWD) {
        outAdj[fo[e.u]++] = e.v;
        inAdj[fi[e.v]++] = e.u;
      }
      if (e.dir & BWD) {
        outAdj[fo[e.v]++] = e.u;
        inAdj[fi[e.u]++] = e.v;
      }
    }
  }
  const reach = (root, off, adj) => {
    const seen = new Uint8Array(N), stack = [root];
    seen[root] = 1;
    while (stack.length) {
      const u = stack.pop();
      for (let j = off[u]; j < off[u + 1]; j++) {
        const v = adj[j];
        if (!seen[v]) {
          seen[v] = 1;
          stack.push(v);
        }
      }
    }
    return seen;
  };
  const live = new Uint8Array(N);
  for (const e of edges) live[e.u] = live[e.v] = 1;
  const nLive = live.reduce((a, b) => a + b, 0);
  const centre = opts.centre ?? CENTRE;
  const byCentre = [];
  for (let i = 0; i < N; i++) if (live[i] && outOff[i + 1] - outOff[i] >= 2) byCentre.push(i);
  const dc = (i) => Math.hypot((nx[i] - centre[0]) * mLng(centre[1]), (ny[i] - centre[1]) * M_LAT);
  byCentre.sort((a, b) => dc(a) - dc(b));
  let keep = null, kept = 0;
  for (const root of byCentre.slice(0, 8)) {
    const f = reach(root, outOff, outAdj), b = reach(root, inOff, inAdj);
    const k = new Uint8Array(N);
    let c = 0;
    for (let i = 0; i < N; i++) if (f[i] && b[i]) (k[i] = 1), c++;
    if (c > kept) {
      keep = k;
      kept = c;
    }
    if (c > nLive / 2) break;
  }
  if (!keep) throw new Error('road graph: no edges');
  stats.nodesBeforeScc = nLive;
  stats.nodesDroppedScc = nLive - kept;

  // ---- renumber kept nodes in Hilbert order; edges sorted by (u, v)
  const keptIds = [];
  for (let i = 0; i < N; i++) if (keep[i]) keptIds.push(i);
  const hx = (x) => Math.max(0, Math.min(65535, Math.floor(((x - bbox[0]) / (bbox[2] - bbox[0] || 1)) * 65535)));
  const hy = (y) => Math.max(0, Math.min(65535, Math.floor(((y - bbox[1]) / (bbox[3] - bbox[1] || 1)) * 65535)));
  const hkey = new Map(keptIds.map((i) => [i, hilbert(hx(nx[i]), hy(ny[i]))]));
  keptIds.sort((a, b) => hkey.get(a) - hkey.get(b) || a - b);
  const newId = new Int32Array(N).fill(-1);
  keptIds.forEach((old, i) => (newId[old] = i));
  const n = keptIds.length;
  const kEdges = edges.filter((e) => keep[e.u] && keep[e.v]);
  for (const e of kEdges) {
    e.nu = newId[e.u];
    e.nv = newId[e.v];
  }
  kEdges.sort((a, b) => a.nu - b.nu || a.nv - b.nv);
  const m = kEdges.length;

  const nodeLng = new Float64Array(n), nodeLat = new Float64Array(n), nodeSignal = new Uint8Array(n);
  keptIds.forEach((old, i) => {
    nodeLng[i] = nx[old];
    nodeLat[i] = ny[old];
  });
  const osmOf = new Float64Array(N);
  for (const [osmId, d] of dense) osmOf[d] = osmId;
  const isSignal = (d) => signals.has(osmOf[d]);
  for (let i = 0; i < n; i++) if (isSignal(keptIds[i])) nodeSignal[i] = 1;

  const eU = new Int32Array(m), eV = new Int32Array(m), eFlags = new Uint8Array(m), eClass = new Uint8Array(m);
  const eMaxspeed = new Uint8Array(m), eSignals = new Uint8Array(m), eName = new Int32Array(m), eRef = new Int32Array(m);
  const eLen = new Float32Array(m);
  const wayOff = new Int32Array(m + 1), geoOff = new Int32Array(m + 1);
  const wayId = [], wayAt = [], geoLng = [], geoLat = [];
  let lengthM = 0;
  for (let e = 0; e < m; e++) {
    const E1 = kEdges[e];
    const a = attrs[E1.attr];
    eU[e] = E1.nu;
    eV[e] = E1.nv;
    eFlags[e] = E1.dir | a.bt;
    eClass[e] = a.cls;
    eMaxspeed[e] = Math.min(255, a.max);
    eName[e] = a.name;
    eRef[e] = a.ref;
    wayOff[e] = wayId.length;
    for (const [id, at] of E1.ways) {
      wayId.push(id);
      wayAt.push(at);
    }
    geoOff[e] = geoLng.length;
    let len = 0, sig = 0;
    for (let i = 0; i < E1.nodes.length; i++) {
      const d = E1.nodes[i];
      geoLng.push(nx[d]);
      geoLat.push(ny[d]);
      if (i) {
        const p = E1.nodes[i - 1];
        len += Math.hypot((nx[d] - nx[p]) * mLng((ny[d] + ny[p]) / 2), (ny[d] - ny[p]) * M_LAT);
      }
      if (i > 0 && i < E1.nodes.length - 1 && isSignal(d)) sig++;
    }
    eSignals[e] = Math.min(255, sig);
    // the browser reads decimetres into a Float32Array: weigh the landmarks with exactly that length
    eLen[e] = Math.round(len * 10) / 10;
    lengthM += eLen[e];
  }
  wayOff[m] = wayId.length;
  geoOff[m] = geoLng.length;
  stats.nodes = n;
  stats.edges = m;
  stats.lengthKm = Math.round(lengthM / 100) / 10;
  stats.polylinePoints = geoLng.length;
  stats.signals = nodeSignal.reduce((x, y) => x + y, 0);

  // ---- 4. ALT landmarks: undirected lower-bound times (no junction signal waits), farthest choice
  const lb = new Float64Array(m);
  for (let e = 0; e < m; e++) lb[e] = eLen[e] / edgeSpeedMps(SPEED_TABLE, eClass[e], eMaxspeed[e]) + eSignals[e] * SPEED_TABLE.signalS;
  const uOff = new Int32Array(n + 1);
  for (let e = 0; e < m; e++) {
    uOff[eU[e] + 1]++;
    uOff[eV[e] + 1]++;
  }
  for (let i = 0; i < n; i++) uOff[i + 1] += uOff[i];
  const uAdj = new Int32Array(uOff[n]);
  {
    const f = Int32Array.from(uOff);
    for (let e = 0; e < m; e++) {
      uAdj[f[eU[e]]++] = e;
      uAdj[f[eV[e]]++] = e;
    }
  }
  const dijkstra = (src) => {
    const dist = new Float64Array(n).fill(Infinity);
    const heap = new Heap();
    dist[src] = 0;
    heap.push(0, src);
    while (heap.size) {
      const key = heap.k[0];
      const u = heap.pop();
      if (key > dist[u]) continue;
      for (let j = uOff[u]; j < uOff[u + 1]; j++) {
        const e = uAdj[j];
        const v = eU[e] === u ? eV[e] : eU[e];
        const nd = key + lb[e];
        if (nd < dist[v]) {
          dist[v] = nd;
          heap.push(nd, v);
        }
      }
    }
    return dist;
  };
  const landmarks = [];
  const tables = [];
  if (n > 0 && nLandmarks > 0) {
    let root = 0, best = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot((nodeLng[i] - centre[0]) * mLng(centre[1]), (nodeLat[i] - centre[1]) * M_LAT);
      if (d < best) {
        best = d;
        root = i;
      }
    }
    const minD = dijkstra(root);
    for (let l = 0; l < nLandmarks; l++) {
      let far = -1, fd = -1;
      for (let i = 0; i < n; i++) if (minD[i] > fd && Number.isFinite(minD[i])) (fd = minD[i]), (far = i);
      if (far < 0 || landmarks.includes(far)) break;
      const d = dijkstra(far);
      landmarks.push(far);
      const tab = new Uint16Array(n);
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(d[i]) || d[i] >= 65535) throw new Error(`road graph: landmark ${far} -> node ${i}: ${d[i]} s does not fit u16`);
        tab[i] = Math.floor(d[i]);
        if (l === 0 || d[i] < minD[i]) minD[i] = d[i];
      }
      tables.push(tab);
    }
  }
  // node-major (what the router reads): lm[v * K + l]
  const K = landmarks.length;
  const lm = new Uint16Array(K * n);
  tables.forEach((tab, l) => {
    for (let i = 0; i < n; i++) lm[i * K + l] = tab[i];
  });
  stats.landmarks = landmarks.length;

  // ---- 5. turn restrictions -> arc sequences (an arc is 2 * edge, + 1 when driven v -> u)
  const nOff = new Int32Array(n + 1);
  for (let e = 0; e < m; e++) {
    nOff[eU[e] + 1]++;
    nOff[eV[e] + 1]++;
  }
  for (let i = 0; i < n; i++) nOff[i + 1] += nOff[i];
  const nEdge = new Int32Array(nOff[n]);
  {
    const f = Int32Array.from(nOff);
    for (let e = 0; e < m; e++) {
      nEdge[f[eU[e]]++] = e;
      nEdge[f[eV[e]]++] = e;
    }
  }
  const gnode = (osmId) => {
    const d = dense.get(osmId);
    return d === undefined ? -1 : newId[d];
  };
  const headOf = (a) => (a & 1 ? eU[a >> 1] : eV[a >> 1]);
  /** arcs into (into) or out of graph node x on edges whose OSM way at x is `way` */
  const arcsAt = (x, way, into) => {
    const out = [];
    for (let j = nOff[x]; j < nOff[x + 1]; j++) {
      const e = nEdge[j];
      const atU = eU[e] === x;
      if (wayId[atU ? wayOff[e] : wayOff[e + 1] - 1] !== way) continue;
      const back = atU === into ? 1 : 0; // driven u -> v, an edge leaves u and arrives at v
      if (eFlags[e] & (back ? BWD : FWD)) out.push(2 * e + back);
    }
    return out;
  };
  // why a restriction is dropped: 'missing' (the via node or a via way, or with via ways the from way,
  // is not in the extract or not in the graph: outside the bbox, not drivable, cut off), 'no-arc' (a
  // member way gives no arc at the via node: it does not reach it, is not drivable, or not in that
  // direction), 'ambiguous' (it passes through the via node, drivable on both sides), 'invalid'
  // (malformed: no from / to, via ways that do not chain), 'not-car' (step 2)
  const one = (arcs) => (arcs.length === 1 ? arcs[0] : arcs.length ? 'ambiguous' : 'no-arc');
  /** arcs from way F through `via` (one node, or ways in order) onto way T, or why there are none */
  const resolve = (F, via, T) => {
    let x, y;
    const viaArcs = [];
    if (via.length === 1 && via[0].type === 'n') {
      x = y = gnode(via[0].ref);
      if (x < 0) return 'missing';
    } else if (via.length && via.every((v) => v.type === 'w')) {
      const ends = (id) => (wayNodes.get(id) ? [wayNodes.get(id)[0], wayNodes.get(id).at(-1)] : null);
      const fn = wayNodes.get(F), e0 = ends(via[0].ref);
      if (!fn || !e0) return 'missing';
      // the via chain starts at the end of the first via way that lies on the from way
      const onF = e0.filter((id) => fn.includes(id));
      if (onF.length !== 1) return 'invalid';
      let at = onF[0];
      x = y = gnode(at);
      if (x < 0) return 'missing';
      for (const v of via) {
        const ev = ends(v.ref);
        if (!ev) return 'missing';
        if (ev[0] === ev[1] || (at !== ev[0] && at !== ev[1])) return 'invalid';
        at = at === ev[0] ? ev[1] : ev[0];
        const to = gnode(at);
        if (to < 0) return 'missing';
        // along the via way's edges to its far end
        let prev = -1;
        for (let guard = 0; y !== to; guard++) {
          const a = one(arcsAt(y, v.ref, false).filter((c) => c >> 1 !== prev));
          if (typeof a === 'string') return a;
          if (guard > 64) return 'invalid';
          viaArcs.push(a);
          prev = a >> 1;
          y = headOf(a);
        }
      }
    } else return 'invalid';
    const fa = one(arcsAt(x, F, true)), ta = one(arcsAt(y, T, false));
    if (typeof fa === 'string') return fa;
    if (typeof ta === 'string') return ta;
    return [fa, ...viaArcs, ta];
  };
  const seen = new Set();
  const turns = [];
  let viaWays = 0;
  for (const { r, only } of rels) {
    const role = (k) => r.members.filter((x) => x.role === k);
    const from = role('from').filter((x) => x.type === 'w'), via = role('via'), to = role('to').filter((x) => x.type === 'w');
    // no_entry / no_exit may list several from / to ways; only_* names exactly one of each
    if (!from.length || !to.length || (only && from.length + to.length > 2)) {
      skipTurn('invalid');
      continue;
    }
    let why = '', kept = 0;
    for (const f of from)
      for (const t of to) {
        const arcs = resolve(f.ref, via, t.ref);
        if (typeof arcs === 'string') {
          why ||= arcs;
          continue;
        }
        const key = `${only}|${arcs.join(',')}`;
        if (!seen.has(key)) {
          seen.add(key);
          turns.push({ only, arcs });
        }
        kept++;
      }
    if (!kept) skipTurn(why);
    else {
      stats.turns = (stats.turns ?? 0) + 1;
      if (via[0].type === 'w') viaWays++;
    }
  }
  turns.sort((a, b) => {
    for (let i = 0; i < Math.min(a.arcs.length, b.arcs.length); i++) if (a.arcs[i] !== b.arcs[i]) return a.arcs[i] - b.arcs[i];
    return a.arcs.length - b.arcs.length || a.only - b.only;
  });
  const turnOff = new Int32Array(turns.length + 1), turnArc = [], turnOnly = new Uint8Array(turns.length);
  turns.forEach((t, i) => {
    turnOff[i] = turnArc.length;
    turnArc.push(...t.arcs);
    turnOnly[i] = t.only;
  });
  turnOff[turns.length] = turnArc.length;
  stats.turns ??= 0;
  stats.turnsViaWay = viaWays;

  const graph = {
    header: {
      built: opts.built ?? new Date().toISOString(),
      source: opts.source ?? '',
      licence: opts.licence ?? 'ODbL 1.0, (c) OpenStreetMap contributors',
      bbox,
      speeds: SPEED_TABLE,
      landmarks,
      stats: {
        nodes: n,
        edges: m,
        lengthKm: stats.lengthKm,
        coreWays: stats.coreWays,
        serviceWays: stats.serviceWays,
        nodesDroppedScc: stats.nodesDroppedScc,
        turns: stats.turns,
      },
    },
    nodeLng,
    nodeLat,
    nodeSignal,
    eU,
    eV,
    eFlags,
    eClass,
    eMaxspeed,
    eSignals,
    eName,
    eRef,
    eLen,
    wayOff,
    wayId: Float64Array.from(wayId),
    wayAt: Int32Array.from(wayAt),
    geoOff,
    geoLng: Float64Array.from(geoLng),
    geoLat: Float64Array.from(geoLat),
    names,
    lm,
    turnOff,
    turnArc: Int32Array.from(turnArc),
    turnOnly,
  };
  return { graph, stats };
}

/** Encode, gzip and write `<out>/graph-<hash>.bin.gz` plus `<out>/index.json`; removes older graph files. */
export function writeGraph(graph, out) {
  const bin = encodeGraph(graph);
  const gz = gzipSync(bin, { level: 9 });
  const hash = createHash('sha256').update(gz).digest('hex').slice(0, 12);
  const file = `graph-${hash}.bin.gz`;
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(out)) if (/^graph-[0-9a-f]+\.bin\.gz$/.test(f) && f !== file) fs.rmSync(path.join(out, f));
  fs.writeFileSync(path.join(out, file), gz);
  const h = graph.header;
  const index = {
    version: 1,
    file,
    bytes: bin.length,
    gzipBytes: gz.length,
    built: h.built,
    source: h.source,
    licence: h.licence,
    bbox: h.bbox,
    nodes: graph.nodeLng.length,
    edges: graph.eU.length,
    landmarks: h.landmarks.length,
    lengthKm: h.stats?.lengthKm,
  };
  fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(index, null, 1) + '\n');
  return index;
}

// ------------------------------------------------------------------------------------------ CLI

function osmiumOpl(pbf, bbox, tmp) {
  const run = (args) => execFileSync('osmium', args, { stdio: ['ignore', 'ignore', 'inherit'] });
  const hw = path.join(tmp, 'hw.osm.pbf'), clip = path.join(tmp, 'clip.osm.pbf'), opl = path.join(tmp, 'roads.opl');
  run(['tags-filter', pbf, `w/highway=${ROAD_CLASSES.join(',')}`, 'r/type=restriction', '-o', hw, '--overwrite']);
  // complete_ways: a way crossing the bbox keeps all its nodes; buildGraph trims it to one past the edge
  // (a relation with any member in the bbox is kept too, with its full member list)
  run(['extract', '-b', bbox.join(','), '-s', 'complete_ways', hw, '-o', clip, '--overwrite']);
  // tagged nodes (traffic signals) and the relations stay in the output next to the ways
  run(['add-locations-to-ways', clip, '-f', 'opl,add_metadata=false', '-o', opl, '--overwrite']);
  return fs.readFileSync(opl, 'utf8');
}

function main() {
  const args = process.argv.slice(2);
  const arg = (k, d) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : d;
  };
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const pbf = path.resolve(root, arg('pbf', '.cache/osm/blr-region.osm.pbf'));
  const out = path.resolve(root, arg('out', 'public/data/roads'));
  const bbox = arg('bbox') ? arg('bbox').split(',').map(Number) : DEFAULT_BBOX;
  const landmarks = Number(arg('landmarks', DEFAULT_LANDMARKS));
  const t0 = Date.now();
  let text, source = '', built = new Date().toISOString(), licence;
  if (arg('opl')) text = fs.readFileSync(path.resolve(arg('opl')), 'utf8');
  else {
    if (!fs.existsSync(pbf)) throw new Error(`${pbf} is missing: run npm run data:osm (or see scripts/osm-extract.sh)`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roads-'));
    try {
      text = osmiumOpl(pbf, bbox, tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    // the extract's own record: same extract -> same bytes -> same file name (cached across deploys)
    const meta = path.join(path.dirname(pbf), path.basename(pbf).replace(/\.osm\.pbf$/, '.json'));
    if (fs.existsSync(meta)) {
      const j = JSON.parse(fs.readFileSync(meta, 'utf8'));
      source = j.source ?? '';
      built = j.built ?? built;
      licence = j.licence;
    }
  }
  const t1 = Date.now();
  const parsed = parseOpl(text);
  text = null;
  const { graph, stats } = buildGraph(parsed, { bbox, landmarks, source, built, licence });
  const t2 = Date.now();
  const index = writeGraph(graph, out);
  console.log(
    `[roads] ${stats.waysRead} ways read: ${stats.coreWays} kept, ${stats.serviceWays} unnamed service ways kept to join ${stats.serviceJoins} separate parts; dropped ${JSON.stringify(stats.dropped)}`,
  );
  console.log(
    `[roads] ${stats.segments} segments -> ${stats.edgesMerged} edges; strongly connected: ${stats.nodes} nodes (${stats.nodesDroppedScc} of ${stats.nodesBeforeScc} dropped), ${stats.edges} edges, ${stats.lengthKm} km, ${stats.polylinePoints} polyline points, ${stats.signals} signals, ${stats.landmarks} landmarks`,
  );
  console.log(
    `[roads] turn restrictions: ${stats.turns} of ${stats.turnsRead} kept (${stats.turns - stats.turnsViaWay} via a node, ${stats.turnsViaWay} via ways); dropped ${JSON.stringify(stats.turnsSkipped)}`,
  );
  console.log(
    `[roads] ${path.relative(root, out)}/${index.file}: ${(index.bytes / 1e6).toFixed(2)} MB raw, ${(index.gzipBytes / 1e6).toFixed(2)} MB gzipped (osmium ${((t1 - t0) / 1000).toFixed(1)} s, build ${((t2 - t1) / 1000).toFixed(1)} s, write ${((Date.now() - t2) / 1000).toFixed(1)} s)`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
