// Pack files on disk. A format-2 pack stores its big JSON (GZ_FILES: osm.geojson, depressions.json)
// gzip-compressed as `<name>.gz` and not also plain: GitHub Pages serves a .gz as it is (no
// Content-Encoding) and the site must stay under its 1 GB limit, so the app inflates them itself
// (src/pack/fetch.ts, falling back to the plain file).
//
//   node scripts/lib/pack-files.mjs <pack dir>...   compress packs built before the .gz layout, in place
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { GZ_FILES } from '../../src/pack/fetch.ts';

export { GZ_FILES };
/** every file a pack can hold, by its plain name */
export const PACK_FILES = ['meta.json', 'grids.bin', 'osm.geojson', 'depressions.json', 'hotspots.json'];

const gzip = (buf) => gzipSync(buf, { level: 9 });

/** Write a pack file as `<name>.gz` (compress) or plain, and remove the other variant. Returns the stored name. */
export function writePackFile(dir, name, data, compress) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const [keep, drop] = compress ? [`${name}.gz`, name] : [name, `${name}.gz`];
  fs.writeFileSync(path.join(dir, keep), compress ? gzip(buf) : buf);
  fs.rmSync(path.join(dir, drop), { force: true });
  return keep;
}

/** The stored name of a pack file (`<name>.gz` wins, as in the app), or null when the pack has neither. */
export function storedName(dir, name) {
  if (fs.existsSync(path.join(dir, `${name}.gz`))) return `${name}.gz`;
  return fs.existsSync(path.join(dir, name)) ? name : null;
}

/** The stored names of every file in a pack, in PACK_FILES order. */
export const storedFiles = (dir) => PACK_FILES.map((n) => storedName(dir, n)).filter(Boolean);

/** A pack file's bytes (inflated when stored as .gz), or null when missing. */
export function readPackFile(dir, name) {
  const s = storedName(dir, name);
  if (!s) return null;
  const buf = fs.readFileSync(path.join(dir, s));
  return s.endsWith('.gz') ? gunzipSync(buf) : buf;
}

/** A pack JSON file, parsed (from `<name>.gz` or plain), or null when missing. */
export function readPackJson(dir, name) {
  const buf = readPackFile(dir, name);
  return buf && JSON.parse(buf.toString('utf8'));
}

/**
 * pack.json / index.json sizes over stored files: `bytes` uncompressed and `gzipBytes` gzipped, as
 * before the .gz layout (a stored .gz counts as its inflated size and as itself); `stored` = on disk.
 */
export function packSizes(dir, files) {
  let bytes = 0, gzipBytes = 0, stored = 0;
  for (const f of files) {
    const buf = fs.readFileSync(path.join(dir, f));
    stored += buf.length;
    if (f.endsWith('.gz')) {
      bytes += gunzipSync(buf).length;
      gzipBytes += buf.length;
    } else {
      bytes += buf.length;
      gzipBytes += gzip(buf).length;
    }
  }
  return { bytes, gzipBytes, stored };
}

/**
 * Move a format-2 pack built before the .gz layout to it, in place: each plain GZ_FILES file becomes
 * `<name>.gz` with the same content, and pack.json lists the stored files (its sizes are unchanged).
 * Returns { before, after } stored bytes, or null when there is nothing to do (no pack.json, format 1,
 * already compressed).
 */
export function compressPack(dir) {
  const pj = path.join(dir, 'pack.json');
  if (!fs.existsSync(pj)) return null;
  const pack = JSON.parse(fs.readFileSync(pj, 'utf8'));
  if ((pack.format ?? 1) < 2) return null;
  const todo = GZ_FILES.filter((n) => fs.existsSync(path.join(dir, n)));
  if (!todo.length) return null;
  const onDisk = () =>
    PACK_FILES.flatMap((n) => [n, `${n}.gz`])
      .filter((f) => fs.existsSync(path.join(dir, f)))
      .reduce((a, f) => a + fs.statSync(path.join(dir, f)).size, 0);
  const before = onDisk();
  for (const n of todo) writePackFile(dir, n, fs.readFileSync(path.join(dir, n)), true);
  pack.files = storedFiles(dir);
  const { bytes, gzipBytes } = packSizes(dir, pack.files);
  Object.assign(pack, { bytes, gzipBytes });
  fs.writeFileSync(pj, JSON.stringify(pack, null, 1));
  return { before, after: onDisk() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const dir of process.argv.slice(2)) {
    const r = compressPack(dir);
    console.log(`[pack] ${dir}: ${r ? `${(r.before / 1e6).toFixed(2)} -> ${(r.after / 1e6).toFixed(2)} MB on disk` : 'nothing to compress'}`);
  }
}
