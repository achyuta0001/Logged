# PROGRESS — Bengaluru Urban flood explorer (issue #1)

Checkpoint file for the overnight run. Anyone starting cold: read this, the issue's latest
comments and the draft PR, then continue from **Next step**.

- **Branch:** `claude/dreamy-ritchie-rr1iam` (the session's designated branch; the issue asks for
  `blr-urban`, but this cloud session may push only to its designated branch. Decision recorded in the PR.)
- **Verify everything:** `npx tsc --noEmit && npm test && npx vite build`

## Environment facts (2026-10-17, this cloud session)

- Reachable: AWS S3 (`copernicus-dem-30m`, `elevation-tiles-prod`, `daylight-openstreetmap`, `overturemaps-us-west-2`), npm, PyPI, GitHub API.
- **Blocked by the session's network policy:** Overpass (all mirrors), openstreetmap.org, Nominatim, Geofabrik, Open-Meteo, OpenFreeMap, EOX tiles.
- Workaround for OSM: `scripts/osm-daylight.py` streams the **Daylight Map Distribution v1.58** (OSM, ODbL, Nov 2024 snapshot) from public S3 and keeps features in the Bengaluru Urban bbox. Output in `.cache/osm/daylight/v1.58/` (git-ignored).

## Milestones

| | Status |
|---|---|
| M0 Your place mounted, place tests, layout polish | done |
| M1 Multi-region foundation | in progress |
| M2 Pack size and speed | todo |
| M3 City overview | todo |
| M4 Cross-pincode catchments | todo |
| M5 Build and verify 12+ packs | todo |
| M6 Polish and hand-over | todo |

## Done

- M0: `mountPlace` wired into `src/main.ts` (refresh after each run, `setHour` debounced while playing); `src/place/__tests__/route.test.ts` (detour, full blockage, real-data smoke); `npm test` runs `src/**/__tests__/*.test.ts`; attribution starts collapsed; KPI labels shortened; speed control can't clip.

## In progress

- Daylight OSM extract (relations, then nodes, then ways): `python3 scripts/osm-daylight.py` (resumable).
- M1 pack loader / manifest / `?pin=` switching.

## Next step

- Finish M1 (see the issue's Plan).

## Decisions

- Synthetic packs are test fixtures only (under `src/**/__tests__/`), never shown as real places.
