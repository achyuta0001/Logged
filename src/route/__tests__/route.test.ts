// @ts-nocheck -- node:test types are not part of the browser tsconfig
// City-wide router: graph build on a small synthetic OSM extract (OPL, the format osmium hands the
// builder), the file format round trip, and the router (shortest paths, one-ways, roundabouts,
// alternatives, avoid, snapping). Run: node --test src/route/__tests__/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, classify, directionOf, maxspeedOf, parseOpl } from '../../../scripts/route/build-graph.mjs';
import { BWD, decodeGraph, encodeGraph, FWD } from '../format.ts';
import { MAX_SHARED, MAX_STRETCH, Router } from '../router.ts';

// ---------------------------------------------------------------------------------------- fixture
// A 5 x 3 street grid (columns 200 m apart, rows 220 m apart) around 77.60 E, 12.97 N:
//   row 0  Main Road (tertiary), split into two OSM ways at column 2
//   row 1  Middle Street (residential), with a traffic signal at column 2, and a flyover deck
//          (Test Flyover, bridge=yes) running 45 m north of it between columns 0 and 4
//   row 2  North Street (residential)
//   columns 0 and 4: West / East Lane; column 2: Centre Lane, one-way northbound
// plus: a roundabout below column 2; a gated lane (access=private, dropped) and a private lane open to
// cars (motorcar=yes, kept) at column 1; Island Road east of column 4 reachable only through an
// unnamed service road (kept for connectivity) and an unnamed service shortcut that joins nothing new
// (dropped); a parking aisle (dropped); a one-way dead end north of East Lane (not strongly connected,
// dropped); and Long Road, two ways with the same tags meeting at a node no other way uses (merged).
const X = (i) => +(77.6 + 0.002 * i).toFixed(6);
const Y = (j) => +(12.97 + 0.002 * j).toFixed(6);
const nodes = new Map();
let nextNode = 1000;
const node = (lng, lat) => {
  const key = `${lng},${lat}`;
  if (!nodes.has(key)) nodes.set(key, { id: nextNode++, lng, lat });
  return nodes.get(key).id;
};
const at = (i, j) => node(X(i), Y(j));
const ways = [];
const way = (id, tags, ids) => ways.push({ id, tags, ids });

way(1, { highway: 'tertiary', name: 'Main Road' }, [at(0, 0), at(1, 0), at(2, 0)]);
way(2, { highway: 'tertiary', name: 'Main Road' }, [at(2, 0), at(3, 0), at(4, 0)]);
way(3, { highway: 'residential', name: 'Middle Street' }, [at(0, 1), at(1, 1), at(2, 1), at(3, 1), at(4, 1)]);
way(4, { highway: 'residential', name: 'North Street' }, [at(0, 2), at(1, 2), at(2, 2), at(3, 2), at(4, 2)]);
way(5, { highway: 'residential', name: 'West Lane' }, [at(0, 0), at(0, 1), at(0, 2)]);
way(6, { highway: 'residential', name: 'East Lane' }, [at(4, 0), at(4, 1), at(4, 2)]);
way(7, { highway: 'residential', name: 'Centre Lane', oneway: 'yes' }, [at(2, 0), at(2, 1), at(2, 2)]);
const deck = [at(0, 1), node(X(0.5), Y(1.225)), node(X(2), Y(1.225)), node(X(3.5), Y(1.225)), at(4, 1)];
way(8, { highway: 'primary', name: 'Test Flyover', bridge: 'yes', layer: '1' }, deck);
// roundabout south of column 2: entry at r0, ring r0 -> r1 -> r2 -> r3 -> r0 (anticlockwise)
const r0 = node(X(2), Y(-0.5)), r1 = node(X(2.25), Y(-0.75)), r2 = node(X(2), Y(-1)), r3 = node(X(1.75), Y(-0.75));
way(9, { highway: 'residential', name: 'Roundabout Road' }, [at(2, 0), r0]);
way(10, { highway: 'tertiary', junction: 'roundabout', name: 'Test Circle' }, [r0, r1, r2, r3, r0]);
way(11, { highway: 'residential', name: 'Exit Road' }, [r1, node(X(3), Y(-0.75))]);
way(12, { highway: 'residential', name: 'Exit Road' }, [node(X(3), Y(-0.75)), at(3, 0)]);
way(13, { highway: 'residential', name: 'Gated Lane', access: 'private' }, [at(1, 1), at(1, 2)]);
way(14, { highway: 'residential', name: 'Car Lane', access: 'private', motorcar: 'yes' }, [at(1, 0), at(1, 1)]);
way(15, { highway: 'residential', name: 'Island Road' }, [at(5, 1), at(6, 1), at(6, 2)]);
way(16, { highway: 'service' }, [at(4, 1), at(5, 1)]);
way(17, { highway: 'service' }, [at(3, 0), at(3, 1)]);
way(18, { highway: 'service', service: 'parking_aisle', name: 'Mall Parking' }, [at(1, 2), at(1, 3)]);
way(19, { highway: 'residential', name: 'Trap Lane', oneway: 'yes' }, [at(4, 2), at(4, 3)]);
// Long Road: west of column 0, two ways meeting at a node only they use
const lr = [at(-1, 0), node(X(-1.5), Y(0)), node(X(-2), Y(0.5)), node(X(-2.5), Y(1))];
way(20, { highway: 'residential', name: 'Long Road' }, [at(0, 0), lr[0], lr[1]]);
way(21, { highway: 'residential', name: 'Long Road' }, [lr[1], lr[2], lr[3]]);
way(22, { highway: 'residential', name: 'Loop Close' }, [lr[3], at(0, 2)]);
const SIGNAL = at(2, 1);

