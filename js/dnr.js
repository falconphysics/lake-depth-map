/*
 * Lake Depth Map — Michigan DNR inland lake contours
 * Source: MDNR / Institute for Fisheries Research "IFR MI Inland Lake Contours"
 * (State of Michigan Open Data). Contour lines with MinDepth = contour value in feet;
 * the 0 ft contour is the shoreline. We rasterise the contours and build a smooth
 * lake floor that passes exactly through every contour.
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

  // ---- Euclidean distance transform (Felzenszwalb & Huttenlocher), distance to nearest set pixel
  function edt1d(f, n, d, v, z) {
    let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
  }
  function distanceTo(set, w, h) {
    const INF = 1e20, n = Math.max(w, h);
    const g = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = set[i] ? 0 : INF;
    const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = g[y * w + x];
      edt1d(f, h, d, v, z);
      for (let y = 0; y < h; y++) g[y * w + x] = d[y];
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) f[x] = g[y * w + x];
      edt1d(f, w, d, v, z);
      for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]);
    }
    return out;
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
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const toPath = (rings) => {
      const p = new Path2D();
      for (const r of rings) {
        r.forEach((pt, i) => {
          const px = (pt[0] - x0) * scale, py = (y1 - pt[1]) * scale;
          i ? p.lineTo(px, py) : p.moveTo(px, py);
        });
        p.closePath();
      }
      return p;
    };
    const masks = levels.map(d => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#fff';
      ctx.fill(toPath(byDepth.get(d)), 'evenodd');
      const px = ctx.getImageData(0, 0, w, h).data;
      const m = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) m[i] = px[i * 4 + 3] > 127 ? 1 : 0;
      return m;
    });
    // enforce nesting: deeper areas must lie inside shallower ones
    for (let k = 1; k < masks.length; k++) for (let i = 0; i < w * h; i++) masks[k][i] &= masks[k - 1][i];

    const depthFt = new Float32Array(w * h).fill(-1);
    for (let k = 0; k < levels.length; k++) {
      const inK = masks[k];
      const notK = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) notK[i] = inK[i] ? 0 : 1;
      const dOut = distanceTo(notK, w, h); // distance from inside level k to its edge
      const next = masks[k + 1];
      const dNext = next ? distanceTo(next, w, h) : null;
      let maxIn = 0;
      if (!next) for (let i = 0; i < w * h; i++) if (inK[i] && dOut[i] > maxIn) maxIn = dOut[i];
      const bottom = Math.max(levels[k], maxAttr);
      for (let i = 0; i < w * h; i++) {
        if (!inK[i] || (next && next[i])) continue;
        if (next) {
          const a = dOut[i], b = dNext[i];
          depthFt[i] = levels[k] + (levels[k + 1] - levels[k]) * (a / (a + b));
        } else {
          // deepest area: rise gently toward the deepest reported point, if deeper than the last contour
          depthFt[i] = levels[k] + (bottom - levels[k]) * (maxIn ? Math.min(1, dOut[i] / maxIn) : 0);
        }
      }
    }
    const depth = new Float32Array(w * h);
    let maxDepth = 0;
    for (let i = 0; i < w * h; i++) {
      depth[i] = depthFt[i] < 0 ? -1 : Math.max(0.01, depthFt[i] * M_PER_FT);
      if (depth[i] > maxDepth) maxDepth = depth[i];
    }
    return { depth, w, h, maxDepth, levelsFt: levels, name };
  }

  root.LakeDNR = { inMichigan, findLakeAt, loadLake };
})(typeof self !== 'undefined' ? self : this);
