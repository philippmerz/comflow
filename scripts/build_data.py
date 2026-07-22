#!/usr/bin/env python3
"""Build comflow's static flow data from a BACI (CEPII) HS22 release.

BACI schema (per year CSV): t,i,j,k,v,q
  t=year  i=exporter(num)  j=importer(num)  k=HS6 product
  v=value in THOUSAND USD   q=quantity in METRIC TONNES

We keep only the six hard-commodity HS4 groups, aggregate their HS6 subcodes,
join numeric country codes to ISO3 + a representative lon/lat, and emit the
top-N flows per commodity per year as a single compact JSON the static site
loads directly. Streams each ~360MB year member without extracting it, so it
runs inside this VM's small RAM/disk budget.
"""

import csv
import io
import json
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RAW = os.path.join(ROOT, "data", "raw")
OUT = os.path.join(ROOT, "docs", "data")
ZIP = os.path.join(RAW, "BACI_HS22.zip")
NE = os.path.join(RAW, "ne_countries.json")

TOP_N = 200  # top flows per commodity per year (spec: ~200, to limit clutter)

# Commodity definitions: HS4 group -> label + subcodes are matched by prefix.
# `color` is the on-map hue for that commodity (assigned in the frontend, but
# kept here so data + legend share one source of truth).
COMMODITIES = [
    {"id": "iron_ore",       "hs4": "2601", "label": "Iron ore",          "color": [232, 93, 74]},
    {"id": "coal",           "hs4": "2701", "label": "Coal",              "color": [150, 150, 158]},
    {"id": "copper_ore",     "hs4": "2603", "label": "Copper ore",        "color": [214, 160, 92]},
    {"id": "refined_copper", "hs4": "7403", "label": "Refined copper",    "color": [227, 122, 63]},
    {"id": "bauxite",        "hs4": "2606", "label": "Bauxite",           "color": [110, 176, 168]},
    {"id": "aluminium",      "hs4": "7601", "label": "Unwrought aluminium","color": [93, 150, 224]},
    {"id": "ferro_alloys",   "hs4": "7202", "label": "Ferro-alloys",      "color": [200, 110, 165]},
    {"id": "nickel",         "hs4": "7502", "label": "Nickel",            "color": [116, 199, 140]},
    {"id": "zinc",           "hs4": "7901", "label": "Zinc",              "color": [130, 205, 215]},
    {"id": "lead",           "hs4": "7801", "label": "Lead",              "color": [156, 138, 202]},
    {"id": "tin",            "hs4": "8001", "label": "Tin",               "color": [206, 196, 138]},
    {"id": "potash",         "hs4": "3104", "label": "Potash",            "color": [222, 132, 178]},
]
HS4_TO_ID = {c["hs4"]: c["id"] for c in COMMODITIES}
TARGET_HS4 = set(HS4_TO_ID)


# BACI carries some UN "areas nes" numeric codes without a clean ISO3. Map the
# ones that are effectively a real economy with map geometry so their (often
# large) flows aren't dropped. 490 = "Other Asia, nes" — overwhelmingly Taiwan.
COUNTRY_OVERRIDES = {
    "490": ("TWN", "Taiwan"),
}
# Clean display names for a few ISO3s whose Natural Earth label is terse/blank.
NAME_FIXES = {"TWN": "Taiwan"}


def load_country_codes(z):
    """numeric code (str) -> (iso3, name)."""
    out = {}
    txt = z.read("country_codes_V202601.csv").decode("utf-8", "replace").splitlines()
    rd = csv.DictReader(txt)
    for row in rd:
        code = (row.get("country_code") or "").strip()
        iso3 = (row.get("country_iso3") or "").strip().upper()
        name = (row.get("country_name") or "").strip()
        if code and iso3 and iso3 != "NULL" and len(iso3) == 3 and iso3.isalpha():
            out[code] = (iso3, name)
    for code, pair in COUNTRY_OVERRIDES.items():
        out.setdefault(code, pair)
    return out


def ring_area_centroid(ring):
    """Signed area + area-weighted centroid of one lon/lat ring (planar approx)."""
    a = cx = cy = 0.0
    n = len(ring)
    for i in range(n - 1):
        x0, y0 = ring[i]
        x1, y1 = ring[i + 1]
        cross = x0 * y1 - x1 * y0
        a += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    if a == 0:
        # degenerate — fall back to vertex mean
        xs = [p[0] for p in ring]; ys = [p[1] for p in ring]
        return 0.0, (sum(xs) / n, sum(ys) / n)
    a *= 0.5
    return abs(a), (cx / (6 * a), cy / (6 * a))


