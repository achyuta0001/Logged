# PROGRESS — Bengaluru Urban flood explorer (issue #1)

Checkpoint file for the overnight run. Anyone starting cold: read this, the issue's latest
comments and the draft PR, then continue from **Next step**.

- **Branch:** `claude/dreamy-ritchie-rr1iam` (the session's designated branch; the issue asks for
  `blr-urban`, but this cloud session may push only to its designated branch. Decision recorded in the PR.)
- **Verify everything:** `npx tsc --noEmit && npm test && npx vite build`

## Environment facts (2026-10-17, this cloud session)

- Reachable: AWS S3 (`copernicus-dem-30m`, `elevation-tiles-prod`, `osm-pds`), npm, PyPI, Ubuntu apt, GitHub API.
- **Blocked by the session's network policy:** Overpass (all mirrors), openstreetmap.org, Nominatim, Geofabrik, Open-Meteo, OpenFreeMap, EOX tiles.
- OSM workaround: `npm run data:osm` (`scripts/osm-extract.sh`) streams the full OSM planet (95 GB, planet-261012) from the public AWS `osm-pds` bucket through `osmium extract` into `.cache/osm/blr-region.osm.pbf` (58 MB, bbox 77.15–78.05 E, 12.45–13.45 N). This takes about 18 min. It needs `apt install osmium-tool`.
- In the browser, the basemap (OpenFreeMap) and the forecast (Open-Meteo) are blocked here. The app falls back to a plain dark background and to the scenarios.

## Milestones

| | Status |
|---|---|
| M0 Your place mounted, place tests, layout polish | done |
| M1 Multi-region foundation | done |
| M2 Pack size and speed | done (format 2) |
| M3 City overview | done (UI + data:city); polish pending |
| M4 Cross-pincode catchments | todo |
| M5 Build and verify 12+ packs | todo |
| M6 Polish and hand-over | todo |

## Done

- M0: `mountPlace` wired into `src/main.ts` (refresh after each run, `setHour` debounced while playing); `src/place/__tests__/route.test.ts` (detour, full blockage, real-data smoke); `npm test` runs `src/**/__tests__/*.test.ts`; attribution starts collapsed; KPI labels shortened; speed control can't clip.

- M1: `src/region/packs.ts` (index loader, schema checks, search), `?pin=` routing with a persistent shell and region `destroy()` (`src/main.ts`), `npm run data -- --pin <code>` writes `public/data/pins/<code>/`, and `public/data/pins/index.json` is committed (117 pincodes). Tests: `src/region/__tests__/packs.test.ts`.
- M2: pack format 2 (`src/pack/codec.ts`, `src/pack/osm.ts`, documented in CONTRACT.md). 560034 went from 2.23 to 1.16 MB gzipped, and v1 and v2 simulate the same (calibrate). Large pincodes use a coarser cell (`cellSizeFor` in build-data) so packs stay near 140k cells.
- M3: `npm run data:city` (`scripts/build-city.mjs`, 40 s) writes `public/data/city/city.geojson` (171 kB) and the index. The city view is in `src/region/city.ts`.

## In progress

- `npm run data:all -- --jobs 2` (all 117 packs, git-ignored; log in `.cache/all.log`).

## Next step

- M4: show a quiet caveat in the UI when `pack.upstreamOutsideKm2` is large (the data is already in the index).
- M5: `node scripts/calibrate.mjs --pin <code> --impact` for the 12+ sample pincodes, then a table in the PR.
- Leak check: switch regions repeatedly in headless Chromium and watch heap and worker counts.
- Pick 2–3 small sample packs to commit: un-ignore them in `.gitignore`, then run `node scripts/build-city.mjs --index-only --only-committed`.

## Decisions

- Synthetic packs are test fixtures only (under `src/**/__tests__/`), never shown as real places.
