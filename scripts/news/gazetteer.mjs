// Step 2 of the news pipeline: a gazetteer of named places in Bengaluru Urban from the local OSM
// extract (npm run data:osm), so most place names in the news are located offline.
//
//   osmium extract -b 77.38,12.73,77.79,13.18 .cache/osm/blr-region.osm.pbf -o .cache/news/osm/blr-urban.osm.pbf
//   osmium tags-filter .cache/news/osm/blr-urban.osm.pbf w/highway n/highway=traffic_signals,motorway_junction,crossing \
//     n/junction w/junction n/place w/place r/place w/landuse=residential nw/tunnel nw/bridge:name n/railway=station \
//     nw/amenity=bus_station -o .cache/news/osm/named.osm.pbf
//   osmium export .cache/news/osm/named.osm.pbf -f geojsonseq -o .cache/news/osm/named.geojsonseq -a type,id
//   node scripts/news/gazetteer.mjs
//
// Output .cache/news/gazetteer.json: { names: { <normalised name>: [{ coord, kind, lengthM, n }] }, tunnels: [[lon, lat], ...] }
// A name with several entries is used in several places (each entry is a spatial cluster of
// same-named objects, single linkage within 400 m); roads carry their total length.
import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { normName, metres } from '../../src/commute/spots.ts';

const SRC = '.cache/news/osm/named.geojsonseq';
const OUT = '.cache/news/gazetteer.json';
const LINK_M = 400;

const byName = new Map();
const tunnels = [];
const add = (name, item) => {
  const k = normName(name);
  if (!k || k.length < 3) return;
  const a = byName.get(k);
  if (a) a.push(item);
  else byName.set(k, [item]);
};
const lineLen = (cs) => {
  let L = 0;
  for (let i = 1; i < cs.length; i++) L += metres(cs[i - 1], cs[i]);
  return L;
};
const ringMean = (cs) => [cs.reduce((s, c) => s + c[0], 0) / cs.length, cs.reduce((s, c) => s + c[1], 0) / cs.length];

const rl = createInterface({ input: createReadStream(SRC), crlfDelay: Infinity });
let n = 0;
for await (const raw of rl) {
  const line = raw.replace(/^\x1e/, '').trim();
  if (!line) continue;
  let f;
  try {
    f = JSON.parse(line);
  } catch {
    continue;
  }
  n++;
  const p = f.properties ?? {};
  const g = f.geometry;
  if (!g) continue;
  const tunnel = p.tunnel === 'yes' || p.tunnel === 'building_passage' || (p.layer && Number(p.layer) < 0 && p.highway);
  if (tunnel && g.type === 'LineString' && p.highway && !/footway|path|steps|corridor|cycleway/.test(p.highway)) {
    const cs = g.coordinates;
    tunnels.push(cs[Math.floor(cs.length / 2)].map((v) => Math.round(v * 1e6) / 1e6));
  }
  const names = [p.name, p['name:en'], p.alt_name, p.old_name, p.official_name, p.short_name, p['bridge:name'], p['tunnel:name']].filter(Boolean);
  if (!names.length) continue;
  let kind = 'other', coord, cs = null, lengthM = 0;
  if (g.type === 'Point') coord = g.coordinates;
  else if (g.type === 'LineString') {
    cs = g.coordinates;
    lengthM = lineLen(cs);
    coord = cs[Math.floor(cs.length / 2)];
  } else if (g.type === 'Polygon') coord = ringMean(g.coordinates[0]);
  else if (g.type === 'MultiPolygon') coord = ringMean(g.coordinates[0][0]);
  else continue;
  if (tunnel) kind = 'underpass';
  else if (p.junction || p.highway === 'traffic_signals' || p.highway === 'motorway_junction') kind = 'junction';
  else if (p.highway && cs) kind = 'road';
  else if (p.place) kind = 'place';
  else if (p.landuse === 'residential') kind = 'layout';
  for (const nm of new Set(names.flatMap((x) => String(x).split(';')))) add(nm, { coord, kind, lengthM, cs });
}

// cluster same-named objects: single linkage within LINK_M over line vertices / points
const names = {};
for (const [k, items] of byName) {
  const groups = [];
  for (const it of items) {
    const pts = it.cs ? it.cs.filter((_, i) => i % 3 === 0 || i === it.cs.length - 1) : [it.coord];
    const hits = groups.filter((gr) => gr.pts.some((q) => pts.some((p) => Math.abs(p[0] - q[0]) < 0.005 && Math.abs(p[1] - q[1]) < 0.005 && metres(p, q) <= LINK_M)));
    if (!hits.length) groups.push({ items: [it], pts: [...pts] });
    else {
      const g0 = hits[0];
      g0.items.push(it);
      g0.pts.push(...pts);
      for (const h of hits.slice(1)) {
        g0.items.push(...h.items);
        g0.pts.push(...h.pts);
        groups.splice(groups.indexOf(h), 1);
      }
    }
  }
  names[k] = groups.map((gr) => {
    const kinds = gr.items.map((i) => i.kind);
    const kind = ['underpass', 'junction', 'road', 'layout', 'place', 'other'].find((x) => kinds.includes(x));
    const c = ringMean(gr.pts);
    // a road's spot: the vertex nearest the middle of all its vertices
    let best = gr.pts[0], bd = Infinity;
    for (const p of gr.pts) {
      const d = metres(p, c);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    const pointItem = gr.items.find((i) => !i.cs && i.kind === kind);
    const coord = (pointItem ? pointItem.coord : best).map((v) => Math.round(v * 1e6) / 1e6);
    return { coord, kind, lengthM: Math.round(gr.items.reduce((s, i) => s + i.lengthM, 0)), n: gr.items.length };
  });
}
writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), source: 'OpenStreetMap contributors (ODbL), local extract', names, tunnels }));
console.log(`${n} features, ${Object.keys(names).length} names, ${tunnels.length} tunnel ways -> ${OUT}`);