def load_centroids(path):
    """ISO3 -> (lon, lat), using the largest polygon so island nations and
    countries with distant territories anchor on their mainland."""
    gj = json.load(open(path))
    out = {}
    for feat in gj["features"]:
        p = feat["properties"]
        iso3 = (p.get("ISO_A3") or p.get("ADM0_A3") or "").strip().upper()
        if not iso3 or len(iso3) != 3:
            continue
        geom = feat.get("geometry") or {}
        polys = []
        if geom.get("type") == "Polygon":
            polys = [geom["coordinates"]]
        elif geom.get("type") == "MultiPolygon":
            polys = geom["coordinates"]
        best_area, best_c = -1.0, None
        for poly in polys:
            if not poly:
                continue
            area, c = ring_area_centroid(poly[0])
            if area > best_area:
                best_area, best_c = area, c
        if best_c:
            out[iso3] = (round(best_c[0], 3), round(best_c[1], 3))
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    z = zipfile.ZipFile(ZIP)
    num2iso = load_country_codes(z)
    centroids = load_centroids(NE)
    print(f"country codes: {len(num2iso)}  centroids: {len(centroids)}")

    year_members = sorted(
        n for n in z.namelist() if n.startswith("BACI_HS22_Y") and n.endswith(".csv")
    )

    # agg[(year, commodity_id, exporter_iso, importer_iso)] = [value_kusd, tonnes]
    agg = {}
    unmatched = set()
    for member in year_members:
        year = int(member.split("_Y")[1][:4])
        kept = 0
        with z.open(member) as fh:
            reader = csv.reader(io.TextIOWrapper(fh, "utf-8"))
            next(reader, None)  # header
            for row in reader:
                # t,i,j,k,v,q
                if len(row) < 6:
                    continue
                k = row[3]
                hs4 = k[:4]
                if hs4 not in TARGET_HS4:
                    continue
                ei = num2iso.get(row[1])
                ji = num2iso.get(row[2])
                if not ei:
                    unmatched.add(row[1]); continue
                if not ji:
                    unmatched.add(row[2]); continue
                ex, im = ei[0], ji[0]
                if ex == im:
                    continue
                if ex not in centroids or im not in centroids:
                    continue
                try:
                    v = float(row[4]); q = float(row[5]) if row[5] not in ("", "NA") else 0.0
                except ValueError:
                    continue
                key = (year, HS4_TO_ID[hs4], ex, im)
                cell = agg.get(key)
                if cell is None:
                    agg[key] = [v, q]
                else:
                    cell[0] += v; cell[1] += q
                kept += 1
        print(f"  {year}: kept {kept} commodity rows")

    # Build per (commodity, year) top-N lists.
    names = {iso: nm for _, (iso, nm) in num2iso.items()}
    names.update(NAME_FIXES)
    flows = {}          # commodity_id -> year(str) -> [flow,...]
    totals = {}         # commodity_id -> year(str) -> {value_usd, tonnes, n}
    years = set()
    grouped = {}
    for (year, cid, ex, im), (v, q) in agg.items():
        grouped.setdefault((cid, year), []).append((v, q, ex, im))
        years.add(year)

    for (cid, year), rows in grouped.items():
        rows.sort(key=lambda r: r[0], reverse=True)
        top = rows[:TOP_N]
        arr = []
        tot_v = tot_q = 0.0
        for v, q, ex, im in top:
            elon, elat = centroids[ex]
            ilon, ilat = centroids[im]
            value_usd = int(round(v * 1000))  # kUSD -> USD
            tonnes = int(round(q))
            arr.append({
                "e": ex, "i": im,
                "es": [elon, elat], "is": [ilon, ilat],
                "v": value_usd, "w": tonnes,
            })
        # totals reflect the FULL commodity/year (all pairs), not just top-N
        for v, q, ex, im in rows:
            tot_v += v * 1000; tot_q += q
        flows.setdefault(cid, {})[str(year)] = arr
        totals.setdefault(cid, {})[str(year)] = {
            "value_usd": int(round(tot_v)),
            "tonnes": int(round(tot_q)),
            "shown": len(arr),
            "pairs": len(rows),
        }

    years = sorted(years)
    payload = {
        "meta": {
            "source": "BACI (CEPII) HS22 V202601 — reconciled UN Comtrade",
            "generated_from": "BACI_HS22_V202601.zip",
            "value_unit": "USD", "weight_unit": "tonnes",
            "top_n": TOP_N, "years": years,
            "commodities": COMMODITIES,
        },
        "totals": totals,
        "flows": flows,
    }

    country_meta = {iso: {"name": names.get(iso, iso), "c": centroids[iso]}
                    for iso in centroids}

    with open(os.path.join(OUT, "flows.json"), "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    with open(os.path.join(OUT, "countries.json"), "w") as f:
        json.dump(country_meta, f, separators=(",", ":"))

    fp = os.path.join(OUT, "flows.json")
    print(f"\nwrote {fp}  ({os.path.getsize(fp)/1024:.0f} KB)")
    print(f"years: {years}")
    for c in COMMODITIES:
        cid = c["id"]
        per = totals.get(cid, {})
        latest = years[-1]
        t = per.get(str(latest))
        if t:
            print(f"  {c['label']:20} {latest}: ${t['value_usd']/1e9:6.1f}B  "
                  f"{t['shown']}/{t['pairs']} flows shown")
    if unmatched:
        print(f"unmatched numeric codes (skipped): {sorted(unmatched)[:15]}"
              f"{' ...' if len(unmatched) > 15 else ''}")


if __name__ == "__main__":
    main()