const opl = [
  ...[...nodes.values()].map((n) => `n${n.id} T${n.id === SIGNAL ? 'highway=traffic_signals' : ''} x${n.lng} y${n.lat}`),
  ...ways.map((w) => {
    const tags = Object.entries(w.tags).map(([k, v]) => `${k}=${v.replace(/ /g, '%20%')}`).join(',');
    const refs = w.ids.map((id) => {
      const n = [...nodes.values()].find((x) => x.id === id);
      return `n${id}x${n.lng}y${n.lat}`;
    });
    return `w${w.id} T${tags} N${refs.join(',')}`;
  }),
].join('\n');

const BBOX = [77.58, 12.95, 77.62, 12.99];
const built = buildGraph(parseOpl(opl), { bbox: BBOX, landmarks: 4, centre: [X(2), Y(1)], built: '2026-10-20T00:00:00Z', source: 'test' });
const raw = decodeGraph(encodeGraph(built.graph));
const router = new Router(raw);
const dijkstra = new Router(raw, { heuristic: false });

const waysIn = (g) => new Set(Array.from(g.wayId));
const routeWays = (c) => new Set(c.ways.map((w) => w.id));

// ---------------------------------------------------------------------------------------- build

test('tags: direction, maxspeed and which ways are drivable', () => {
  assert.equal(directionOf({ highway: 'residential', oneway: 'yes' }), FWD);
  assert.equal(directionOf({ highway: 'residential', oneway: '-1' }), BWD);
  assert.equal(directionOf({ highway: 'tertiary', junction: 'roundabout' }), FWD);
  assert.equal(directionOf({ highway: 'motorway' }), FWD);
  assert.equal(directionOf({ highway: 'motorway', oneway: 'no' }), FWD | BWD);
  assert.equal(directionOf({ highway: 'residential', oneway: 'reversible' }), 0);
  assert.equal(maxspeedOf({ maxspeed: '40' }), 40);
  assert.equal(maxspeedOf({ maxspeed: '30 mph' }), 48);
  assert.equal(maxspeedOf({ maxspeed: 'IN:urban' }), 0);
  assert.equal(classify({ highway: 'residential', access: 'private' }), 'access');
  assert.equal(classify({ highway: 'residential', access: 'no', motor_vehicle: 'yes' }), 'core');
  assert.equal(classify({ highway: 'service', name: 'Tech Park Road' }), 'core');
  assert.equal(classify({ highway: 'service' }), 'service');
  assert.equal(classify({ highway: 'service', service: 'driveway', name: 'x' }), 'service-type');
  assert.equal(classify({ highway: 'footway' }), 'class');
  assert.equal(classify({ highway: 'pedestrian', area: 'yes' }), 'class');
});

test('build: access, connectivity-only service roads, parking aisles and one-way traps', () => {
  const ids = waysIn(raw);
  assert.ok(!ids.has(13), 'access=private lane dropped');
  assert.ok(ids.has(14), 'private lane with motorcar=yes kept');
  assert.ok(ids.has(16), 'unnamed service road that is the only way to Island Road kept');
  assert.ok(ids.has(15), 'Island Road kept (reachable through the service road)');
  assert.ok(!ids.has(17), 'unnamed service shortcut between connected roads dropped');
  assert.ok(!ids.has(18), 'parking aisle dropped');
  assert.ok(!ids.has(19), 'one-way dead end (cannot get back out) dropped');
  assert.equal(built.stats.serviceJoins, 1);
});

