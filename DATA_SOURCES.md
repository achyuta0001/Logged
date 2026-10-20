# Data sources and licences

Every outside source the app and its build scripts use, with its licence and the attribution to show. Checked 2026-10-20 against the code (`src/**`, `index.html`, `scripts/**`). The rule for this project: free, keyless, openly licensed, attributed. Two entries below fall short of "open" and are flagged: the satellite layer (non-commercial) and the web font host.

## Shown in the browser

| What | Source | Used in | Licence | Attribution string |
|---|---|---|---|---|
| Basemap (vector, dark) | [OpenFreeMap](https://openfreemap.org/) style `https://tiles.openfreemap.org/styles/dark` | `src/map/mapView.ts` | Map data © OpenStreetMap contributors, **ODbL 1.0**; OpenMapTiles schema (BSD-3 code, CC BY 4.0 design); OpenFreeMap is free with no key and no usage limit | `OpenFreeMap © OpenMapTiles Data from © OpenStreetMap contributors` |
| Satellite imagery | [EOX Sentinel-2 cloudless](https://s2maps.eu) layer `s2cloudless-2020_3857` | `src/map/mapView.ts` | **CC BY-NC-SA 4.0** for the 2018 and later layers (only the 2016 layer is CC BY 4.0). Fine for this non-commercial project; switch to `s2cloudless_3857` (2016) if the site is ever used commercially. The README's "CC BY 4.0" is right only for 2016. | `Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2020)` |
| 3D terrain tiles | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen / Tilezen joerd), `s3.amazonaws.com/elevation-tiles-prod/terrarium` | `src/map/mapView.ts` | Open data (SRTM and USGS NED public domain, GMTED2010, ETOPO1, others; see [joerd attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)) | `Terrain: Mapzen/Tilezen terrain tiles (SRTM, GMTED, ETOPO1 and others)` |
| Rain forecast | [Open-Meteo Forecast API](https://open-meteo.com/) `api.open-meteo.com/v1/forecast` (best match, ECMWF IFS, NOAA GFS, DWD ICON; hourly and 15-minute precipitation) | `src/weather.ts`, `src/commute/forecast.ts` | Data **CC BY 4.0**. The free API is for **non-commercial use only** (no key, fair-use limits of about 10,000 calls a day); commercial use needs an Open-Meteo subscription. | `Weather data by Open-Meteo.com (CC BY 4.0)` |
| Past rain (real storms, commute backtest) | [Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api) `archive-api.open-meteo.com/v1/archive` (ERA5 / ECMWF IFS reanalysis) | `src/weather.ts`, `scripts/commute/backtest.mjs` | **CC BY 4.0**, same non-commercial free tier. ERA5 itself: Copernicus Climate Change Service, free licence with attribution. | `Past rain: Open-Meteo historical weather archive (reanalysis, CC BY 4.0)`; contains modified Copernicus Climate Change Service information |
| Web font | [Inter](https://rsms.me/inter/) from Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`) | `index.html` | Font: **SIL Open Font License 1.1**. The host is a Google service: visitors' browsers contact Google. Self-hosting the font files would keep the licence and remove the third party. | none required (OFL) |

## Committed derived data (`public/data/**`)

| File | Built from | Licence of the result |
|---|---|---|
| `public/data/pins/<code>/*` (pincode packs) | Copernicus DEM GLO-30, OpenStreetMap | ODbL 1.0 for the OSM-derived parts (`osm.geojson`); elevation grids under the Copernicus DEM licence |
| `public/data/city/city.geojson`, `public/data/pins/index.json` | OSM boundaries (`boundary=postal_code`, tagged as sourced from NIC PostalGIS), district relation 2020589; susceptibility from Copernicus DEM GLO-30 and OSM | ODbL 1.0 |
| `public/data/hotspots-city.json` | News reports (links, our own summaries), positions from OSM / Nominatim | ODbL 1.0 for positions; reports are cited, not copied |
| `public/data/news-spots.json` | GDELT and web search to find articles; place names matched to OSM / Nominatim; summaries in our own words (at most 15 words) | ODbL 1.0 for positions; reports are cited, not copied |
| `public/data/commute/hotspots.geojson` | The two report files above, six more Deccan Herald reports found by web search (2026-10-20), OSM highway ways from the local extract, lowness from the 60 m district terrain (Copernicus DEM GLO-30) and the pincode susceptibility | ODbL 1.0 (OSM positions and way ids); reports cited, not copied |

## Used only by the build scripts

| What | Source | Used in | Licence / terms |
|---|---|---|---|
| Elevation | [Copernicus DEM GLO-30](https://registry.opendata.aws/copernicus-dem/) on AWS Open Data (`copernicus-dem-30m`) | `scripts/build-data.mjs`, `scripts/build-city.mjs` | Free licence. Attribution: `© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA; all rights reserved` |
| OpenStreetMap planet | [AWS Open Data `osm-pds`](https://registry.opendata.aws/osm/) through `osmium extract` | `scripts/osm-extract.sh` | © OpenStreetMap contributors, ODbL 1.0 |
| OpenStreetMap extract (alternative) | [Geofabrik](https://download.geofabrik.de/) `asia/india/southern-zone` | `scripts/osm-extract.sh` (the current `.cache/osm/blr-region.osm.pbf` came from it) | © OpenStreetMap contributors, ODbL 1.0; Geofabrik downloads are free |
| OpenStreetMap queries (fallback) | Overpass API: `overpass-api.de`, `overpass.kumi.systems`, `maps.mail.ru` | `scripts/build-data.mjs` when there is no local extract | ODbL 1.0 data; one cached query per pack, polite rate (each instance's usage policy) |
| Geocoding | [Nominatim](https://nominatim.openstreetmap.org/) (OSM Foundation) | `scripts/news/extract.mjs` and the curation of `hotspots-city.json` | ODbL 1.0 data. [Usage policy](https://operations.osmfoundation.org/policies/nominatim/): at most 1 request/s, a real User-Agent, results cached (`.cache/news/nominatim/`), no bulk or app-side use. The app itself never calls Nominatim. |
| News discovery | [GDELT DOC 2.0 API](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/) `api.gdeltproject.org` | `scripts/news/gdelt.mjs` | GDELT: free and open for any use, with citation of the GDELT Project |
| News articles | Deccan Herald, The News Minute, The South First, Madhyamam Online, Gulf News, Scroll, The Quint, Sakshi Post, ETV Bharat, Citizen Matters, OneIndia, ThePrint, Curly Tales, Deccan Chronicle (and the gauge reports linked in `src/weather.ts`) | `scripts/news/fetch.mjs` (local cache only, never published) | **Links only.** We publish the URL, the outlet, the date and a summary in our own words of at most 15 words; no article text, images or headlines are copied. The cached pages stay in `.cache/` (git-ignored). |

## Code dependencies (npm)

| Package | Licence | Where |
|---|---|---|
| maplibre-gl | BSD-3-Clause | app |
| @turf/turf | MIT | scripts |
| osmtogeojson | MIT | scripts |
| geotiff | MIT | scripts |
| pngjs | MIT | scripts |
| assemblyscript | Apache-2.0 | build of the WebAssembly kernel |
| typescript | Apache-2.0 | build |
| vite | MIT | build |
| playwright-core | Apache-2.0 | smoke and accessibility checks |
| axe-core | MPL-2.0 | accessibility check only (not shipped) |
| @types/geojson | MIT | types |

Tools: osmium-tool (GPL-3.0, run as a separate program, not linked).

## What to show where

- **Map** (MapLibre attribution control): OpenFreeMap / OpenMapTiles / OpenStreetMap always; EOX when the satellite layer is on; the terrain tiles line when 3D terrain is on.
- **Anywhere rain is shown** (forecast, commute levels, real storms): `Weather data by Open-Meteo.com (CC BY 4.0)` with a link to https://open-meteo.com/, and the reanalysis caveat for archive rain.
- **Flood reports and commute hotspots:** the outlet name and a link to the article for every report shown.
- **Downloaded or redistributed data files:** keep the ODbL notice (`© OpenStreetMap contributors, ODbL 1.0`) and, for terrain-derived values, the Copernicus DEM attribution.

## Code licence

MIT (see `LICENSE`). Derived data keeps the licences above; OSM-derived files are ODbL.
