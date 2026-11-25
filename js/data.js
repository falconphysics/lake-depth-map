/*
 * Lake Depth Map — data loaders
 *  - NOAA NCEI DEM Global Mosaic (float GeoTIFF) for any bounding box
 *  - AWS Terrain Tiles (Terrarium PNG) — kept for reference; they fill lakes with 0, so no lake floors
 *  - GeoTIFF (via geotiff.js), Esri ASCII grid (.asc), and grayscale images
 * Every loader resolves to { depth: Float32Array (m, NaN = no data), w, h, aspect, ... }
 */
(function (root) {
  'use strict';
  const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  const M_PER_FT = 0.3048;

  // ---------------------------------------------------------------- tiles
  function lonToX(lon, z) { return (lon + 180) / 360 * 256 * Math.pow(2, z); }
  function latToY(lat, z) {
    const s = Math.sin(lat * Math.PI / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * Math.pow(2, z);
  }

  /** Pick a zoom level giving roughly targetPx across the box's longer side. */
  function chooseZoom(bbox, targetPx, maxTiles) {
    maxTiles = maxTiles || 160;
    let best = 0;
    for (let z = 0; z <= 13; z++) {
      const wpx = lonToX(bbox[2], z) - lonToX(bbox[0], z);
      const hpx = latToY(bbox[1], z) - latToY(bbox[3], z);
      const tiles = (Math.ceil(wpx / 256) + 1) * (Math.ceil(hpx / 256) + 1);
      if (tiles > maxTiles) break;
      best = z;
      if (Math.max(wpx, hpx) >= targetPx) break;
    }
    return best;
  }

  async function decodeTile(url, signal) {
    const res = await fetch(url, { mode: 'cors', signal });
    if (!res.ok) throw new Error(`Tile request failed (${res.status})`);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    return ctx.getImageData(0, 0, c.width, c.height).data;
  }

  /**
   * Fetch elevations (m above sea level) for bbox [minLon,minLat,maxLon,maxLat].
   * Returns { elev, w, h, z, toPixel(lon,lat) → [x,y] }
   */
  async function fetchElevation(bbox, targetPx, onProgress, signal) {
    const z = chooseZoom(bbox, targetPx);
    const x0 = Math.floor(lonToX(bbox[0], z)), x1 = Math.ceil(lonToX(bbox[2], z));
    const y0 = Math.floor(latToY(bbox[3], z)), y1 = Math.ceil(latToY(bbox[1], z));
    const w = x1 - x0, h = y1 - y0;
    const elev = new Float32Array(w * h).fill(NaN);
    const tx0 = Math.floor(x0 / 256), tx1 = Math.floor((x1 - 1) / 256);
    const ty0 = Math.floor(y0 / 256), ty1 = Math.floor((y1 - 1) / 256);
    const jobs = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push([tx, ty]);
    let done = 0;
    const n = Math.pow(2, z);
    const worker = async () => {
      while (jobs.length) {
        const [tx, ty] = jobs.shift();
        const url = TILE_URL.replace('{z}', z).replace('{x}', ((tx % n) + n) % n).replace('{y}', ty);
        let px;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { px = await decodeTile(url, signal); break; }
          catch (e) { if (signal && signal.aborted) throw e; if (attempt === 2) throw e; }
        }
        for (let py = 0; py < 256; py++) {
          const gy = ty * 256 + py - y0;
          if (gy < 0 || gy >= h) continue;
          for (let pxi = 0; pxi < 256; pxi++) {
            const gx = tx * 256 + pxi - x0;
            if (gx < 0 || gx >= w) continue;
            const o = (py * 256 + pxi) * 4;
            elev[gy * w + gx] = px[o] * 256 + px[o + 1] + px[o + 2] / 256 - 32768;
          }
        }
        done++;
        onProgress && onProgress(done, done + jobs.length);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    return {
      elev, w, h, z,
      toPixel: (lon, lat) => [lonToX(lon, z) - x0, latToY(lat, z) - y0]
    };
  }

  // ---------------------------------------------------------------- NOAA
  // NOAA NCEI "DEM Global Mosaic" image service: float32 elevations that include the
  // Great Lakes bathymetry (stored as depth below each lake's chart datum, i.e. negative).
  const NOAA_URL = 'https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_global_mosaic/ImageServer/exportImage';

  /**
   * Fetch a float elevation grid for bbox [minLon,minLat,maxLon,maxLat] with square
   * (metre-wise) pixels. Returns the same shape as fetchElevation.
   */
  const R_EARTH = 6378137;
  const mercX = (lon) => R_EARTH * lon * Math.PI / 180;
  const mercY = (lat) => R_EARTH * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));

  async function fetchNOAA(bbox, targetPx, onProgress, signal) {
    const [x0, y0, x1, y1] = bbox;
    // Ask for Web Mercator output (square pixels, the familiar map shape) sized to the
    // box's Mercator proportions so the server doesn't have to pad the extent.
    const mw = mercX(x1) - mercX(x0), mh = mercY(y1) - mercY(y0);
    let w = mw >= mh ? targetPx : Math.round(targetPx * mw / mh);
    let h = Math.round(w * mh / mw);
    w = Math.max(16, Math.min(4000, w)); h = Math.max(16, Math.min(4000, h));
    const params = new URLSearchParams({
      bbox: [x0, y0, x1, y1].join(','), bboxSR: '4326', imageSR: '3857', size: w + ',' + h,
      format: 'tiff', pixelType: 'F32', noData: '-99999', interpolation: 'RSP_BilinearInterpolation', f: 'image'
    });
    onProgress && onProgress(0, 1);
    const res = await fetch(NOAA_URL + '?' + params, { mode: 'cors', signal });
    if (!res.ok) throw new Error('NOAA server answered ' + res.status);
    const buf = await res.arrayBuffer();
    const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
    const isTiff = (head[0] === 0x49 && head[1] === 0x49) || (head[0] === 0x4d && head[1] === 0x4d);
    if (!isTiff) {
      let msg = '';
      try { msg = JSON.parse(new TextDecoder().decode(buf)).error.message; } catch (e) { /* not JSON */ }
      throw new Error('NOAA server did not return elevation data' + (msg ? ': ' + msg : ''));
    }
    const tiff = await GeoTIFF.fromArrayBuffer(buf);
    const img = await tiff.getImage();
    const W = img.getWidth(), H = img.getHeight();
    // The server may adjust the extent to keep pixels square: use the extent it actually returned.
    let ex = [mercX(x0), mercY(y0), mercX(x1), mercY(y1)];
    try {
      const bb = img.getBoundingBox();
      if (bb && bb.every(Number.isFinite) && Math.abs(bb[0]) > 360) ex = bb; // metres, not degrees
    } catch (e) { /* not georeferenced: assume requested extent */ }
    const ras = await img.readRasters({ samples: [0], interleave: true });
    const elev = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const v = ras[i];
      elev[i] = (!Number.isFinite(v) || v < -15000 || v > 10000) ? NaN : v;
    }
    onProgress && onProgress(1, 1);
    return {
      elev, w: W, h: H,
      toPixel: (lon, lat) => [(mercX(lon) - ex[0]) / (ex[2] - ex[0]) * W, (ex[3] - mercY(lat)) / (ex[3] - ex[1]) * H]
    };
  }

  /** Mask pixels that fall inside any [minLon,minLat,maxLon,maxLat] box. */
  function excludeMask(tile, boxes) {
    if (!boxes || !boxes.length) return null;
    const m = new Uint8Array(tile.w * tile.h);
    for (const b of boxes) {
      const [ax, ay] = tile.toPixel(b[0], b[3]);
      const [bx, by] = tile.toPixel(b[2], b[1]);
      for (let y = Math.max(0, Math.floor(ay)); y < Math.min(tile.h, Math.ceil(by)); y++)
        for (let x = Math.max(0, Math.floor(ax)); x < Math.min(tile.w, Math.ceil(bx)); x++) m[y * tile.w + x] = 1;
    }
    return m;
  }

  // ---------------------------------------------------------------- files
  const MAX_SIDE = 2048;

  /**
   * Convert raw values to depth (m).
   * opts.meaning: 'elevation' | 'depth' | 'negdepth'; opts.surface (same units as values);
   * opts.units: 'm' | 'ft'; opts.nodata
   */
  function valuesToDepth(vals, opts) {
    const k = opts.units === 'ft' ? M_PER_FT : 1;
    const out = new Float32Array(vals.length);
    const nd = opts.nodata;
    for (let i = 0; i < vals.length; i++) {
      let v = vals[i];
      if (!Number.isFinite(v) || (nd != null && Math.abs(v - nd) < 1e-6) || v < -1e30 || v > 1e30) { out[i] = NaN; continue; }
      const d = opts.meaning === 'elevation' ? (opts.surface - v) : opts.meaning === 'negdepth' ? -v : v;
      out[i] = d * k;
    }
    return out;
  }

  function stats(vals, nodata) {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (!Number.isFinite(v) || (nodata != null && Math.abs(v - nodata) < 1e-6) || Math.abs(v) > 1e30) continue;
      if (v < min) min = v; if (v > max) max = v;
    }
    return { min, max };
  }

  async function readGeoTIFF(buf) {
    const tiff = await GeoTIFF.fromArrayBuffer(buf);
    const img = await tiff.getImage();
    const W = img.getWidth(), H = img.getHeight();
    const f = Math.max(1, Math.max(W, H) / MAX_SIDE);
    const w = Math.round(W / f), h = Math.round(H / f);
    const ras = await img.readRasters({ samples: [0], width: w, height: h, resampleMethod: 'bilinear', interleave: true });
    let nodata = null;
    try { nodata = img.getGDALNoData(); } catch (e) { /* none */ }
    let rawAspect = 1, geoAspect = 1, geographic = false;
    try {
      const keys = img.getGeoKeys() || {};
      const res = img.getResolution();
      const bb = img.getBoundingBox();
      geographic = keys.GTModelTypeGeoKey === 2 || (Math.abs(bb[0]) <= 180 && Math.abs(bb[2]) <= 180 && Math.abs(res[0]) < 1);
      rawAspect = Math.abs(res[0] / res[1]);
      geoAspect = rawAspect * Math.cos(((bb[1] + bb[3]) / 2) * Math.PI / 180);
    } catch (e) { /* not georeferenced: square pixels */ }
    const vals = Float32Array.from(ras);
    return { vals, w, h, rawAspect, geoAspect, geographic, nodata, ...stats(vals, nodata) };
  }

  function readASC(text) {
    const lines = text.split(/\r?\n/);
    const hdr = {};
    let i = 0;
    for (; i < lines.length; i++) {
      const m = lines[i].trim().match(/^([a-zA-Z_]+)\s+(\S+)/);
      if (!m || !/^(ncols|nrows|xllcorner|yllcorner|xllcenter|yllcenter|cellsize|dx|dy|nodata_value)$/i.test(m[1])) break;
      hdr[m[1].toLowerCase()] = parseFloat(m[2]);
    }
    const W = hdr.ncols, H = hdr.nrows;
    if (!W || !H) throw new Error('Not an Esri ASCII grid (missing ncols/nrows)');
    const all = new Float32Array(W * H);
    let n = 0;
    for (; i < lines.length && n < W * H; i++) {
      const parts = lines[i].trim().split(/\s+/);
      for (const p of parts) if (p !== '') all[n++] = parseFloat(p);
    }
    const f = Math.max(1, Math.ceil(Math.max(W, H) / MAX_SIDE));
    const w = Math.floor(W / f), h = Math.floor(H / f);
    const vals = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) vals[y * w + x] = all[(y * f) * W + x * f];
    const dx = hdr.dx || hdr.cellsize || 1, dy = hdr.dy || hdr.cellsize || 1;
    const x0 = hdr.xllcorner != null ? hdr.xllcorner : hdr.xllcenter;
    const y0 = hdr.yllcorner != null ? hdr.yllcorner : hdr.yllcenter;
    const geographic = Math.abs(x0) <= 180 && Math.abs(y0) <= 90 && dx < 1;
    const rawAspect = dx / dy;
    const geoAspect = rawAspect * Math.cos((y0 + dy * H / 2) * Math.PI / 180);
    const nodata = hdr.nodata_value != null ? hdr.nodata_value : null;
    return { vals, w, h, rawAspect, geoAspect, geographic, nodata, ...stats(vals, nodata) };
  }

  /** Grayscale image → 0..1 "deepness". Land = transparent or the extreme light/dark end. */
  async function readImage(file, darkerIsDeeper) {
    const bmp = await createImageBitmap(file);
    const f = Math.max(1, Math.max(bmp.width, bmp.height) / MAX_SIDE);
    const w = Math.round(bmp.width / f), h = Math.round(bmp.height / f);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const vals = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const a = px[i * 4 + 3];
      const lum = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255;
      const deep = darkerIsDeeper ? 1 - lum : lum;
      vals[i] = a < 128 || deep < 0.015 ? NaN : deep;
    }
    return { vals, w, h, rawAspect: 1, geoAspect: 1, geographic: false, nodata: null, min: 0, max: 1, isImage: true };
  }

  root.LakeData = { fetchNOAA, fetchElevation, excludeMask, chooseZoom, readGeoTIFF, readASC, readImage, valuesToDepth, stats };
})(typeof self !== 'undefined' ? self : this);