test('build: roundabouts are one-way along the ring, Centre Lane northbound only', () => {
  for (let e = 0; e < raw.header.m; e++) {
    const ws = Array.from(raw.wayId.subarray(raw.wayOff[e], raw.wayOff[e + 1]));
    if (ws.includes(10) || ws.includes(7)) assert.ok((raw.eFlags[e] & (FWD | BWD)) !== (FWD | BWD), `edge ${e} of way ${ws} is one-way`);
  }
});

test('build: degree-2 chains with equal tags merge into one edge that keeps both way ids', () => {
  let found = false;
  for (let e = 0; e < raw.header.m; e++) {
    const ws = Array.from(raw.wayId.subarray(raw.wayOff[e], raw.wayOff[e + 1]));
    if (!ws.includes(20)) continue;
    found = true;
    assert.deepEqual(ws.slice().sort(), [20, 21]);
    const starts = Array.from(raw.wayAt.subarray(raw.wayOff[e], raw.wayOff[e + 1]));
    const pts = raw.geoOff[e + 1] - raw.geoOff[e];
    assert.equal(pts, 5, 'polyline (0,0) .. lr3 has 5 vertices');
    assert.equal(starts[0], 0);
    assert.equal(starts[1], 2, 'the second way starts at the shared vertex');
    assert.equal(raw.names[raw.eName[e]], 'Long Road');
  }
  assert.ok(found);
  // Main Road's two ways meet at a junction (Centre Lane, Roundabout Road): not merged across it
  for (let e = 0; e < raw.header.m; e++) {
    const ws = Array.from(raw.wayId.subarray(raw.wayOff[e], raw.wayOff[e + 1]));
    assert.ok(!(ws.includes(1) && ws.includes(2)));
  }
});

test('format: encode -> decode round trip is exact', () => {
  const again = decodeGraph(encodeGraph(raw));
  for (const k of ['eU', 'eV', 'eFlags', 'eClass', 'eMaxspeed', 'eSignals', 'eName', 'eRef', 'eLen', 'wayOff', 'wayId', 'wayAt', 'geoOff', 'geoLng', 'geoLat', 'nodeLng', 'nodeLat', 'nodeSignal', 'lm'])
    assert.deepEqual(Array.from(again[k]), Array.from(raw[k]), k);
  assert.deepEqual(again.names, raw.names);
  assert.equal(again.header.landmarks.length, raw.header.landmarks.length);
  assert.ok(raw.nodeSignal.some((x) => x === 1), 'the traffic signal survives');
});

// ---------------------------------------------------------------------------------------- router

const WEST = [X(0) - 0.0001, Y(0.2)]; // on West Lane, 44 m north of Main Road
const EAST = [X(4) + 0.0001, Y(0.2)];

test('A* with landmarks finds the same shortest times as Dijkstra, between every pair of nodes', () => {
  const n = raw.header.n;
  const snapAt = (v) => {
    for (let e = 0; e < raw.header.m; e++) {
      if (raw.eU[e] === v) return { e, t: 0, p: [raw.nodeLng[v], raw.nodeLat[v]], distM: 0 };
      if (raw.eV[e] === v) return { e, t: raw.eLen[e], p: [raw.nodeLng[v], raw.nodeLat[v]], distM: 0 };
    }
  };
  let pairs = 0;
  for (let a = 0; a < n; a++)
    for (let b = 0; b < n; b++) {
      if (a === b) continue;
      const s = snapAt(a), t = snapAt(b);
      const x = router.search(s, t, null, null, 0), y = dijkstra.search(s, t, null, null, 0);
      assert.equal(!!x, !!y);
      if (x) assert.ok(Math.abs(x.cost - y.cost) < 1e-6, `${a} -> ${b}: ${x.cost} vs ${y.cost}`);
      pairs++;
    }
  assert.ok(pairs > 100);
});

test('route: shortest path takes the faster Main Road; line, cumS, cumM and ways agree', () => {
  const [a] = router.route(WEST, EAST, { alternatives: 1 });
  assert.equal(a.id, 'A');
  assert.match(a.via, /Main Road/);
  assert.ok(routeWays(a).has(1) && routeWays(a).has(2));
  assert.equal(a.cumS.length, a.line.length);
  assert.equal(a.cumM.length, a.line.length);
  for (let i = 1; i < a.cumS.length; i++) assert.ok(a.cumS[i] >= a.cumS[i - 1] && a.cumM[i] >= a.cumM[i - 1]);
  assert.ok(Math.abs(a.cumS.at(-1) - a.durationS) < 1e-6);
  assert.ok(Math.abs(a.cumM.at(-1) - a.lengthM) < 1e-6);
  // 44 m down West Lane, 4 x 217 m of Main Road, 44 m up East Lane
  assert.ok(a.lengthM > 940 && a.lengthM < 970, `${a.lengthM}`);
  // tertiary 17 km/h, residential 13 km/h
  const expect = 868 / (17 / 3.6) + (2 * 44) / (13 / 3.6);
  assert.ok(Math.abs(a.durationS - expect) < 8, `${a.durationS} vs ~${expect}`);
  for (let k = 1; k < a.ways.length; k++) assert.ok(a.ways[k].i >= a.ways[k - 1].i);
  assert.deepEqual(a.line[0].map((v) => +v.toFixed(5)), [X(0), Y(0.2)].map((v) => +v.toFixed(5)));
});

