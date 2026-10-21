// @ts-nocheck -- node:test types are not part of the browser tsconfig
// Turn restrictions in the city router: OSM type=restriction relations read from OPL, resolved onto
// the graph (via a node, via one or two ways; except=motorcar, lorry-only and broken ones dropped),
// kept in the graph file (version 1 files still read), and obeyed by the search: no restricted turn,
// no U-turn but at a dead end or where only_u_turn asks for one. The router is checked against a brute
// force search over (arc, last arcs driven) that reads the restrictions as written.
// Run: node --test src/route/__tests__/turns.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, parseOpl, restrictionOf } from '../../../scripts/route/build-graph.mjs';
import { BWD, decodeGraph, encodeGraph, FWD, GRAPH_VERSION } from '../format.ts';
import { Router } from '../router.ts';

// ---------------------------------------------------------------------------------------- fixture
// Residential streets around 77.60 E, 12.97 N (grid columns 217 m apart, rows 221 m):
//   a 4 x 3 grid: South Street (row 0, a way per block, the west block one-way eastbound), Middle
//   Street (row 1, a way per block), North Street (row 2, one way to Lane 2 and another on to Lane 3),
//   Lanes 0-3 (columns, a way per block)
//   east of it the Ring Road, a dual carriageway (B N1 N2 T northbound, T S2 S1 B southbound, 22 m
//   apart) joined to the grid at both ends by Link Road, with two median gaps: Gap One at N1 / S1
//   (two ways meeting mid-median at M1) and Gap Two at N2 / S2; Gap Lane, a dead end, leaves S1
//   Long Road, a loop west of the grid in two ways with the same tags meeting at P, used by nothing else
const X = (i) => +(77.6 + 0.002 * i).toFixed(6);
const Y = (j) => +(12.97 + 0.002 * j).toFixed(6);
const nodes = new Map();
let nextNode = 1000;
const node = ([i, j]) => {
  const key = `${X(i)},${Y(j)}`;
  if (!nodes.has(key)) nodes.set(key, { id: nextNode++, lng: X(i), lat: Y(j) });
  return nodes.get(key).id;
};
const ways = [], rels = [];
const way = (id, tags, ...pts) => ways.push({ id, tags: { highway: 'residential', ...tags }, ids: pts.map(node) });

for (let j = 0; j < 2; j++)
  for (let i = 0; i < 3; i++) way(100 + 10 * j + i, { name: j ? 'Middle Street' : 'South Street', ...(i + j ? {} : { oneway: 'yes' }) }, [i, j], [i + 1, j]);
way(400, { name: 'North Street' }, [0, 2], [1, 2], [2, 2]);
way(401, { name: 'North Street' }, [2, 2], [3, 2]);
for (let j = 0; j < 2; j++) for (let i = 0; i < 4; i++) way(200 + 10 * j + i, { name: `Lane ${i}` }, [i, j], [i, j + 1]);

const B = [5, 0], N1 = [5, 0.66], N2 = [5, 1.33], T = [5, 2], S2 = [5.1, 1.33], S1 = [5.1, 0.66], M1 = [5.05, 0.66], END = [5.6, 0.66];
const ring = { name: 'Ring Road', oneway: 'yes' };
way(501, ring, B, N1);
way(502, ring, N1, N2);
way(503, ring, N2, T);
way(511, ring, T, S2);
way(512, ring, S2, S1);
way(513, ring, S1, B);
way(521, { name: 'Gap One' }, N1, M1);
way(522, { name: 'Gap One' }, M1, S1);
way(523, { name: 'Gap Two' }, N2, S2);
way(530, { name: 'Gap Lane' }, S1, END);
way(540, { name: 'Link Road' }, [3, 0], [4, 0], B);
way(541, { name: 'Link Road' }, [3, 2], [4, 2], T);

const P = [-1.5, 1];
way(601, { name: 'Long Road' }, [0, 0], [-1, 0], P);
way(602, { name: 'Long Road' }, P, [-1, 2], [0, 2]);
way(701, { name: 'Gated Lane', access: 'private' }, [1, 1], [1.5, 1.5]);

