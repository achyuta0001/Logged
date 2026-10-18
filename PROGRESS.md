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
| M3 City overview | done (optional district-wide storm raster not done) |
| M4 Cross-pincode catchments | done (better): upstream inflow simulated as point sources with inflow edges; caveat says simulated vs left out |
| M5 Build and verify 12+ packs | done: 117 packs built, 14 reported in README / PR |
| M6 Polish and hand-over | done |

## Done

- M0: `mountPlace` is wired into `src/main.ts`. Place tests are added, and `npm test` runs every `src/**/__tests__` suite. Attribution starts collapsed, KPI labels fit, and the speed control no longer clips.
- M1: `src/region/packs.ts`; `?pin=` routing in a persistent shell with region `destroy()` (no leaks over five round trips in headless Chromium); `npm run data -- --pin`; `public/data/pins/index.json`.
- M2: pack format 2 (`src/pack/`), documented in CONTRACT.md. All 117 packs are ≤ 3.2 MB gzipped. Cell size adapts for big pincodes.
- M3: `npm run data:city` and `src/region/city.ts`. The overview transfers 1.8 MB without basemap tiles.
- M4: `upstreamOutsideKm2` per pack (district-wide 60 m flow accumulation, outside cells only), shown as a quiet caveat line.
- M4 better (upstream inflow): `npm run data:city` saves its 60 m routing (`.cache/city/flow60.*`, `--flow-only`). `scripts/lib/catchment.mjs` finds every path that crosses into a pack's grid and summarises its outside catchment (area, imperviousness, mapped-drain and tank share, time-area histogram, Clark storage). `npm run data -- --pin <code>` (or `--inflow-only` for an existing pack) writes `meta.inflow` (points snapped to the pack's flow lines, 6 cells in) and `meta.inflowEdge` (edge stretches where outside land drains in). `src/sim/inflow.ts` turns each point into an hourly hydrograph with the grid's own losses (soil, drains, blockage, tanks) and Clark routing, and injects it over 60 m; `SimCore.sources` books it as `inflow` in the budget (closure ~1e-14), and the inflow edges are closed to outflow while it runs. The caveat now reads "Water from about N km² upstream is routed in…; about M km² more is left out". Packs with inflow: 560034 (7 points, 94.3 of 96.4 km²), 560071 (5, 49.9 of 50.6), 560103 (14, 166.3 of 169.7), 560102 (10, 135.6 of 138.3), 560024 (16, 123.2 of 126.8). Sizes unchanged (+0.5 kB gzipped).
  - **M4 numbers, 2024 storm** (same engine with the drain network, `calibrate.mjs --impact --perf`, `--no-inflow` → with inflow):
    - 560034: inflow 622k m³. Peak flooded 0.228 → 0.265 km², max depth 5.59 → 6.54 m, buildings over plinth 133 → 135, car-closed roads 4.0 → 4.3 km. street300: Silk Board 0.99 → 0.99, HSR Layout 0.78 → 0.95, ST Bed 0.29 → 0.26 m. 216 h run 1.08 → 1.05 s.
    - 560071: inflow 337k m³. Peak 0.128 → 0.128 km², max depth 2.95 → 3.33 m. Most of the inflow clips the south-west corner and leaves south, as the 60 m routing has it. 216 h run 3.60 → 3.55 s: over the 3 s budget because of the drain network, not the inflow.
    - Typical evening: unchanged in both. Water balance closes to ~1e-13 with the inflow term.
    - Edge probe: outflow within 12 cells of the entry points fell from 552k to 4k m³ in 560034. 560102 still loses 223k of 818k m³ near its west entry, which needs a look.