test('route: one-way streets are only used in their direction', () => {
  const north = router.route([X(2), Y(0.2)], [X(2), Y(1.8)], { alternatives: 1 })[0];
  assert.ok(routeWays(north).has(7), 'northbound uses Centre Lane');
  const south = router.route([X(2), Y(1.8)], [X(2), Y(0.2)], { alternatives: 1 })[0];
  const centre = south.ways.filter((w) => w.id === 7);
  // the start and end lie on Centre Lane itself, so it appears there, but never as the way down
  assert.ok(south.lengthM > north.lengthM + 300, `southbound detours: ${south.lengthM} vs ${north.lengthM}`);
  assert.ok(centre.length <= 2);
});

test('route: a roundabout is driven along its ring only', () => {
  // from 40 % along the r0 -> r1 quarter to 60 % along r3 -> r0: ~62 m against the ring, ~246 m with it
  const from = [X(2.1), Y(-0.6)], to = [X(1.9), Y(-0.6)];
  const [r] = router.route(from, to, { alternatives: 1 });
  assert.ok(r.lengthM > 230 && r.lengthM < 260, `went round the ring: ${r.lengthM} m`);
  assert.ok(r.ways.every((w) => w.id === 10));
});

test('route: alternatives are distinct, labelled A/B/C, and within 1.4x of the fastest', () => {
  const rs = router.route(WEST, EAST);
  assert.ok(rs.length >= 2, `${rs.length} routes`);
  assert.deepEqual(rs.map((r) => r.id), ['A', 'B', 'C'].slice(0, rs.length));
  for (const r of rs.slice(1)) {
    assert.ok(r.durationS <= MAX_STRETCH * rs[0].durationS + 1e-6);
    for (const q of rs) {
      if (q === r) continue;
      const shared = new Set(q.ways.map((w) => w.id));
      const mine = r.ways.filter((w) => !shared.has(w.id));
      assert.ok(mine.length > 0, `${r.id} differs from ${q.id}`);
    }
  }
  assert.ok(MAX_SHARED <= 0.75);
  assert.notEqual(rs[1].via, rs[0].via);
});

test('route: avoid keeps off the given ways while a detour exists, and uses them when none does', () => {
  const [usual] = router.route(WEST, EAST, { alternatives: 1 });
  assert.ok(routeWays(usual).has(1));
  const [dry] = router.route(WEST, EAST, { alternatives: 1, avoid: [1, 2] });
  assert.ok(!routeWays(dry).has(1) && !routeWays(dry).has(2), 'avoided Main Road');
  assert.ok(dry.durationS > usual.durationS);
  // Island Road is only reachable through the service road: avoiding it cannot strand the trip
  const [island] = router.route([X(6), Y(1.5)], WEST, { alternatives: 1, avoid: [16] });
  assert.ok(island && routeWays(island).has(16));
});

test('snap: nearest road, flyover decks only when nothing else is near, off-network is []', () => {
  const s = router.snap([X(1.5), Y(0) + 0.0002]);
  assert.ok(s.distM > 15 && s.distM < 30, `${s.distM}`);
  assert.ok(Array.from(raw.wayId.subarray(raw.wayOff[s.e], raw.wayOff[s.e + 1])).includes(1));
  // the deck runs 50 m north of Middle Street: 30 m north of the street (20 m from the deck) and even
  // right on the deck, the street below wins (a deck is only taken with nothing else within 60 m more)
  for (const p of [router.snap([X(1.5), Y(1) + 0.00027]), router.snap([X(1.5), Y(1.225)])])
    assert.ok(Array.from(raw.wayId.subarray(raw.wayOff[p.e], raw.wayOff[p.e + 1])).includes(3), 'snapped to Middle Street');
  // 83 m from the deck and 88 m from North Street (109 m from Centre Lane): the street wins on the bias
  const q = router.snap([X(1.5), Y(1.6)]);
  assert.ok(Array.from(raw.wayId.subarray(raw.wayOff[q.e], raw.wayOff[q.e + 1])).includes(4), 'snapped to North Street');
  assert.deepEqual(router.route([77.0, 12.5], EAST), []);
});
