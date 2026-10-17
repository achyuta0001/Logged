#!/usr/bin/env bash
# Cut a Bengaluru Urban OSM extract (.osm.pbf, ODbL) from the full planet, streamed from the
# public AWS Open Data bucket `osm-pds` (no key, no login), without storing the ~95 GB planet.
#
#   scripts/osm-extract.sh            -> .cache/osm/blr-region.osm.pbf  (~100-300 MB)
#
# Needs: osmium-tool (apt install osmium-tool), python3. Takes ~30-60 min, once.
# Use a Geofabrik "India southern zone" extract instead if you have one:
#   osmium extract -b 77.15,12.45,78.05,13.45 -s smart southern-zone-latest.osm.pbf -o .cache/osm/blr-region.osm.pbf
# The bbox pads Bengaluru Urban (relation 2020589, ~77.38-77.79 E, 12.73-13.18 N) so pincodes and
# catchments that straddle the district edge are complete. "simple" strategy = one streaming pass;
# ways crossing the bbox keep only their nodes inside it (the padding keeps that far from any pack).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=.cache/osm/blr-region.osm.pbf
URL=${PLANET_URL:-https://osm-pds.s3.amazonaws.com/planet-latest.osm.pbf}
BBOX=${BBOX:-77.15,12.45,78.05,13.45}
mkdir -p .cache/osm
if [[ -s $OUT && -z ${REFRESH:-} ]]; then echo "$OUT exists (REFRESH=1 to rebuild)"; exit 0; fi
command -v osmium >/dev/null || { echo "osmium-tool is required (apt install osmium-tool)"; exit 1; }
python3 -I scripts/lib/range-stream.py "$URL" \
  | osmium extract -b "$BBOX" -s simple -F pbf - -o "$OUT.part" -f pbf --overwrite
mv "$OUT.part" "$OUT"
osmium fileinfo -e "$OUT" | grep -E "Number of (nodes|ways|relations)|Bounding|timestamp" || true
printf '{"source":"%s","bbox":"%s","built":"%s","licence":"ODbL 1.0, (c) OpenStreetMap contributors"}\n' \
  "$URL" "$BBOX" "$(date -u +%FT%TZ)" > .cache/osm/blr-region.json