const rel = (id, tags, ...members) => rels.push({ id, tags: { type: 'restriction', ...tags }, members });
const w = (ref, role) => ({ type: 'w', ref, role });
const via = (ij) => ({ type: 'n', ref: node(ij), role: 'via' });
rel(9001, { restriction: 'no_left_turn' }, w(100, 'from'), via([1, 0]), w(201, 'to'));
rel(9002, { restriction: 'only_straight_on' }, w(111, 'from'), via([2, 1]), w(112, 'to'));
rel(9003, { restriction: 'no_u_turn' }, w(501, 'from'), w(521, 'via'), w(522, 'via'), w(513, 'to'));
rel(9004, { restriction: 'no_u_turn' }, w(502, 'from'), w(523, 'via'), w(512, 'to'));
rel(9005, { restriction: 'no_left_turn', except: 'psv;motorcar' }, w(102, 'from'), via([3, 0]), w(203, 'to'));
rel(9006, { restriction: 'no_right_turn' }, via([2, 0])); // no from, no to
rel(9007, { restriction: 'no_left_turn' }, w(110, 'from'), via([1, 1]), w(701, 'to')); // onto a gated lane
rel(9008, { restriction: 'no_left_turn' }, w(400, 'from'), via([1, 2]), w(211, 'to')); // North Street runs through
rel(9009, { restriction: 'no_right_turn' }, w(102, 'from'), { type: 'n', ref: 999999, role: 'via' }, w(203, 'to'));
rel(9010, { restriction: 'no_straight_on' }, w(601, 'from'), via(P), w(602, 'to'));
rel(9011, { restriction: 'only_u_turn' }, w(401, 'from'), via([3, 2]), w(401, 'to'));
rel(9012, { 'restriction:hgv': 'no_right_turn' }, w(101, 'from'), via([2, 0]), w(202, 'to'));
rel(9013, { restriction: 'no_left_turn' }, w(212, 'from'), via([2, 2]), w(400, 'to'));
// two via-way restrictions on South Street, the second inside the first: after its three blocks no left
// turn onto Lane 3, and after its last two not straight on to Link Road
rel(9014, { restriction: 'no_left_turn' }, w(100, 'from'), w(101, 'via'), w(102, 'via'), w(203, 'to'));
rel(9015, { restriction: 'no_straight_on' }, w(101, 'from'), w(102, 'via'), w(540, 'to'));

const esc = (s) => s.replace(/ /g, '%20%');
const tagsOpl = (tags) => Object.entries(tags).map(([k, v]) => `${esc(k)}=${esc(v)}`).join(',');
const byId = new Map([...nodes.values()].map((x) => [x.id, x]));
const opl = [
  ...[...nodes.values()].map((x) => `n${x.id} T x${x.lng} y${x.lat}`),
  ...ways.map((x) => `w${x.id} T${tagsOpl(x.tags)} N${x.ids.map((id) => `n${id}x${byId.get(id).lng}y${byId.get(id).lat}`).join(',')}`),
  ...rels.map((r) => `r${r.id} T${tagsOpl(r.tags)} M${r.members.map((m) => `${m.type}${m.ref}@${m.role}`).join(',')}`),
].join('\n');

const BBOX = [77.58, 12.95, 77.625, 12.99];
const built = buildGraph(parseOpl(opl), { bbox: BBOX, landmarks: 4, centre: [X(1), Y(1)], built: '2026-10-21T00:00:00Z', source: 'test' });
const raw = decodeGraph(encodeGraph(built.graph));
const router = new Router(raw);
const dijkstra = new Router(raw, { heuristic: false });
const A = router.outHead.length;

/** graph node at grid point [i, j] */
const at = ([i, j]) => {
  for (let v = 0; v < raw.header.n; v++) if (Math.abs(raw.nodeLng[v] - X(i)) < 1e-9 && Math.abs(raw.nodeLat[v] - Y(j)) < 1e-9) return v;
  throw new Error(`no graph node at ${i}, ${j}`);
};
/** the arc from grid point a to grid point b */
const arc = (a, b) => {
  const u = at(a), v = at(b), js = [];
  for (let j = router.outOff[u]; j < router.outOff[u + 1]; j++) if (router.outHead[j] === v) js.push(j);
  assert.equal(js.length, 1, `one arc ${a} -> ${b}`);
  return js[0];
};
const waysOf = (e) => Array.from(raw.wayId.subarray(raw.wayOff[e], raw.wayOff[e + 1]));
const wayIds = (c) => c.ways.map((x) => x.id);
const snapAt = (v) => {
  for (let e = 0; e < raw.header.m; e++) {
    if (raw.eU[e] === v) return { e, t: 0, p: [raw.nodeLng[v], raw.nodeLat[v]], distM: 0 };
    if (raw.eV[e] === v) return { e, t: raw.eLen[e], p: [raw.nodeLng[v], raw.nodeLat[v]], distM: 0 };
  }
};

