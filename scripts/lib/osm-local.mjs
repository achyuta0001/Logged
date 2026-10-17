// Local OSM source: answer the pack builder's Overpass query from the Bengaluru Urban extract
// (.cache/osm/blr-region.osm.pbf, made by scripts/osm-extract.sh) with osmium-tool, so building
// a pack needs no Overpass call at all. Output is the same Overpass JSON ("out body; >; out skel")
// the builder already understands, so multipolygon assembly (osmtogeojson) is unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const REGION_PBF = '.cache/osm/blr-region.osm.pbf';

/** osmium tags-filter expressions equivalent to the pack builder's Overpass query */
export const PACK_FILTERS = [
  'nwr/building',
  'w/highway',
  'nwr/waterway',
  'nwr/natural=water,wetland,wood,scrub,grassland',
  'nwr/water',
  'nwr/landuse',
  'nwr/leisure=park,garden,playground,pitch,nature_reserve,recreation_ground,sports_centre,stadium',
  'nwr/amenity=school,college,university,kindergarten,hospital,clinic,doctors,marketplace,police,fire_station,place_of_worship,bus_station',
  'nwr/healthcare',
  'nwr/shop=supermarket,mall,department_store',
  'nwr/highway=bus_stop',
  'nwr/public_transport',
  'nwr/railway=station,halt,subway_entrance',
  'nwr/power=substation',
  'n/place',
];

export function hasOsmium() {
  try {
    execFileSync('osmium', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function regionAvailable(root) {
  return fs.existsSync(path.join(root, REGION_PBF)) && hasOsmium();
}

const run = (args, opts = {}) => execFileSync('osmium', args, { maxBuffer: 1 << 30, ...opts });

/**
 * Overpass-style JSON for everything matching PACK_FILTERS in bbox [w, s, e, n], plus the given
 * relations (e.g. the pincode boundary) with all their members.
 */
export function regionOverpassJson(root, bbox, relationIds = [], tmpDir) {
  const src = path.join(root, REGION_PBF);
  fs.mkdirSync(tmpDir, { recursive: true });
  const clip = path.join(tmpDir, 'clip.osm.pbf');
  const tagged = path.join(tmpDir, 'tagged.osm.pbf');
  const rels = path.join(tmpDir, 'rels.osm.pbf');
  const merged = path.join(tmpDir, 'merged.osm.pbf');
  // complete_ways: ways crossing the bbox keep all their nodes (same as Overpass "way(bbox); >;")
  run(['extract', '-b', bbox.join(','), '-s', 'complete_ways', src, '-o', clip, '--overwrite']);
  run(['tags-filter', clip, ...PACK_FILTERS, '-o', tagged, '--overwrite']);
  const parts = [tagged];
  if (relationIds.length) {
    // whole relations from the full region file (their ways may reach past this bbox)
    run(['getid', '-r', src, ...relationIds.map((id) => `r${id}`), '-o', rels, '--overwrite']);
    parts.push(rels);
  }
  run(['merge', ...parts, '-o', merged, '--overwrite']);
  const opl = run(['cat', merged, '-f', 'opl,add_metadata=false']).toString('utf8');
  for (const f of [clip, tagged, rels, merged]) fs.rmSync(f, { force: true });
  return { elements: oplToElements(opl) };
}

/** OPL text -> Overpass JSON elements (nodes with lat/lon, ways with node refs, relations with members). */
export function oplToElements(opl) {
  const out = [];
  for (const line of opl.split('\n')) {
    if (!line) continue;
    const kind = line[0];
    const sp = line.indexOf(' ');
    const id = Number(line.slice(1, sp < 0 ? undefined : sp));
    const fields = sp < 0 ? [] : line.slice(sp + 1).split(' ');
    let tags, x, y, nodes, members;
    for (const f of fields) {
      const k = f[0];
      const v = f.slice(1);
      if (k === 'T') tags = parseTags(v);
      else if (k === 'x') x = v === '' ? undefined : Number(v);
      else if (k === 'y') y = v === '' ? undefined : Number(v);
      else if (k === 'N') nodes = v ? v.split(',').map((r) => Number(r.slice(1))) : [];
      else if (k === 'M') members = v ? v.split(',').map(parseMember) : [];
    }
    if (kind === 'n') {
      if (x === undefined || y === undefined) continue;
      out.push(tags ? { type: 'node', id, lat: y, lon: x, tags } : { type: 'node', id, lat: y, lon: x });
    } else if (kind === 'w') out.push({ type: 'way', id, nodes: nodes ?? [], ...(tags ? { tags } : {}) });
    else if (kind === 'r') out.push({ type: 'relation', id, members: members ?? [], ...(tags ? { tags } : {}) });
  }
  return out;
}

const TYPE = { n: 'node', w: 'way', r: 'relation' };
function parseMember(s) {
  const at = s.indexOf('@');
  return { type: TYPE[s[0]], ref: Number(s.slice(1, at)), role: unescapeOpl(s.slice(at + 1)) };
}

function parseTags(v) {
  if (!v) return undefined;
  const t = {};
  for (const kv of v.split(',')) {
    const eq = kv.indexOf('=');
    t[unescapeOpl(kv.slice(0, eq))] = unescapeOpl(kv.slice(eq + 1));
  }
  return t;
}

/** OPL escapes special characters as %<hex codepoint>% */
export function unescapeOpl(s) {
  return s.includes('%') ? s.replace(/%([0-9a-fA-F]+)%/g, (_, h) => String.fromCodePoint(parseInt(h, 16))) : s;
}
