/*
 * Lake Depth Map — Michigan DNR inland lake contours
 * Source: MDNR / Institute for Fisheries Research "IFR MI Inland Lake Contours"
 * (State of Michigan Open Data). Contour lines with MinDepth = contour value in feet;
 * the 0 ft contour is the shoreline. Contours are often stored in pieces, so we treat
 * every contour line as a fixed depth and solve for the smoothest floor through them.
 */
(function (root) {
  'use strict';
  const URL_BASE = 'https://services3.arcgis.com/Jdnp1TjADvSDxMAX/arcgis/rest/services/DNRHydrologyOPENDATA/FeatureServer/1/query';
  const M_PER_FT = 0.3048;
  const R = 6378137;
  const mercX = (lon) => R * lon * Math.PI / 180;
  const mercY = (lat) => R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));

  /** Rough Michigan bounding box: only ask the DNR when the marker is in or near Michigan. */
  function inMichigan(lon, lat) { return lon > -90.6 && lon < -82.1 && lat > 41.6 && lat < 48.4; }

  /** Run a paginated ArcGIS query; returns all features (esri JSON). */
  async function queryAll(params, signal) {
    const out = [];
    let offset = 0;
    for (let page = 0; page < 30; page++) {
      const p = new URLSearchParams(Object.assign({ f: 'json', resultOffset: String(offset), resultRecordCount: '2000' }, params));
      const res = await fetch(URL_BASE + '?' + p, { mode: 'cors', signal });
      if (!res.ok) throw new Error('Michigan DNR server answered ' + res.status);
      const j = await res.json();
      if (j.error) throw new Error('Michigan DNR: ' + (j.error.message || 'query failed'));
      const feats = j.features || [];
      out.push(...feats);
      if (!j.exceededTransferLimit || !feats.length) break;
      offset += feats.length;
    }
    return out;
  }

  function pointInRings(x, y, rings) {
    let inside = false;
    for (const r of rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }

  /**
   * Find the DNR lake whose shoreline contains (lon, lat). viewBbox limits the search.
   * Returns { key, name } or null.
   */
  async function findLakeAt(lon, lat, viewBbox, signal) {
    const feats = await queryAll({
      where: 'MinDepth = 0', geometry: viewBbox.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', outFields: 'NewKey,Name', outSR: '3857', returnGeometry: 'true',
      maxAllowableOffset: '10'
    }, signal);
    const lakes = new Map();
    for (const f of feats) {
      const key = f.attributes.NewKey;
      if (!key || !f.geometry || !f.geometry.paths) continue;
      if (!lakes.has(key)) lakes.set(key, { key, name: f.attributes.Name || '', rings: [] });
      lakes.get(key).rings.push(...f.geometry.paths);
    }
    const x = mercX(lon), y = mercY(lat);
    let best = null;
    for (const lk of lakes.values()) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const r of lk.rings) for (const p of r) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const inside = pointInRings(x, y, lk.rings);
      const area = (x1 - x0) * (y1 - y0);
      // prefer a true point-in-shoreline hit; otherwise the smallest lake whose box holds the marker
      const score = (inside ? 0 : 1e15) + area;
      if (!best || score < best.score) best = { key: lk.key, name: lk.name, score, inside };
    }
    return best;
  }

  /** Join path pieces whose ends meet (within tol) into longer chains; closes loops when possible. */
  function joinPaths(paths, tol) {
    const t2 = tol * tol;
    const close = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 <= t2;
    const pool = paths.filter(p => p.length > 1).map(p => p.slice());
    const out = [];
    while (pool.length) {
      let chain = pool.pop();
      let grew = true;
      while (grew && !close(chain[0], chain[chain.length - 1])) {
        grew = false;
        for (let i = 0; i < pool.length; i++) {
          const p = pool[i], a = chain[0], b = chain[chain.length - 1];
          if (close(b, p[0])) chain = chain.concat(p.slice(1));
          else if (close(b, p[p.length - 1])) chain = chain.concat(p.slice(0, -1).reverse());
          else if (close(a, p[p.length - 1])) chain = p.concat(chain.slice(1));
          else if (close(a, p[0])) chain = p.slice().reverse().concat(chain.slice(1));
          else continue;
          pool.splice(i, 1); grew = true; break;
        }
      }
      out.push(chain);
    }
    return out;
  }

  /** Draw polylines into a grid (value v), visiting every pixel each segment crosses. */
  function drawLines(paths, toPx, w, h, grid, v, mask) {
    for (const path of paths) {
      for (let i = 1; i < path.length; i++) {
        const [ax, ay] = toPx(path[i - 1]), [bx, by] = toPx(path[i]);
        const n = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 2));
        for (let k = 0; k <= n; k++) {
          const x = Math.floor(ax + (bx - ax) * k / n), y = Math.floor(ay + (by - ay) * k / n);
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const idx = y * w + x;
          if (mask[idx] && !(grid[idx] > v)) grid[idx] = v; // keep the deeper value where lines touch
        }
      }
    }
  }

  /**
   * Smoothest surface (Laplace equation) through the contour lines, with the shoreline
   * held at 0. Solved coarse-to-fine with over-relaxation, so it stays fast in the browser.
   */
  function harmonicFloor(mask, w, h, contours, toPxFull) {
    const levels = [];
    for (let f = 1; Math.max(w, h) / f >= 24; f *= 2) levels.push(f);
    let prev = null, prevW = 0, prevF = 0;
    for (let li = levels.length - 1; li >= 0; li--) {
      const f = levels[li], wl = Math.ceil(w / f), hl = Math.ceil(h / f);
      const m = new Uint8Array(wl * hl);
      for (let y = 0; y < hl; y++) for (let x = 0; x < wl; x++) {
        const sy = Math.min(h - 1, y * f + (f >> 1)), sx = Math.min(w - 1, x * f + (f >> 1));
        m[y * wl + x] = mask[sy * w + sx];
      }
      const known = new Float32Array(wl * hl).fill(NaN);
      const toPx = (pt) => { const q = toPxFull(pt); return [q[0] / f, q[1] / f]; };
      for (const c of contours) drawLines(c.paths, toPx, wl, hl, known, c.depth, m);
      const u = new Float32Array(wl * hl);
      for (let i = 0; i < wl * hl; i++) {
        if (!m[i]) continue;
        if (known[i] === known[i]) { u[i] = known[i]; continue; }
        if (prev) {
          const x = i % wl, y = (i - x) / wl;
          const px = Math.min(prevW - 1, Math.floor(x * f / prevF)), py = Math.floor(y * f / prevF);
          u[i] = prev[py * prevW + px] || 0;
        }
      }
      const iters = li === levels.length - 1 ? 600 : (li === 0 ? 160 : 100);
      const idx = [];
      for (let i = 0; i < wl * hl; i++) if (m[i] && known[i] !== known[i]) idx.push(i);
      const w4 = 1.85 / 4;
      for (let it = 0; it < iters; it++) {
        for (let n = 0; n < idx.length; n++) {
          const i = idx[n], x = i % wl;
          const l = x > 0 && m[i - 1] ? u[i - 1] : 0, r = x < wl - 1 && m[i + 1] ? u[i + 1] : 0;
          const t = i >= wl && m[i - wl] ? u[i - wl] : 0, b = i + wl < wl * hl && m[i + wl] ? u[i + wl] : 0;
          u[i] += w4 * (l + r + t + b) - 1.85 * u[i];
          // (u += ω·(avg − u), written out)
        }
      }
      prev = u; prevW = wl; prevF = f;
    }
    return prev;
  }

  /**
   * Download every contour of a lake and build a depth grid (metres, outside = -1).
   * Returns { depth, w, h, maxDepth, levelsFt, name }.
   */
  async function loadLake(key, targetPx, onStatus, signal) {
    onStatus && onStatus('Downloading Michigan DNR contours…');
    const safeKey = String(key).replace(/'/g, "''");
    const feats = await queryAll({
      where: `NewKey = '${safeKey}'`, outFields: 'MinDepth,MaxDepth,Name', outSR: '3857', returnGeometry: 'true'
    }, signal);
    const byDepth = new Map();
    let name = '', maxAttr = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const f of feats) {
      if (!f.geometry || !f.geometry.paths) continue;
      const d = Number(f.attributes.MinDepth) || 0;
      name = name || f.attributes.Name || '';
      maxAttr = Math.max(maxAttr, Number(f.attributes.MaxDepth) || 0);
      if (!byDepth.has(d)) byDepth.set(d, []);
      byDepth.get(d).push(...f.geometry.paths);
      if (d === 0) for (const r of f.geometry.paths) for (const p of r) {
        x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
      }
    }
    if (!byDepth.has(0) || !Number.isFinite(x0)) throw new Error('This lake has no shoreline in the DNR contours');
    const levels = Array.from(byDepth.keys()).sort((a, b) => a - b);

    onStatus && onStatus('Building the lake floor…');
    await new Promise(r => setTimeout(r, 0));
    // grid in Web Mercator with a small margin
    const pad = 0.03 * Math.max(x1 - x0, y1 - y0);
    x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
    const scale = targetPx / Math.max(x1 - x0, y1 - y0);
    const w = Math.max(16, Math.round((x1 - x0) * scale)), h = Math.max(16, Math.round((y1 - y0) * scale));
    const toPxFull = (pt) => [(pt[0] - x0) * scale, (y1 - pt[1]) * scale];
    // Lake outline: fill the (joined) shoreline + island loops, even-odd.
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const shore = new Path2D();
    for (const r of joinPaths(byDepth.get(0), 2)) {
      r.forEach((pt, i) => { const q = toPxFull(pt); i ? shore.lineTo(q[0], q[1]) : shore.moveTo(q[0], q[1]); });
      shore.closePath();
    }
    ctx.fillStyle = '#fff';
    ctx.fill(shore, 'evenodd');
    const px = ctx.getImageData(0, 0, w, h).data;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = px[i * 4 + 3] > 127 ? 1 : 0;

    const contours = levels.filter(d => d > 0).map(d => ({ depth: d, paths: byDepth.get(d) }));
    const floorFt = harmonicFloor(mask, w, h, contours, toPxFull);
    const depth = new Float32Array(w * h);
    let maxDepth = 0;
    for (let i = 0; i < w * h; i++) {
      depth[i] = mask[i] ? Math.max(0.01, floorFt[i] * M_PER_FT) : -1;
      if (depth[i] > maxDepth) maxDepth = depth[i];
    }
    return { depth, w, h, maxDepth, levelsFt: levels, name, geo: { mx0: x0, my1: y1, mpp: 1 / scale } };
  }

  root.LakeDNR = { inMichigan, findLakeAt, loadLake };
})(typeof self !== 'undefined' ? self : this);