// ---------------------------------------------------------------------------------------- brute force
// The restrictions as written: no_* forbids its arc sequence; only_* forbids every other way on from
// its prefix and allows its own, U-turn or not; otherwise a U-turn only where nothing else leads on.
const pats = [];
for (let r = 0; r < raw.turnOnly.length; r++)
  pats.push({ only: raw.turnOnly[r] === 1, arcs: Array.from(raw.turnArc.subarray(raw.turnOff[r], raw.turnOff[r + 1]), (c) => (c % 2 ? router.arcBwd : router.arcFwd)[Math.floor(c / 2)]) });
const KEEP = Math.max(...pats.map((p) => p.arcs.length - 1));
const endsWith = (seq, p) => p.length <= seq.length && p.every((a, k) => seq[seq.length - p.length + k] === a);
/** may a car that drove `seq` (its last arcs) go on along arc j? */
const may = (seq, j) => {
  const i = seq[seq.length - 1], u = router.outHead[i];
  if (j < router.outOff[u] || j >= router.outOff[u + 1]) return false;
  let explicit = false;
  for (const p of pats) {
    if (p.only && endsWith(seq, p.arcs.slice(0, -1))) {
      if (j !== p.arcs[p.arcs.length - 1]) return false;
      explicit = true;
    } else if (!p.only && endsWith([...seq, j], p.arcs)) return false;
  }
  return explicit || router.outEdge[j] !== router.outEdge[i] || router.outOff[u + 1] - router.outOff[u] === 1;
};
const drivable = (arcs) => arcs.every((j, k) => k === 0 || may(arcs.slice(Math.max(0, k - KEEP), k), j));
const SIG = raw.header.speeds.signalS;
const weight = (j, mult, avoid, avoidS) => {
  const e = router.outEdge[j];
  let x = router.outW[j];
  if (mult) x *= mult[e];
  if (avoid && avoid[e]) x += avoidS;
  return x;
};
/** Dijkstra from snap s over states = the last KEEP arcs driven; returns t -> best cost (Infinity = none) */
function oracle(s, mult = null, avoid = null, avoidS = 0) {
  const best = new Map(), open = [], done = new Set();
  const push = (seq, d) => {
    const key = seq.join(',');
    if ((best.get(key)?.d ?? Infinity) <= d) return;
    best.set(key, { seq, d });
    open.push({ key, d });
  };
  const Ls = raw.eLen[s.e];
  if (raw.eFlags[s.e] & FWD) push([router.arcFwd[s.e]], (Ls - s.t) * router.spm[s.e] + raw.nodeSignal[raw.eV[s.e]] * SIG);
  if (raw.eFlags[s.e] & BWD) push([router.arcBwd[s.e]], s.t * router.spm[s.e] + raw.nodeSignal[raw.eU[s.e]] * SIG);
  while (open.length) {
    let k = 0;
    for (let q = 1; q < open.length; q++) if (open[q].d < open[k].d) k = q;
    const { key, d } = open.splice(k, 1)[0];
    if (done.has(key) || best.get(key).d < d) continue;
    done.add(key);
    const { seq } = best.get(key);
    const u = router.outHead[seq[seq.length - 1]];
    for (let j = router.outOff[u]; j < router.outOff[u + 1]; j++) if (may(seq, j)) push([...seq, j].slice(-KEEP), d + weight(j, mult, avoid, avoidS));
  }
  return (t) => {
    let c = Infinity;
    if (s.e === t.e) {
      if (raw.eFlags[s.e] & FWD && s.t <= t.t) c = (t.t - s.t) * router.spm[s.e];
      if (raw.eFlags[s.e] & BWD && s.t >= t.t) c = Math.min(c, (s.t - t.t) * router.spm[s.e]);
    }
    const ends = [];
    if (raw.eFlags[t.e] & FWD) ends.push([router.arcFwd[t.e], t.t * router.spm[t.e]]);
    if (raw.eFlags[t.e] & BWD) ends.push([router.arcBwd[t.e], (raw.eLen[t.e] - t.t) * router.spm[t.e]]);
    for (const { seq, d } of best.values()) for (const [ta, tc] of ends) if (may(seq, ta)) c = Math.min(c, d + tc);
    return c;
  };
}
/** the cost of a path given as arcs (unweighted: no mult, no avoid) */
const costOf = (s, t, arcs) => {
  if (arcs.length === 1) return Math.abs(t.t - s.t) * router.spm[s.e];
  const a0 = arcs[0], a1 = arcs[arcs.length - 1];
  let c = router.outAlong[a0] ? (raw.eLen[s.e] - s.t) * router.spm[s.e] + raw.nodeSignal[raw.eV[s.e]] * SIG : s.t * router.spm[s.e] + raw.nodeSignal[raw.eU[s.e]] * SIG;
  for (let k = 1; k + 1 < arcs.length; k++) c += router.outW[arcs[k]];
  return c + (router.outAlong[a1] ? t.t : raw.eLen[t.e] - t.t) * router.spm[t.e];
};
// points on the trips below, mid-edge
const MID = [[X(0.5), Y(0)], [X(1), Y(0.5)], [X(1.5), Y(1)], [X(2), Y(1.5)], [X(5), Y(0.33)], [X(5.05), Y(0.33)], [X(5), Y(0.995)], [X(5.1), Y(0.995)], [X(-1.4), Y(0.8)], [X(-1.4), Y(1.2)], [X(2.5), Y(2)], [X(5.3), Y(0.66)]];
const PTS = [...Array(raw.header.n).keys()].map(snapAt).concat(MID.map((p) => router.snap(p)));

