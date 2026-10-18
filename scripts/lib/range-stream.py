#!/usr/bin/env python3
"""Stream a large public file to stdout with HTTP range requests: several chunks in flight,
each retried with exponential backoff (capped at ~15 min), output strictly in order.
Used by scripts/osm-extract.sh to pipe the OSM planet into osmium without storing it.

  python3 scripts/lib/range-stream.py <url> [--chunk-mb 32] [--parallel 6] | consumer
"""
import argparse
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

UA = 'logged-flood-explorer/0.2 (open-source research prototype; github.com/achyuta0001/Logged)'


def size_of(url):
    req = urllib.request.Request(url, method='HEAD', headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return int(r.headers['Content-Length'])


def fetch(url, a, b):
    for attempt in range(12):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Range': f'bytes={a}-{b}'})
            with urllib.request.urlopen(req, timeout=120) as r:
                data = r.read()
            if len(data) == b - a + 1:
                return data
            raise IOError(f'short read {len(data)} of {b - a + 1}')
        except Exception as e:  # noqa: BLE001 - any network error: back off and retry
            wait = min(900, 2 * 2 ** attempt)
            print(f'[range-stream] bytes {a}-{b}: {e}; retry in {wait}s', file=sys.stderr, flush=True)
            time.sleep(wait)
    raise SystemExit(f'giving up on bytes {a}-{b}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('url')
    ap.add_argument('--chunk-mb', type=int, default=32)
    ap.add_argument('--parallel', type=int, default=6)
    a = ap.parse_args()
    total = size_of(a.url)
    step = a.chunk_mb << 20
    ranges = [(o, min(total, o + step) - 1) for o in range(0, total, step)]
    out = sys.stdout.buffer
    t0 = time.time()
    done = 0
    with ThreadPoolExecutor(a.parallel) as ex:
        window = []
        it = iter(ranges)
        for r in it:
            window.append(ex.submit(fetch, a.url, *r))
            if len(window) >= a.parallel * 2:
                break
        while window:
            data = window.pop(0).result()
            out.write(data)
            done += len(data)
            nxt = next(it, None)
            if nxt:
                window.append(ex.submit(fetch, a.url, *nxt))
            if done // step % 64 == 0:
                el = time.time() - t0
                print(f'[range-stream] {done / 1e9:.1f}/{total / 1e9:.1f} GB, {done / 1e6 / el:.0f} MB/s', file=sys.stderr, flush=True)
    out.flush()


if __name__ == '__main__':
    main()
