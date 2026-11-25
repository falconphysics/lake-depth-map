#!/usr/bin/env python3
"""
Build tiled Michigan road data for Lake Depth Map Maker.

Downloads the US Census Bureau TIGER/Line "All Roads" file for every Michigan county,
keeps the road types the site draws, simplifies the lines, and writes small tiles:

    data/mi-roads/index.json        list of tiles + metadata
    data/mi-roads/<ix>_<iy>.json    roads touching one 0.25-degree tile

Road classes (same scale the site's Roads slider uses):
    1  freeways            (MTFCC S1100, primary / limited-access)
    2  US highways         (S1200 with RTTYP U)
    3  state & county hwys (other S1200 secondary roads)
    4  local roads         (S1400)

Each tile is {"r": [[cls, x0, y0, dx1, dy1, ...], ...]} with coordinates in
1e-5 degrees, delta-encoded. Run by .github/workflows/build-michigan-roads.yml.
Usage: python tools/build_michigan_roads.py [--year 2024] [--out data/mi-roads] [--src DIR]
"""
import argparse, io, json, math, os, sys, time, urllib.request, zipfile, datetime
import shapefile  # pyshp

STATE = '26'  # Michigan
TILE = 0.25
SCALE = 100000
TOL_M = 4.0   # simplification tolerance in metres


def classify(mtfcc, rttyp):
    if mtfcc == 'S1100':
        return 1
    if mtfcc == 'S1200':
        return 2 if rttyp == 'U' else 3
    if mtfcc == 'S1400':
        return 4
    return 0


def dp(pts, tol):
    """Douglas-Peucker on [(x, y)] in metres-ish units."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    t2 = tol * tol
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]; bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        L = dx * dx + dy * dy
        md, mi = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            if L:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
                qx, qy = ax + t * dx - px, ay + t * dy - py
            else:
                qx, qy = ax - px, ay - py
            d = qx * qx + qy * qy
            if d > md:
                md, mi = d, i
        if md > t2:
            keep[mi] = True
            stack.append((a, mi)); stack.append((mi, b))
    return [p for p, k in zip(pts, keep) if k]


def county_zips(year, src):
    """Yield (fips, zip bytes) for each county; from --src dir if given, else download."""
    for n in range(1, 166, 2):
        fips = f'{STATE}{n:03d}'
        name = f'tl_{year}_{fips}_roads.zip'
        if src:
            path = os.path.join(src, name)
            if os.path.exists(path):
                yield fips, open(path, 'rb').read()
            continue
        url = f'https://www2.census.gov/geo/tiger/TIGER{year}/ROADS/{name}'
        for attempt in range(4):
            try:
                with urllib.request.urlopen(url, timeout=120) as r:
                    yield fips, r.read()
                break
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    break  # not a county FIPS code
                time.sleep(3 * (attempt + 1))
            except Exception as e:  # network hiccup: retry
                print(f'  {fips}: {e} (retrying)', file=sys.stderr)
                time.sleep(3 * (attempt + 1))
        else:
            sys.exit(f'Failed to download {url}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--year', default='2024')
    ap.add_argument('--out', default='data/mi-roads')
    ap.add_argument('--src', default=None, help='folder of already-downloaded county zips')
    a = ap.parse_args()

    kx = math.cos(math.radians(44.5)) * 111320.0  # metres per degree of longitude in Michigan
    ky = 111320.0
    seen = set()
    tiles = {}
    counts = [0] * 5
    ncounty = 0
    for fips, data in county_zips(a.year, a.src):
        ncounty += 1
        z = zipfile.ZipFile(io.BytesIO(data))
        base = [n[:-4] for n in z.namelist() if n.endswith('.shp')][0]
        rd = shapefile.Reader(shp=io.BytesIO(z.read(base + '.shp')), shx=io.BytesIO(z.read(base + '.shx')),
                              dbf=io.BytesIO(z.read(base + '.dbf')))
        fields = [f[0] for f in rd.fields[1:]]
        i_id, i_mt, i_rt = fields.index('LINEARID'), fields.index('MTFCC'), fields.index('RTTYP')
        kept = 0
        for sr in rd.iterShapeRecords():
            rec = sr.record
            cls = classify(rec[i_mt], rec[i_rt])
            if not cls:
                continue
            lid = rec[i_id]
            if lid in seen:
                continue  # roads on county lines appear in both counties
            seen.add(lid)
            shp = sr.shape
            parts = list(shp.parts) + [len(shp.points)]
            for p in range(len(parts) - 1):
                pts = shp.points[parts[p]:parts[p + 1]]
                if len(pts) < 2:
                    continue
                m = dp([(x * kx, y * ky) for x, y in pts], TOL_M)
                q = []
                for x, y in m:
                    qx, qy = round(x / kx * SCALE), round(y / ky * SCALE)
                    if not q or (qx, qy) != q[-1]:
                        q.append((qx, qy))
                if len(q) < 2:
                    continue
                flat = [cls, q[0][0], q[0][1]]
                for i in range(1, len(q)):
                    flat += [q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]]
                keys = {(math.floor(x / SCALE / TILE), math.floor(y / SCALE / TILE)) for x, y in q}
                for k in keys:
                    tiles.setdefault(k, []).append(flat)
                counts[cls] += 1
                kept += 1
        print(f'{fips}: {kept} road lines', flush=True)

    if ncounty == 0:
        sys.exit('No county files found')
    os.makedirs(a.out, exist_ok=True)
    for f in os.listdir(a.out):
        if f.endswith('.json'):
            os.remove(os.path.join(a.out, f))
    total = 0
    for (ix, iy), lines in tiles.items():
        path = os.path.join(a.out, f'{ix}_{iy}.json')
        with open(path, 'w') as fh:
            json.dump({'r': lines}, fh, separators=(',', ':'))
        total += os.path.getsize(path)
    index = {
        'source': f'US Census Bureau TIGER/Line {a.year} All Roads, Michigan ({ncounty} counties)',
        'built': datetime.date.today().isoformat(),
        'tile': TILE, 'scale': SCALE,
        'classes': {'1': 'freeways', '2': 'US highways', '3': 'state & county highways', '4': 'local roads'},
        'counts': {str(c): counts[c] for c in range(1, 5)},
        'tiles': sorted(f'{ix}_{iy}' for ix, iy in tiles),
    }
    with open(os.path.join(a.out, 'index.json'), 'w') as fh:
        json.dump(index, fh, separators=(',', ':'))
    print(f'{len(tiles)} tiles, {total / 1e6:.1f} MB, lines by class {counts[1:]}')


if __name__ == '__main__':
    main()