// ---------------------------------------------------------------------------------------- build

test('parseOpl reads restriction relations; restrictionOf keeps what applies to cars at all times', () => {
  const p = parseOpl('r7 Ttype=restriction,restriction=no_left_turn Mw1@from,n2@via,w3@to\nr8 Ttype=multipolygon Mw1@outer');
  assert.deepEqual(p.restrictions, [
    { id: 7, tags: { type: 'restriction', restriction: 'no_left_turn' }, members: [{ type: 'w', ref: 1, role: 'from' }, { type: 'n', ref: 2, role: 'via' }, { type: 'w', ref: 3, role: 'to' }] },
  ]);
  const r = (tags) => restrictionOf({ type: 'restriction', ...tags });
  assert.equal(r({ restriction: 'no_left_turn' }), 'no');
  assert.equal(r({ restriction: 'only_straight_on' }), 'only');
  assert.equal(r({ restriction: 'no_entry' }), 'no');
  assert.equal(r({ restriction: 'no_u_turn', except: 'psv;bicycle' }), 'no');
  assert.equal(r({ restriction: 'no_u_turn', except: 'bicycle;motorcar' }), null);
  assert.equal(r({ 'restriction:hgv': 'no_left_turn' }), null);
  assert.equal(r({ restriction: 'no_left_turn', 'restriction:motorcar': 'only_right_turn' }), 'only');
  assert.equal(r({ 'restriction:conditional': 'no_u_turn @ (Mo-Fr 08:00-11:00)' }), null);
  assert.equal(r({ restriction: 'no_right_turn', hour_on: '08:00', hour_off: '11:00' }), null);
  assert.equal(r({ restriction: 'give_way' }), null);
  assert.equal(restrictionOf({ type: 'multipolygon', restriction: 'no_left_turn' }), null);
});

test('build: restrictions become arc sequences; not for cars, broken, ambiguous and moot ones are dropped', () => {
  const st = built.stats;
  assert.equal(st.turnsRead, 15);
  assert.equal(st.turns, 9);
  assert.equal(st.turnsViaWay, 4);
  assert.deepEqual(st.turnsSkipped, { 'not-car': 2, invalid: 1, 'no-arc': 1, ambiguous: 1, missing: 1 });
  // via a node 2 arcs, via one way 3, via two ways 4; two only_* (straight on, U-turn)
  const lens = [];
  for (let r = 0; r < raw.turnOnly.length; r++) lens.push(raw.turnOff[r + 1] - raw.turnOff[r]);
  assert.deepEqual(lens.sort(), [2, 2, 2, 2, 2, 3, 3, 4, 4]);
  assert.equal(raw.turnOnly.reduce((a, b) => a + b, 0), 2);
  assert.equal(router.turns.count, 9);
  assert.equal(router.turns.extraArc.length, 6, 'an extra state per proper prefix of the via-way restrictions');
  assert.equal(router.states, A + 6);
  // the via node P and Gap One's middle (the end of a via way) are kept as junctions, though only two
  // ways with the same tags meet there
  for (let e = 0; e < raw.header.m; e++) {
    const ws = waysOf(e);
    assert.ok(!(ws.includes(601) && ws.includes(602)), 'Long Road not merged across P');
    assert.ok(!(ws.includes(521) && ws.includes(522)), 'Gap One not merged across M1');
  }
  assert.ok(at(P) >= 0 && at(M1) >= 0);
});

