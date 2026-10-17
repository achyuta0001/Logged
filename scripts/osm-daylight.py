#!/usr/bin/env python3
"""Extract OpenStreetMap features for the Bengaluru Urban region from the Daylight
Map Distribution on AWS Open Data (keyless, public bucket `daylight-openstreetmap`).

Why: Overpass and Geofabrik are not always reachable (and thousands of Overpass calls
for a whole district are impolite). Daylight publishes all of OSM as GeoParquet-like
files with assembled geometries (WKT) and raw OSM tags, under ODbL 1.0.

Output: one GeoJSON feature per line (GeoJSONSeq) per source file, in
  .cache/osm/daylight/<release>/<type>-<n>.geojsonseq      (+ a .done marker)
Each feature: {"type":"Feature","id":"way/123","properties":{"tags":{...}},"geometry":{...}}
Concatenate with `cat .cache/osm/daylight/<release>/*.geojsonseq`; scripts/lib/osm-source.mjs
reads them directly.

Resumable (finished files are skipped), streams row group by row group (memory stays
bounded), reads bbox columns first and decodes tags/WKT only for row groups with hits.

Usage:
  pip install pyarrow fsspec aiohttp shapely      # Apache-2.0 / BSD
  python3 scripts/osm-daylight.py [--release v1.58] [--types relation,node,way] [--workers 4]

Licence of the output: © OpenStreetMap contributors, ODbL 1.0.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

BUCKET = 'https://daylight-openstreetmap.s3.amazonaws.com'
# Bengaluru Urban district (OSM relation 2020589) is ~12.73-13.18 N, 77.38-77.79 E; pad it so
# catchments and pincodes that straddle the district edge are complete.
BBOX = (77.25, 12.60, 77.92, 13.30)  # W S E N
KEYS = {
    'building', 'highway', 'waterway', 'natural', 'water', 'landuse', 'leisure', 'amenity', 'healthcare',
    'shop', 'public_transport', 'railway', 'power', 'place', 'boundary', 'landcover', 'surface', 'tunnel', 'bridge',
}
# boundaries we need: postal codes and the district / state hierarchy (not every admin level)
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
UA = 'logged-flood-explorer/0.2 (open-source research prototype; github.com/achyuta0001/Logged)'


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def list_keys(prefix):
    keys, token = [], None
    while True:
        url = f'{BUCKET}/?list-type=2&prefix={prefix}' + (f'&continuation-token={urllib.parse.quote(token)}' if token else '')
        req = urllib.request.Request(url, headers={'User-Agent': UA})
        xml = urllib.request.urlopen(req, timeout=60).read().decode()
        keys += [(k, int(s)) for k, s in re.findall(r'<Key>([^<]+)</Key>.*?<Size>(\d+)</Size>', xml, re.S)]
        m = re.search(r'<NextContinuationToken>([^<]+)</NextContinuationToken>', xml)
        if not m:
            return keys
        token = m.group(1)


def wanted(tags):
    if not tags:
        return False
    for k, _ in tags:
        if k in KEYS:
            return True
    return False


def process(key, kind, out_dir, idx):
    import fsspec
    import numpy as np
    import pyarrow.parquet as pq
    import shapely

    out = os.path.join(out_dir, f'{kind}-{idx:03d}.geojsonseq')
    done = out + '.done'
    if os.path.exists(done):
        return key, 0, 'cached'
    fs = fsspec.filesystem('https', client_kwargs={'trust_env': True, 'headers': {'User-Agent': UA}})
    W, S, E, N = BBOX
    n_out = 0
    tmp = out + '.part'
    with fs.open(f'{BUCKET}/{key}', block_size=8 << 20) as f, open(tmp, 'w') as w:
        pf = pq.ParquetFile(f)
        for rg in range(pf.metadata.num_row_groups):
            for attempt in range(6):
                try:
                    bb = pf.read_row_group(rg, columns=['min_lon', 'max_lon', 'min_lat', 'max_lat'])
                    mask = (
                        (bb['max_lon'].to_numpy(zero_copy_only=False) >= W)
                        & (bb['min_lon'].to_numpy(zero_copy_only=False) <= E)
                        & (bb['max_lat'].to_numpy(zero_copy_only=False) >= S)
                        & (bb['min_lat'].to_numpy(zero_copy_only=False) <= N)
                    )
                    hits = np.nonzero(mask)[0]
                    if len(hits) == 0:
                        break
                    t = pf.read_row_group(rg, columns=['id', 'tags', 'wkt']).take(hits)
                    break
                except Exception as e:  # network hiccup: back off, capped at ~15 min
                    wait = min(900, 5 * 2 ** attempt)
                    log(f'  {kind}-{idx} rg{rg} failed ({e}); retry in {wait}s')
                    time.sleep(wait)
            else:
                raise RuntimeError(f'{key} row group {rg} failed repeatedly')
            if len(hits) == 0:
                continue
            ids = t['id'].to_pylist()
            tags = t['tags'].to_pylist()
            wkts = t['wkt'].to_pylist()
            keep = [i for i in range(len(ids)) if wanted(tags[i]) and wkts[i]]
            if not keep:
                continue
            geoms = shapely.from_wkt([wkts[i] for i in keep], on_invalid='ignore')
            gj = shapely.to_geojson(geoms)
            for j, i in enumerate(keep):
                if geoms[j] is None or gj[j] is None:
                    continue
                props = {'tags': dict(tags[i])}
                w.write('{"type":"Feature","id":"%s/%d","properties":%s,"geometry":%s}\n' % (kind, ids[i], json.dumps(props, ensure_ascii=False, separators=(',', ':')), gj[j]))
                n_out += 1
    os.replace(tmp, out)
    open(done, 'w').write(time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
    return key, n_out, 'ok'


def main():

    ap = argparse.ArgumentParser()
    ap.add_argument('--release', default='v1.58')
    ap.add_argument('--types', default='relation,node,way')
    ap.add_argument('--workers', type=int, default=4)
    a = ap.parse_args()
    out_dir = os.path.join(ROOT, '.cache', 'osm', 'daylight', a.release)
    os.makedirs(out_dir, exist_ok=True)
    jobs = []
    for kind in a.types.split(','):
        keys = list_keys(f'parquet/osm_features/release={a.release}/type={kind}/')
        log(f'{kind}: {len(keys)} files, {sum(s for _, s in keys) / 1e9:.1f} GB')
        jobs += [(k, kind, i) for i, (k, _) in enumerate(sorted(keys))]
    t0 = time.time()
    total = 0
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs = {ex.submit(process, k, kind, out_dir, i): (kind, i) for k, kind, i in jobs}
        for n, fut in enumerate(as_completed(futs), 1):
            kind, i = futs[fut]
            try:
                _, cnt, st = fut.result()
            except Exception as e:
                log(f'FAILED {kind}-{i}: {e} (rerun to resume)')
                continue
            total += cnt
            log(f'[{n}/{len(jobs)}] {kind}-{i:03d} {st} {cnt} features ({(time.time() - t0) / 60:.1f} min)')
    meta = {'source': f'Daylight Map Distribution {a.release} (s3://daylight-openstreetmap/parquet/osm_features)', 'bbox': BBOX, 'licence': 'ODbL 1.0, © OpenStreetMap contributors'}
    json.dump(meta, open(os.path.join(out_dir, 'SOURCE.json'), 'w'), indent=1)
    log(f'done: {total} new features in {(time.time() - t0) / 60:.1f} min -> {out_dir}')


if __name__ == '__main__':
    sys.exit(main())
