# comflow

**An interactive world map of bilateral trade flows for the largest hard commodities.**

Each stream is one country selling a raw commodity to another. Colour encodes
the commodity; stroke width scales with the trade's value (or weight) for the
selected period. It's a static, dependency-light dashboard — no backend, no live
vessel tracking — built to make the shape of the global raw-materials trade
legible at a glance.

**Live:** https://philippmerz.github.io/comflow/

## Commodities

Six hard commodities, spanning ores and their first-stage refined forms:

| Commodity | HS code | |
|---|---|---|
| Iron ore | 2601 | the single largest dry-bulk trade by weight |
| Coal | 2701 | |
| Copper ore & concentrates | 2603 | |
| Refined copper | 7403 | |
| Bauxite | 2606 | aluminium's ore |
| Unwrought aluminium | 7601 | |

The list is extendable — add an HS4 group to `COMMODITIES` in
[`scripts/build_data.py`](scripts/build_data.py) and re-run.

## Data

- **Source:** [BACI](https://www.cepii.fr/CEPII/en/bdd_modele/bdd_modele_item.asp?id=37)
  (CEPII) — annual bilateral trade reconciled from UN Comtrade, HS22 release.
  Values are in USD, quantities in tonnes.
- **Preprocessing:** `build_data.py` streams each ~360 MB year file straight from
  the release zip (never extracting it in full), keeps only the six commodity
  groups, joins numeric country codes to ISO3 + a representative centroid, and
  emits the **top 200 flows per commodity per year** as one compact JSON.
- **Output:** `docs/data/flows.json` (~300 KB), plus `countries.json` (names +
  centroids) and `world.json` (a slimmed country basemap).

Everything the site loads is static and pre-built, so it runs anywhere GitHub
Pages does. Refreshing the data is just re-running the script against a newer
release.

## Frontend

- [deck.gl](https://deck.gl) `ArcLayer` over a self-drawn dark country basemap
  (no tile server, no API key) — true-black canvas, glowing great-circle arcs.
- Toggle commodities, scrub the year, switch value ↔ weight, hover any flow for
  exporter → importer, USD and tonnes.

## Build the data yourself

```bash
# 1. download the HS22 release (~300 MB) into data/raw/BACI_HS22.zip
curl -o data/raw/BACI_HS22.zip \
  https://www.cepii.fr/DATA_DOWNLOAD/baci/data/BACI_HS22_V202601.zip
# 2. a country basemap (Natural Earth) into data/raw/ne_countries.json
curl -o data/raw/ne_countries.json \
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson
# 3. build
python3 scripts/build_data.py
```

Then serve `docs/` (`python3 -m http.server -d docs`) and open it.

## Notes & limits

- Flows are drawn as great-circle arcs between country centroids — a schematic
  of *who trades with whom*, not physical shipping routes.
- Only the top 200 flows per commodity/period are drawn, to keep the map legible
  and the payload small; the on-screen totals reflect the full trade, not just
  what's drawn.
- BACI's "Other Asia, nes" (code 490) is mapped to Taiwan.

## License

Code MIT. Trade data © CEPII (BACI), redistributed under their terms; country
geometry from Natural Earth (public domain).