test('format: restrictions round-trip; a version 1 file still reads, with none; a newer one is refused', () => {
  const bytes = encodeGraph(raw);
  const again = decodeGraph(bytes);
  for (const k of ['turnOff', 'turnArc', 'turnOnly']) assert.deepEqual(Array.from(again[k]), Array.from(raw[k]), k);
  const hl = new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + hl)));
  const body = bytes.subarray(8 + hl);
  const file = (h, b) => {
    const hj = new TextEncoder().encode(JSON.stringify(h));
    const out = new Uint8Array(8 + hj.length + b.length);
    out.set(bytes.subarray(0, 4));
    new DataView(out.buffer).setUint32(4, hj.length, true);
    out.set(hj, 8);
    out.set(b, 8 + hj.length);
    return out;
  };
  // version 1: no turn counts in the header, no turns stream (the last one) in the file
  const v1 = { ...header, version: 1, streams: { ...header.streams } };
  delete v1.turns;
  delete v1.turnArcs;
  delete v1.streams.turns;
  const old = decodeGraph(file(v1, body.subarray(0, body.length - header.streams.turns)));
  assert.equal(old.turnOnly.length, 0);
  for (const k of ['eU', 'eV', 'eFlags', 'eLen', 'wayId', 'geoLng', 'lm']) assert.deepEqual(Array.from(old[k]), Array.from(raw[k]), k);
  const plain = new Router(old);
  assert.equal(plain.turns.count, 0);
  const [r] = plain.route([X(0.5), Y(0)], [X(1), Y(0.5)], { alternatives: 1 });
  assert.deepEqual(wayIds(r), [100, 201], 'without the restriction the left turn is taken');
  assert.throws(() => decodeGraph(file({ ...header, version: GRAPH_VERSION + 1 }, body)), new RegExp(`version ${GRAPH_VERSION + 1}, this app reads 1 to ${GRAPH_VERSION}`));
});

// ---------------------------------------------------------------------------------------- router

test('legal: restricted turns are out; U-turns only at a dead end or where only_u_turn asks for one', () => {
  assert.equal(router.legal([arc([0, 0], [1, 0]), arc([1, 0], [1, 1])]), false, 'no left turn onto Lane 1');
  assert.equal(router.legal([arc([0, 0], [1, 0]), arc([1, 0], [2, 0])]), true, 'straight on');
  assert.equal(router.legal([arc([1, 0], [2, 0]), arc([2, 0], [1, 0])]), false, 'U-turn at a junction');
  assert.equal(router.legal([arc(S1, END), arc(END, S1)]), true, 'U-turn at the end of Gap Lane');
  assert.equal(router.legal([arc([1, 1], [2, 1]), arc([2, 1], [3, 1])]), true, 'only straight on');
  assert.equal(router.legal([arc([1, 1], [2, 1]), arc([2, 1], [2, 2])]), false);
  assert.equal(router.legal([arc([1, 0], [2, 0]), arc([2, 0], [2, 1]), arc([2, 1], [2, 2])]), true, 'from Lane 2 any way');
  // only_u_turn at the east end of North Street: back is the only way on
  assert.equal(router.legal([arc([2, 2], [3, 2]), arc([3, 2], [2, 2])]), true);
  assert.equal(router.legal([arc([2, 2], [3, 2]), arc([3, 2], [3, 1])]), false);
  assert.equal(router.legal([arc([2, 2], [3, 2]), arc([3, 2], T)]), false);
  // via two ways: Ring Road north, Gap One, Ring Road south is out; Gap One into Gap Lane is fine,
  // and so is Gap One onto the Ring Road south for a car that did not come up the Ring Road
  const gap = [arc(B, N1), arc(N1, M1), arc(M1, S1)];
  assert.equal(router.legal([...gap, arc(S1, B)]), false);
  assert.equal(router.legal([...gap, arc(S1, END)]), true);
  assert.equal(router.legal([arc(N1, M1), arc(M1, S1), arc(S1, B)]), true);
  assert.equal(router.legal([arc(N1, N2), arc(N2, S2), arc(S2, S1)]), false, 'via one way: Gap Two');
  // on South Street the longer restriction needs all three blocks; the shorter one binds within it too
  const south = [arc([0, 0], [1, 0]), arc([1, 0], [2, 0]), arc([2, 0], [3, 0])];
  assert.equal(router.legal([...south, arc([3, 0], [3, 1])]), false);
  assert.equal(router.legal([...south.slice(1), arc([3, 0], [3, 1])]), true);
  assert.equal(router.legal([...south, arc([3, 0], B)]), false);
  assert.equal(router.legal([...south.slice(1), arc([3, 0], B)]), false);
  assert.equal(router.legal([...south.slice(2), arc([3, 0], B)]), true);
});

