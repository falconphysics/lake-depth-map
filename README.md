# Lake Depth Map Maker

A static web tool that turns lake bathymetry into stacked, laser-cuttable SVG sheets. When the sheets are cut from plywood, painted and stacked, they make a layered depth map for the wall.

- **All five Great Lakes are built in.** One click downloads NOAA's Great Lakes bathymetry from NOAA NCEI's public DEM Global Mosaic image service.
- **Pick on map**: Michigan inland lakes load automatically from the Michigan DNR's lake contour maps, and the tool builds a smooth lake floor through every contour. Other lakes use NOAA's data where it exists.
- **Upload data** covers every other lake. It accepts a GeoTIFF, an Esri ASCII grid (`.asc`), or a grayscale image.
- **Roads and towns:** two sliders add them to the top sheet as score lines and labels, clipped to the land and kept clear of the title and pin holes. Everything is bundled with the site, so it never waits on an outside server:
  - `data-map.json`: Natural Earth highways, GeoNames towns (1,000+ people) and a Michigan outline, for the Great Lakes region.
  - `data/mi-roads/`: Michigan's full road network (US Census TIGER/Line), tiled. It's built by the **Build Michigan roads** GitHub Action (`tools/build_michigan_roads.py`). Inside Michigan it replaces the regional roads, and it adds local streets.
- **Output:** one SVG per sheet at real size (mm). Red lines are cuts and blue lines are scores. Each sheet gets alignment pin holes, a hidden sheet number and glue guides. The top sheet gets an engraved title in a single-stroke font, so there's no font conversion to do. You can download everything as a ZIP that also has a combined sheet and assembly notes.

There's no build step and no server code. Every library is vendored in `vendor/`, so the site runs entirely in the browser.

## Put it on GitHub Pages

1. Create a new repository, for example `lake-depth-map`.
2. Upload everything in this folder to the root of the repo, `.nojekyll` included.
3. In the repo, go to **Settings → Pages → Build and deployment**. Choose **Deploy from a branch**, then pick `main` and `/ (root)`.
4. After a minute the site is live at `https://<your-username>.github.io/lake-depth-map/`.

To try it locally, run `python3 -m http.server` in this folder and open <http://localhost:8000>. Opening `index.html` straight from disk won't work, because browsers block the tile downloads from `file://`.

## How the layers work

| Sheet | What gets cut out |
|---|---|
| 1 (top) | The shoreline. This sheet is the frame. |
| 2 … N | The water deeper than that sheet's depth |
| Backing | Nothing. It's a solid sheet with pin holes. |

Islands and shoals fall out as loose pieces. Glue each one onto the next sheet down, where a blue score line marks its spot.

**Depth steps** controls how the depths are split:
- **Even** uses equal depth intervals.
- **More shallow detail** suits lakes with big shallow shelves, like Erie or Green Bay.
- **Equal area** gives every sheet about the same amount of visible water.

You can also type your own depths into **Custom depths**.

## Data for other lakes

The map option also uses NOAA's [DEM Global Mosaic](https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_global_mosaic/ImageServer). It has the Great Lakes, stored as depth below each lake's chart datum, plus whatever other lakes NOAA has digitized. If your lake comes back empty, the tool says so. For those lakes, upload a depth raster instead:

- **NOAA NCEI** has bathymetric DEMs for many U.S. lakes and coasts: <https://www.ncei.noaa.gov/maps/bathymetry/>
- **Michigan inland lakes** are built in. Drop a marker on the lake in **Pick on map**. The data is MDNR / Institute for Fisheries Research *Inland Lake Contours*.
- **Other state DNRs** publish lake-depth data. Minnesota DNR, for example, has lake bathymetric DEMs.
- **USGS** has topobathymetric DEMs.
- **No raster?** Trace a printed depth chart in any image editor. Fill each depth band with a flat gray (darker = deeper, white = land), upload the image, and enter the deepest depth.

For GeoTIFF or ASCII grids, tell the tool what the values mean: depth (positive or negative), or elevation plus the lake's surface elevation. Check **lat/long** if the grid is in degrees so the lake isn't stretched east–west.

## Files

```
index.html        page layout
css/style.css     styles
js/core.js        geometry engine: lake isolation, smoothing, contours, SVG + engraving font
js/data.js        NOAA fetcher and GeoTIFF / ASCII / image readers
js/dnr.js         Michigan DNR contour loader: lake lookup, smooth floor through contours
tools/            build_michigan_roads.py (run by .github/workflows/build-michigan-roads.yml)
data/mi-roads/    Michigan road tiles (generated)
js/app.js         UI, preview, downloads
vendor/           d3-contour, d3-array, geotiff.js, JSZip, Leaflet
```

## Credits

- Depth data: NOAA NCEI Great Lakes Bathymetry, served through the NCEI DEM Global Mosaic. Michigan inland lakes: MDNR / IFR Inland Lake Contours (State of Michigan Open Data).
- Map tiles: © OpenStreetMap contributors. Roads: Natural Earth (public domain); Michigan roads: US Census Bureau TIGER/Line (public domain). Towns: GeoNames (CC BY 4.0).
- Libraries: d3-contour and d3-array (ISC), geotiff.js (MIT), JSZip (MIT/GPLv3), Leaflet (BSD-2).

These depth maps are decorative and not for navigation.
