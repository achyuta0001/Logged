// @ts-nocheck -- node:test types are not part of the browser tsconfig
// Run: node --test src/pack/__tests__/   (Node >= 22.6 strips TS types natively; no deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { GZ_FILES, fetchPackJson } from '../fetch.ts';

const doc = { type: 'FeatureCollection', format: 2, features: [{ type: 'Feature', geometry: null, properties: { id: 'way/1', kind: 'road', name: 'ಬೆಂಗಳೂರು Main Road' } }] };
const text = JSON.stringify(doc);
const html = () => new Response('<!doctype html><title>app</title>', { status: 200, headers: { 'content-type': 'text/html' } });
const notFound = () => new Response('<!doctype html><title>404</title>', { status: 404, headers: { 'content-type': 'text/html' } });

/** a static host: url -> body (Buffer / string), Error (fetch rejects, e.g. CORS) or a Response factory; anything else 404s */
function host(files) {
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    const b = files[url];
    if (b instanceof Error) throw b;
    if (typeof b === 'function') return b();
    if (b === undefined) return notFound();
    return new Response(b, { status: 200, headers: { 'content-type': url.endsWith('.gz') ? 'application/gzip' : 'application/json' } });
  };
  return { fetch, asked };
}

test('loader: reads <file>.gz and inflates it, without asking for the plain file', async () => {
  const h = host({ '/p/osm.geojson.gz': gzipSync(text), '/p/osm.geojson': '{"stale":true}' });
  assert.deepEqual(await fetchPackJson('/p/osm.geojson', { gz: true, fetch: h.fetch }), doc);
  assert.deepEqual(h.asked, ['/p/osm.geojson.gz']);
});

test('loader: falls back to the plain file when the .gz is missing (old packs, 560098)', async () => {
  const h = host({ '/data/osm.geojson': text });
  assert.deepEqual(await fetchPackJson('/data/osm.geojson', { gz: true, fetch: h.fetch }), doc);
  assert.deepEqual(h.asked, ['/data/osm.geojson.gz', '/data/osm.geojson']);
});

test('loader: the dev server SPA fallback (index.html with 200) counts as missing', async () => {
  const h = host({ '/p/depressions.json.gz': html, '/p/depressions.json': '[1,2]' });
  assert.deepEqual(await fetchPackJson('/p/depressions.json', { gz: true, fetch: h.fetch }), [1, 2]);
});

test('loader: a .gz that cannot be fetched (CORS, network) or does not inflate falls back to the plain file', async () => {
  const a = host({ '/p/osm.geojson.gz': new TypeError('Failed to fetch'), '/p/osm.geojson': text });
  assert.deepEqual(await fetchPackJson('/p/osm.geojson', { gz: true, fetch: a.fetch }), doc);
  const corrupt = gzipSync(text).subarray(0, 40); // gzip magic, truncated stream
  const b = host({ '/p/osm.geojson.gz': corrupt, '/p/osm.geojson': text });
  assert.deepEqual(await fetchPackJson('/p/osm.geojson', { gz: true, fetch: b.fetch }), doc);
  // neither loads: the error names the plain file and why the .gz failed
  const c = host({ '/p/osm.geojson.gz': corrupt });
  await assert.rejects(fetchPackJson('/p/osm.geojson', { gz: true, fetch: c.fetch }), (e) => e.message.startsWith('/p/osm.geojson: HTTP 404 (and /p/osm.geojson.gz:'));
});

test('loader: a .gz the host already inflated (Content-Encoding: gzip) is read as JSON', async () => {
  const h = host({ '/p/osm.geojson.gz': text });
  assert.deepEqual(await fetchPackJson('/p/osm.geojson', { gz: true, fetch: h.fetch }), doc);
});

test('loader: without gz only the plain file is asked for; a missing file throws', async () => {
  const h = host({ '/p/hotspots.json': '[]' });
  assert.deepEqual(await fetchPackJson('/p/hotspots.json', { fetch: h.fetch }), []);
  assert.deepEqual(h.asked, ['/p/hotspots.json']);
  await assert.rejects(fetchPackJson('/p/nothing.json', { fetch: h.fetch }), /nothing\.json: HTTP 404/);
  await assert.rejects(fetchPackJson('/p/spa.json', { fetch: host({ '/p/spa.json': html }).fetch }), /spa\.json: missing/);
});

// ---------------------------------------------------------------- committed packs
const pub = new URL('../../../public/', import.meta.url);
/** the dev server / Pages over public/: files as they are, 404 otherwise */
const disk = async (url) => {
  const f = new URL(url.slice(1), pub);
  return existsSync(f) ? new Response(readFileSync(f), { status: 200 }) : notFound();
};

test('committed sample packs store osm.geojson / depressions.json only as .gz, and they load', async () => {
  for (const code of ['560034', '560071']) {
    const dir = new URL(`data/pins/${code}/`, pub);
    if (!existsSync(new URL('pack.json', dir))) continue;
    const pack = JSON.parse(readFileSync(new URL('pack.json', dir), 'utf8'));
    for (const f of pack.files) assert.ok(existsSync(new URL(f, dir)), `${code}: pack.json lists ${f}`);
    for (const name of GZ_FILES) {
      assert.ok(pack.files.includes(`${name}.gz`) && !pack.files.includes(name), `${code}: ${name} stored as .gz`);
      assert.ok(!existsSync(new URL(name, dir)), `${code}: no plain ${name} next to the .gz`);
    }
    const osm = await fetchPackJson(`/data/pins/${code}/osm.geojson`, { gz: true, fetch: disk });
    assert.equal(osm.type, 'FeatureCollection');
    assert.ok(osm.features.length > 1000, `${code}: ${osm.features.length} features`);
    const deps = await fetchPackJson(`/data/pins/${code}/depressions.json`, { gz: true, fetch: disk });
    assert.ok(Array.isArray(deps) && deps.length > 0 && deps[0].cells.length > 0);
  }
});

test('the 560098 reference pack (format 1) stays plain and loads through the fallback', async () => {
  if (!existsSync(new URL('data/meta.json', pub))) return;
  for (const name of GZ_FILES) assert.ok(!existsSync(new URL(`data/${name}.gz`, pub)), `public/data/${name}.gz`);
  const osm = await fetchPackJson('/data/osm.geojson', { gz: true, fetch: disk });
  assert.ok(osm.features.length > 1000);
});