test('legal: every walk of up to 5 arcs agrees with the restrictions as written', () => {
  let walks = 0, out = 0;
  const go = (seq) => {
    const want = drivable(seq);
    assert.equal(router.legal(seq), want, seq.join(' '));
    walks++;
    if (!want) out++;
    if (seq.length === 5) return;
    const u = router.outHead[seq[seq.length - 1]];
    for (let j = router.outOff[u]; j < router.outOff[u + 1]; j++) go([...seq, j]);
  };
  for (let j = 0; j < A; j++) go([j]);
  assert.ok(walks > 5000 && out > walks / 4, `${out} of ${walks} walks ruled out`);
});

test('route: no left turn onto Lane 1, so round the block (a U-turn at Lane 2 would be shorter)', () => {
  const from = [X(0.5), Y(0)], to = [X(1), Y(0.5)];
  const [r] = router.route(from, to, { alternatives: 1 });
  assert.deepEqual(wayIds(r), [100, 101, 202, 111, 201]);
  // 108 m on, 217 + 221 + 217 m round the block, 111 m down Lane 1; turning back at Lane 2 is 653 m
  assert.ok(r.lengthM > 860 && r.lengthM < 890, `${r.lengthM}`);
  // the search over nodes alone turns left; its path is not legal, so the edge-based search ran
  const s = router.snap(from), t = router.snap(to);
  const free = router.searchNodes(s, t, null, null, 0);
  assert.equal(router.legal(free.arcs), false);
  assert.ok(free.cost < router.search(s, t, null, null, 0).cost);
});

test('route: only straight on from Middle Street at Lane 2: the trip north turns a block earlier', () => {
  const [r] = router.route([X(1.5), Y(1)], [X(2), Y(1.5)], { alternatives: 1 });
  assert.deepEqual(wayIds(r), [111, 211, 400, 212]);
  assert.ok(r.lengthM > 645 && r.lengthM < 670, `${r.lengthM}`);
  const [s] = router.route([X(1.5), Y(1)], [X(2.5), Y(1)], { alternatives: 1 });
  assert.deepEqual(wayIds(s), [111, 112], 'straight on is fine');
});

test('route: no U-turn through a median gap (via two ways, via one way); a dead end to turn in is fine', () => {
  // up the Ring Road to its other side: Gap One is closed to the U-turn, so the car crosses into Gap
  // Lane, turns round at its end and comes back (73 + 22 + 2 x 108 + 74 m)
  const [a] = router.route([X(5), Y(0.33)], [X(5.05), Y(0.33)], { alternatives: 1 });
  assert.deepEqual(wayIds(a), [501, 521, 522, 530, 513]);
  assert.ok(a.lengthM > 370 && a.lengthM < 400, `${a.lengthM}`);
  // Gap Two too, and no dead end there: round the top (74 + 148 + 150 + 74 m)
  const [b] = router.route([X(5), Y(0.995)], [X(5.1), Y(0.995)], { alternatives: 1 });
  assert.deepEqual(wayIds(b), [502, 503, 511, 512]);
  assert.ok(b.lengthM > 430 && b.lengthM < 460, `${b.lengthM}`);
});

test('route: no left turn from Lane 2 onto North Street, and only a U-turn at its east end: turn there', () => {
  // right, U-turn at Lane 3 and back past Lane 2 (110 + 2 x 217 + 43 m); round by Lane 1 is 722 m
  const [r] = router.route([X(2), Y(1.5)], [X(1.8), Y(2)], { alternatives: 1 });
  assert.deepEqual(wayIds(r), [212, 401, 400]);
  assert.ok(r.lengthM > 575 && r.lengthM < 600, `${r.lengthM}`);
});