- M5: `scripts/report.mjs`. The results table is in the README. Sourced flood spots are in `scripts/data/hotspots-blr.json`.
- Committed sample packs: 560034 and 560071 (and 560098). Every other pack is git-ignored; `npm run data:all` builds them.
- Drains (dual drainage): `src/sim/network.ts`. Inlet capture is routed through the mapped drains and tanks to the grid edge, and overflows where a reach is full. Mass balance is tested (`src/sim/__tests__/network.test.ts`). Measured against the engine just before it (2024 storm / typical evening, `scripts/calibrate.mjs --impact --perf`):
  - **Typical evening:** unchanged in all three packs. Peak flooded area is 0.034 / 0.014 / 0.015 km², with the same buildings and roads.
  - **2024 storm, peak flooded area:** 560098 0.633 → 0.709 km², 560034 0.192 → 0.264 km², 560071 0.130 → 0.128 km².
  - **Recession:** 5 → 4 h, 5 → 4 h and 6 → 5 h.
  - **Reports wet:** still 8/12 and 3/3. The water moves along the valleys: Global Village / Dubasipalya street300 2.06 → 0.83 / 0.15 m, ST Bed 0.45 → 0.26 m.
  - **216 h runs:** 1.58 s (was 1.47 s), 1.03 s (was 1.11 s) and 3.45 s (was 2.97 s).

## Next step (suggested follow-ups, none blocking)

1. Host the packs. Run the manual workflow `.github/workflows/packs.yml` (not triggered by this run), publish `public/data/pins`, and point the app at it with `?packs=` or `VITE_PACKS_URL`.
2. M4: annotate the other packs (`npm run data:all -- --force`, or `--inflow-only` per pack) once more hotspots allow checking the inflow against reports. Inflow edges close 50–73 % of the grid perimeter in the K&C valley packs; watch for trapped water at closed corners. 560098 (format 1) has no inflow points yet.
3. Drains: detect culverts where a drain line crosses a major road, which needs a road layer in the sim grids. Calibrate the network against more packs: build 560037 (Marathahalli), 560064 (Kendriya Vihar) and 560100 (Electronic City) with `npm run data -- --pin <code>`. Flyover hotspots still need a "road under deck" handling.
4. Add more sourced flood reports to `scripts/data/hotspots-blr.json`, then run `npm run data:all -- --force --pins <codes>`.
5. Optional: a coarse district-wide run of the 20 Oct 2024 storm as an overview raster.

Verify: `npx tsc --noEmit && npm test && npx vite build`. For a pack: `node scripts/calibrate.mjs --pin <code> --impact`.

## Decisions

- Branch: the session's designated branch, `claude/dreamy-ritchie-rr1iam`, not `blr-urban`.
- OSM comes from the planet on AWS `osm-pds` via osmium, because Overpass and Geofabrik are blocked here. The Daylight distribution was tried first and dropped: it has no boundary relations.
- Pincode rule: OSM `boundary=postal_code`, code from `postal_code` or else a 6-digit number in `ref`/`name`, ≥ 50 % of area inside relation 2020589. This keeps 117 of 139.
- 560098 stays format 1 in `public/data/`. `data:all` rebuilds it only when asked by name.
- Synthetic packs are test fixtures only.
- The scenarios are city-wide reuses of the RR Nagar 2024 rainfall. This is stated in the README.
- Drain network: sizes come from the rational method (area served × design intensity at the time of concentration), not from OSM tags, because nearly every drain here is tagged `waterway=drain`. Line ends with no outlet continue through an unmapped culvert-sized link, because OSM lines often stop at road crossings. A pure dead end dumped a whole catchment at one point and flooded the typical evening. Tanks rise 1 m before they back up the drains feeding them: at 0.3 m, chains of small tanks overflowed in a typical evening (560071).
- M4 inflow: point sources from a lumped model (option b), not an upstream-padded bbox (option a). Padding the K&C valley packs upstream needs ~150 km² grids (5–10× the cells), which breaks the 3 s / 4 MB budgets. The lumped Clark/time-area model is standard for ungauged urban catchments, adds a few kB to meta.json, and uses the same sim controls (drains, blockage, infiltration). Edges where the 60 m routing has outside land draining in are closed while inflow runs, because the pack DEM, cut off at the edge, slopes outward there and drained most of the inflow straight back out (Koramangala: 494k of 622k m³). The closed stretches come from the routing, not from the inflow area: an area-sized stretch also closed the edge a stream leaves by and made a 7 m pond in a Domlur corner.