test('route: no straight on at P, where Long Road is kept split: round by the grid', () => {
  const [r] = router.route([X(-1.4), Y(0.8)], [X(-1.4), Y(1.2)], { alternatives: 1 });
  assert.deepEqual(wayIds(r), [601, 200, 210, 602]);
  assert.ok(r.lengthM > 1200, `${r.lengthM} (98 m straight through P)`);
});

test('route: a restriction with except=motorcar, or for lorries only, does not bind cars', () => {
  const [r] = router.route([X(2.5), Y(0)], [X(3), Y(0.5)], { alternatives: 1 });
  assert.deepEqual(wayIds(r), [102, 203]);
  const [q] = router.route([X(1.5), Y(0)], [X(2), Y(0.5)], { alternatives: 1 });
  assert.deepEqual(wayIds(q), [101, 202]);
});

test('search: A*, Dijkstra and the edge-based search match a brute force over every pair of points', () => {
  let pairs = 0, bitten = 0;
  for (const s of PTS) {
    const best = oracle(s);
    for (const t of PTS) {
      if (s === t) continue;
      const want = best(t);
      const runs = [
        ['A*', router.search(s, t, null, null, 0)],
        ['Dijkstra', dijkstra.search(s, t, null, null, 0)],
        ['edge-based A*', router.searchArcs(s, t, null, null, 0)],
        ['edge-based Dijkstra', dijkstra.searchArcs(s, t, null, null, 0)],
      ];
      for (const [name, r] of runs) {
        assert.equal(r === null, want === Infinity, `${name} ${pairs}: found ${!!r}, brute force ${want}`);
        if (!r) continue;
        assert.ok(Math.abs(r.cost - want) < 1e-6, `${name} ${pairs}: ${r.cost} vs ${want}`);
        assert.ok(drivable(r.arcs) && router.legal(r.arcs), `${name} ${pairs}: path drivable`);
        assert.ok(Math.abs(costOf(s, t, r.arcs) - r.cost) < 1e-6, `${name} ${pairs}: arcs add up to the cost`);
        assert.equal(router.outEdge[r.arcs[0]], s.e);
        assert.equal(router.outEdge[r.arcs[r.arcs.length - 1]], t.e);
      }
      const free = router.searchNodes(s, t, null, null, 0);
      if (free && free.cost < want - 1e-6) bitten++;
      pairs++;
    }
  }
  assert.ok(pairs > 800, `${pairs} pairs`);
  assert.ok(bitten > 80, `restrictions change ${bitten} of ${pairs} trips`);
});

test('search: with the weights of alternatives and avoided edges too', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 3; round++) {
    const mult = Float32Array.from({ length: raw.header.m }, () => 1 + 2 * rnd());
    const avoid = Uint8Array.from({ length: raw.header.m }, () => (rnd() < 0.15 ? 1 : 0));
    for (const s of PTS.filter((_, k) => k % 3 === round)) {
      const best = oracle(s, mult, avoid, 600);
      for (const t of PTS) {
        if (s === t) continue;
        const want = best(t), r = router.search(s, t, mult, avoid, 600);
        assert.equal(r === null, want === Infinity);
        if (r) {
          assert.ok(Math.abs(r.cost - want) < 1e-6, `${r.cost} vs ${want}`);
          assert.ok(drivable(r.arcs));
        }
      }
    }
  }
});

test('route: alternatives obey the restrictions too', () => {
  for (const [from, to] of [[[X(0.5), Y(0)], [X(1), Y(0.5)]], [[X(5), Y(0.33)], [X(5.05), Y(0.33)]], [[X(1.5), Y(1)], [X(2), Y(1.5)]]]) {
    const rs = router.route(from, to);
    assert.ok(rs.length >= 1);
    for (const r of rs) {
      // none turns left from South Street onto Lane 1, U-turns through Gap One or turns north at Lane 2
      // from Middle Street
      const ids = wayIds(r).join(',');
      assert.ok(!/(^|,)100,201(,|$)/.test(ids) && !/(^|,)501,521,522,513(,|$)/.test(ids) && !/(^|,)111,212(,|$)/.test(ids), ids);
    }
  }
});
