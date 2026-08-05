/**
 * proxy_server.js  —  Tellus Elevation & OSM Proxy  (v3.5.0)
 * Node.js / Express, deploy on Railway.
 *
 * Changes in v3.5 vs v3.0 (the zip baseline):
 *
 *  WEBSHARE PROXY ROTATION:
 *    All Overpass requests now rotate through 10 Webshare outbound proxies.
 *    Override with WEBSHARE_PROXIES Railway env var (newline/comma-separated
 *    ip:port:user:pass lines). Each Overpass call leaves from a different IP,
 *    killing 429 storms even without multiple Railway deployments.
 *
 *  GEOTIFF DECODE — replaced sharp with geotiff.js:
 *    sharp chokes on LZW/DEFLATE-compressed Float32 GeoTIFFs (Kartverket,
 *    Belgium, Germany, Austria, Czech, Estonia, Latvia, Lithuania...).
 *    geotiff.js handles every valid GeoTIFF variant. Fixes Norway + others.
 *
 *  REGIONAL SOURCE FIXES:
 *    Switzerland  — coverage: hillshade visual → actual DEM layer
 *    Poland       — coverage: land cover dataset → terrain model
 *    Luxembourg   — coverage: surface model (MNS) → terrain model (MNT)
 *    Austria      — coverage: service name → ArcGIS index "1"
 *    Czech Rep.   — coverage: service name → ArcGIS index "1"
 *    Slovakia     — coverage: service name → ArcGIS index "1"
 *    Latvia       — coverage: service name → ArcGIS index "1"
 *    Australia    — coverage: full layer name → ArcGIS index "1"
 *    Arctic       — fabricated S3 WMS URL → PGC real ArcGIS WCS
 *    Antarctica   — fabricated S3 WMS URL → PGC real ArcGIS WCS
 *    New Zealand  — broken URL (empty key) → reads LINZ_API_KEY from env
 *
 *  REMOVED (required credentials or endpoint doesn't exist):
 *    Denmark  — datafordeler.dk WCS requires username+password
 *    Finland  — NLS WCS requires API key; beta URL decommissioned Feb 2023
 *    Ireland  — wcs.tailte.ie doesn't exist; no confirmed public WCS
 */

const express             = require("express");
const axios               = require("axios");
const sharp               = require("sharp");
const cors                = require("cors");
const zlib                = require("zlib");
const fs                  = require("fs");
const path                = require("path");
const GeoTIFF             = require("geotiff");
const { HttpsProxyAgent } = require("https-proxy-agent");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "4mb" }));

// ─────────────────────────────────────────────────────────────────────────────
// Webshare outbound proxy pool
// All Overpass calls rotate through these so each goes from a different IP.
// Override with WEBSHARE_PROXIES env var (newline/comma list of ip:port:user:pass).
// ─────────────────────────────────────────────────────────────────────────────
const _WEBSHARE_RAW = (process.env.WEBSHARE_PROXIES
    ? process.env.WEBSHARE_PROXIES
    : [
        "31.59.20.176:6754:ltwnsmwa:hscauz9csgas",
        "31.56.127.193:7684:ltwnsmwa:hscauz9csgas",
        "45.38.107.97:6014:ltwnsmwa:hscauz9csgas",
        "198.105.121.200:6462:ltwnsmwa:hscauz9csgas",
        "64.137.96.74:6641:ltwnsmwa:hscauz9csgas",
        "198.23.243.226:6361:ltwnsmwa:hscauz9csgas",
        "38.154.185.97:6370:ltwnsmwa:hscauz9csgas",
        "84.247.60.125:6095:ltwnsmwa:hscauz9csgas",
        "142.111.67.146:5611:ltwnsmwa:hscauz9csgas",
        "191.96.254.138:6185:ltwnsmwa:hscauz9csgas",
    ].join("\n")
).trim().split(/[\n,]+/).map(s => s.trim()).filter(Boolean);

const webshareAgents = _WEBSHARE_RAW.map(line => {
    const [ip, port, user, pass] = line.split(":");
    return new HttpsProxyAgent(`http://${user}:${pass}@${ip}:${port}`);
});

let _wsIdx = 0;
function nextWebshareAgent() {
    const agent = webshareAgents[_wsIdx % webshareAgents.length];
    _wsIdx++;
    return agent;
}

console.log(`[Tellus Proxy] ${webshareAgents.length} Webshare proxies loaded`);

// ─────────────────────────────────────────────────────────────────────────────
// Terrarium decode
// ─────────────────────────────────────────────────────────────────────────────
function terrariumToMeters(r, g, b) {
    return (r * 256 + g + b / 256) - 32768;
}

// Terrarium carries real OCEAN BATHYMETRY (signed metres below sea level).
// Fine at low zoom where it averages out, but the DEM zoom bump to 15 exposes
// per-pixel abyssal values right at the shoreline — e.g. the Taghazout coast
// tile drops to -2966 m ONE pixel from +70 m land (a continental slope that
// Terrarium's coarse bathymetry renders as a 3 km cliff at z15). Two artifacts
// followed: (1) values between ~-300 and -2000 m PASS repairTileVoids' 2000 m
// threshold and reach the engine as a literal chasm ("deep hole" at the beach);
// (2) values past -2000 m get mistaken for voids and flood-filled with the
// nearest LAND height, raising a patch of seabed into a land spire out of the
// water. This game renders oceans as surface water at sea level, so true
// abyssal depth is never experienced — only the artifacts are. Flooring
// bathymetry to a shallow, bounded sea floor keeps oceans readable as water,
// makes coastlines realistic-cliff-scale instead of chasms, AND stops the void
// repair from ever seeing ocean as corruption (so no more land spikes). The
// +9000 m cap (above Everest's 8849 m) is cheap defence against a positive
// spike too. Applied BEFORE repairTileVoids so genuine LAND corruption (still a
// huge outlier vs a land tile's median) keeps getting caught and filled.
const SEA_FLOOR_CLAMP_M = -50;   // deepest we let the ocean render (still dive-able)
const PEAK_CLAMP_M      = 9000;  // just above the highest real land on Earth
function clampBathymetry(m) {
    if (!(m > SEA_FLOOR_CLAMP_M)) return SEA_FLOOR_CLAMP_M; // also maps NaN -> floor
    if (m > PEAK_CLAMP_M) return PEAK_CLAMP_M;
    return m;
}

// Terrarium's OWN published tiles occasionally bake in corrupted/void
// regions — confirmed by decoding tile 13/4096/4096 (real-world (0,0),
// the default player spawn area) directly: the leftmost 4 of 256 columns
// hold a false ramp (-12748.6m, -8500m, -4500m, -500m) sitting right next
// to the other 252 columns, which are ALL exactly 0.0m (Terrarium likely
// has no real bathymetry there and defaults ocean to sea level; the 4
// columns are a leftover tile-stitching artifact — the same general class
// of defect this codebase's own cross-chunk seam correction already
// describes for land, just baked into the source tile itself here).
//
// A per-pixel 3x3-neighbor outlier check (ElevationService.
// repairElevationGrid's approach, same idea tried here first) FAILS on
// this: pixels deep inside a 4-column-wide corrupted band are locally
// "consistent" with their equally-corrupted neighbors, so they never look
// like enough of an outlier to fix — verified empirically: one pass fixed
// only 512/65536 px and left min at -10298m; ten passes still left
// -5959.8m. The real signal is that this tile's corrupted pixels are
// extreme relative to its own DOMINANT value, not relative to their
// immediate neighbors. Using the tile's MEDIAN as that reference (robust
// to a small corrupted minority, unlike mean) and flood-filling any pixel
// that deviates from it by more than VOID_DEVIATION_THRESHOLD_M from the
// nearest valid neighbor fixes this tile's worst columns in one pass
// (verified: min -12748.6m -> -498.0m) while leaving genuinely steep real
// terrain untouched — verified against a real Everest-area tile (median
// 7213m, real local relief spanning 3298m): zero pixels flagged, zero
// changed, because real terrain varies gradually from its own median
// rather than jumping >2000m from it at isolated points.
const VOID_DEVIATION_THRESHOLD_M = 2000;

function median(elevations) {
    const sorted = Array.from(elevations).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function repairTileVoids(elevations, width, height) {
    const n = width * height;
    const med = median(elevations);
    const isVoid = new Uint8Array(n);
    let voidCount = 0;
    for (let i = 0; i < n; i++) {
        if (Math.abs(elevations[i] - med) > VOID_DEVIATION_THRESHOLD_M) { isVoid[i] = 1; voidCount++; }
    }
    if (voidCount === 0) return elevations;
    if (voidCount === n) { elevations.fill(med); return elevations; } // whole tile is nonsense; med is the only sane fallback

    // Multi-source BFS flood fill: every void pixel inherits the value of
    // whichever valid pixel reaches it first (i.e. its nearest valid
    // neighbor by grid distance). Correctly fills a void region of any
    // size/shape in one O(width*height) pass.
    const queue = new Int32Array(n);
    let qHead = 0, qTail = 0;
    const visited = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        if (!isVoid[i]) { queue[qTail++] = i; visited[i] = 1; }
    }
    while (qHead < qTail) {
        const idx = queue[qHead++];
        const x = idx % width, y = (idx / width) | 0;
        const v = elevations[idx];
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                const nIdx = ny * width + nx;
                if (!visited[nIdx]) {
                    visited[nIdx] = 1;
                    if (isVoid[nIdx]) elevations[nIdx] = v;
                    queue[qTail++] = nIdx;
                }
            }
        }
    }
    return elevations;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tile cache (elevation PNG tiles, LRU by insertion order)
// ─────────────────────────────────────────────────────────────────────────────
const tileCache      = new Map();
const TILE_CACHE_MAX = 200;

function tileCacheSet(key, value) {
    if (tileCache.size >= TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
    tileCache.set(key, value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Overpass bbox response cache
// ─────────────────────────────────────────────────────────────────────────────
const osmCache      = new Map();
const OSM_CACHE_MAX = 500;
const CELL_DEG      = 0.1;

function osmCacheSet(key, value) {
    if (osmCache.size >= OSM_CACHE_MAX) osmCache.delete(osmCache.keys().next().value);
    osmCache.set(key, value);
}

function snapBbox(minLat, minLon, maxLat, maxLon) {
    return {
        sLat: Math.floor(minLat / CELL_DEG) * CELL_DEG,
        sLon: Math.floor(minLon / CELL_DEG) * CELL_DEG,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cell-based Overpass fetch for /water, /buildings, /roads.
//
// BUG THIS FIXES: the old per-handler code cached by snapBbox(minLat,minLon)
// — the CALLER's own bbox south-west corner floored to the cell grid. /water
// happened to be safe because its Roblox-side caller (WaterMaskService.lua)
// already pre-snaps its own bbox to this exact grid before sending. /roads
// and /buildings callers (OsmService.lua, BuildingService.lua) do NOT —
// they send an arbitrary ~400m-radius bbox centered on the exact teleport
// point. Two different (but nearby) teleport locations whose small bboxes
// happened to floor onto the SAME cell corner used to silently share one
// cached response, serving the FIRST location's roads/buildings to the
// SECOND real-world location.
//
// FIX: snap+widen to the FULL cell(s) the requested bbox actually touches
// (usually one, occasionally more if straddling a cell boundary), fetch/
// cache each cell independently by its own canonical corner, and merge
// (de-duplicating elements by type+id, since a way spanning two cells can
// come back from both). This is correct regardless of whether a caller
// pre-snaps its own bbox — /water keeps working identically (its caller's
// bbox already IS exactly one cell, so cellsTouched always returns exactly
// that one cell) while /roads and /buildings become safe too.
// ─────────────────────────────────────────────────────────────────────────────
function cellsTouched(minLat, minLon, maxLat, maxLon) {
    const cells = [];
    const latStart = Math.floor(minLat / CELL_DEG);
    const latEnd   = Math.floor(maxLat / CELL_DEG);
    const lonStart = Math.floor(minLon / CELL_DEG);
    const lonEnd   = Math.floor(maxLon / CELL_DEG);
    for (let cy = latStart; cy <= latEnd; cy++) {
        for (let cx = lonStart; cx <= lonEnd; cx++) {
            cells.push({ sLat: cy * CELL_DEG, sLon: cx * CELL_DEG });
        }
    }
    return cells;
}

async function fetchCellsMerged(minLat, minLon, maxLat, maxLon, cachePrefix, queryForCell) {
    const cells = cellsTouched(minLat, minLon, maxLat, maxLon);
    const seen   = new Set();
    const merged = [];

    await Promise.all(cells.map(async ({ sLat, sLon }) => {
        const cacheKey = `${cachePrefix}|${sLat.toFixed(2)},${sLon.toFixed(2)}`;
        let result = osmCache.get(cacheKey);
        if (!result) {
            const cQuery = queryForCell(sLat, sLon, sLat + CELL_DEG, sLon + CELL_DEG);
            const data = await postOverpass(cQuery);
            result = { elements: data.elements || [] };
            osmCacheSet(cacheKey, result);
        }
        for (const el of result.elements) {
            const dedupeKey = `${el.type}/${el.id}`;
            if (!seen.has(dedupeKey)) {
                seen.add(dedupeKey);
                merged.push(el);
            }
        }
    }));

    return { elements: merged };
}

// ─────────────────────────────────────────────────────────────────────────────
// Overpass request queue  — Webshare agent rotated per call/retry
// ─────────────────────────────────────────────────────────────────────────────
const MIN_OVERPASS_GAP_MS  = 1100;
const OVERPASS_TIMEOUT_MS  = 28000;
const OVERPASS_MAX_RETRIES = 3;
const OVERPASS_RETRY_DELAY = 5000;

const OVERPASS_URL = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";

const overpassQueue = [];
let   overpassBusy  = false;
let   lastOverpassAt = 0;

async function _runNextOverpass() {
    if (overpassBusy || overpassQueue.length === 0) return;
    overpassBusy = true;
    const { query, resolve, reject } = overpassQueue.shift();

    const gap = Date.now() - lastOverpassAt;
    if (gap < MIN_OVERPASS_GAP_MS) await new Promise(r => setTimeout(r, MIN_OVERPASS_GAP_MS - gap));

    let lastErr;
    for (let attempt = 1; attempt <= OVERPASS_MAX_RETRIES; attempt++) {
        const httpsAgent = nextWebshareAgent();
        try {
            const response = await axios.post(
                OVERPASS_URL,
                "data=" + encodeURIComponent(query),
                {
                    httpsAgent,
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                        "User-Agent":   "Tellus-Roblox-Proxy/3.5",
                    },
                    timeout: OVERPASS_TIMEOUT_MS,
                }
            );
            lastOverpassAt = Date.now();
            overpassBusy = false;
            setImmediate(_runNextOverpass);
            resolve(response.data);
            return;
        } catch (err) {
            lastErr = err;
            const status = err.response?.status;
            // Only sleep if there's another attempt coming — previously this
            // branch always slept (up to 60s for a 429), even on the LAST
            // attempt right before giving up, needlessly blocking every other
            // request queued behind this one (overpassBusy stays true for
            // the whole retry loop).
            if ((status === 429 || status === 504) && attempt < OVERPASS_MAX_RETRIES) {
                const wait = status === 429 ? 60000 : OVERPASS_RETRY_DELAY;
                console.warn(`[Overpass] ${status} attempt ${attempt} via proxy ${(_wsIdx-1) % webshareAgents.length}, waiting ${wait}ms`);
                await new Promise(r => setTimeout(r, wait));
            } else if (status !== 429 && status !== 504 && attempt < OVERPASS_MAX_RETRIES) {
                await new Promise(r => setTimeout(r, OVERPASS_RETRY_DELAY));
            }
        }
    }

    lastOverpassAt = Date.now();
    overpassBusy = false;
    setImmediate(_runNextOverpass);
    reject(lastErr);
}

function postOverpass(query) {
    return new Promise((resolve, reject) => {
        overpassQueue.push({ query, resolve, reject });
        _runNextOverpass();
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse bbox from request body
// ─────────────────────────────────────────────────────────────────────────────
// Real callers (roads/water/buildings radius, default 400-440m) only ever
// need boxes on the order of 0.01deg^2. 1 deg^2 (~111km x 111km at the
// equator) is generous headroom while still rejecting planet-scale/inverted
// boxes that would otherwise turn into a huge, expensive Overpass query
// hitting the shared overpass-api.de endpoint (and Webshare IPs) for
// everyone using this proxy instance.
const MAX_BBOX_AREA_DEG2 = 1.0;

function parseBbox(body) {
    const { minLat, minLon, maxLat, maxLon } = body;
    if (minLat == null || minLon == null || maxLat == null || maxLon == null)
        return { error: "Missing bounding box (minLat, minLon, maxLat, maxLon)" };
    const s = parseFloat(minLat), w = parseFloat(minLon);
    const n = parseFloat(maxLat), e = parseFloat(maxLon);
    if ([s, w, n, e].some(isNaN)) return { error: "Bounding box values must be numbers" };
    if (s < -90 || s > 90 || n < -90 || n > 90) return { error: "Latitude out of range (-90..90)" };
    if (w < -180 || w > 180 || e < -180 || e > 180) return { error: "Longitude out of range (-180..180)" };
    if (s >= n) return { error: "minLat must be less than maxLat" };
    if (w >= e) return { error: "minLon must be less than maxLon" };
    if ((n - s) * (e - w) > MAX_BBOX_AREA_DEG2) return { error: "Bounding box too large" };
    return { minLat: s, minLon: w, maxLat: n, maxLon: e };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapterhorn elevation (v13) — the curated global DEM the Minecraft mod uses.
// Same Terrarium encoding, but WebP, 512 px tiles, and MUCH cleaner data: it has
// none of Terrarium's coastal artifacts (verified: the Guanabara Bay/Rio +20 m
// phantom that terraced the whole coast reads a correct 0 m here). It is
// land-only (deep ocean returns 0 m / no bathymetry), which is fine — that noisy
// bathymetry was the source of every chasm; a synthesized ocean floor replaces
// it. Max zoom is coverage-dependent (~12–14); z12 (512 px) is globally present,
// so we source from z12 and resample into the z/x/y/256 grid the rest of the
// proxy already expects. Anywhere Mapterhorn 404s, fetchTile falls back to
// Terrarium wholesale — so this can never render worse than before.
// ─────────────────────────────────────────────────────────────────────────────
const MAPTERHORN_ENDPOINT = "https://tiles.mapterhorn.com";
const MAPTERHORN_ZOOM     = 12;   // universal coverage zoom (512 px tiles)
const mhTileCache         = new Map();
const MH_TILE_CACHE_MAX   = 128;

async function fetchMapterhornTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (mhTileCache.has(key)) return mhTileCache.get(key);
    let out = null;
    try {
        const resp = await axios.get(`${MAPTERHORN_ENDPOINT}/${z}/${x}/${y}.webp`, {
            responseType: "arraybuffer", timeout: 10000,
            headers: { "User-Agent": "Tellus-Roblox-Proxy/4 (+mapterhorn)" },
        });
        const { data, info } = await sharp(Buffer.from(resp.data))
            .ensureAlpha(0).raw().toBuffer({ resolveWithObject: true });
        const { width, height, channels } = info;
        const elev = new Float32Array(width * height);
        for (let i = 0; i < width * height; i++) {
            const o = i * channels;
            elev[i] = clampBathymetry(terrariumToMeters(data[o], data[o + 1], data[o + 2]));
        }
        out = { width, height, elevations: elev };
    } catch (err) {
        out = null; // 404 (no coverage) or decode issue → caller uses Terrarium
    }
    if (mhTileCache.size >= MH_TILE_CACHE_MAX) mhTileCache.delete(mhTileCache.keys().next().value);
    mhTileCache.set(key, out);
    return out;
}

// Build the 256×256 elevation grid for tile z/x/y from Mapterhorn's 512 px
// z≤12 tiles. Returns null unless Mapterhorn covers the WHOLE tile (so we never
// stitch a half-Mapterhorn/half-Terrarium seam). Web-Mercator is linear, so the
// output→Mapterhorn pixel map is a single scale factor — no per-pixel trig.
async function buildTileFromMapterhorn(z, x, y) {
    const MZ = Math.min(z, MAPTERHORN_ZOOM);
    const OUT = 256;
    const scale = (Math.pow(2, MZ) * 512) / (Math.pow(2, z) * OUT); // MH px per output px
    const baseX = x * OUT, baseY = y * OUT;

    // A z15 tile is 1/8 of a z12 tile, so it touches at most a 2×2 block of them.
    const need = new Map();
    for (const [c, r] of [[0, 0], [OUT - 1, 0], [0, OUT - 1], [OUT - 1, OUT - 1]]) {
        const tx = Math.floor(((baseX + c) * scale) / 512);
        const ty = Math.floor(((baseY + r) * scale) / 512);
        need.set(`${tx}/${ty}`, { tx, ty, tile: null });
    }
    await Promise.all([...need.values()].map(async (e) => { e.tile = await fetchMapterhornTile(MZ, e.tx, e.ty); }));
    for (const e of need.values()) if (!e.tile) return null; // any gap → Terrarium

    // Sample one Mapterhorn source pixel by GLOBAL pixel index, resolving which
    // 512px tile it lives in (a z15 output tile can straddle 2×2 MH tiles, all
    // in `need`). Returns null only if that tile wasn't fetched (defensive).
    const sampleMH = (gx, gy) => {
        const tx = Math.floor(gx / 512), ty = Math.floor(gy / 512);
        const e = need.get(`${tx}/${ty}`);
        if (!e || !e.tile) return null;
        const t = e.tile;
        const px = Math.min(t.width - 1, Math.max(0, gx - tx * 512));
        const py = Math.min(t.height - 1, Math.max(0, gy - ty * 512));
        return t.elevations[py * t.width + px];
    };

    // BILINEAR resample (was nearest-neighbor). At z15, scale≈0.25 means 64 real
    // MH samples upsample to 256 output px: nearest duplicated each into a 4×4
    // block → flat plateaus + hard risers (the terrace bug). Bilinear ramps
    // smoothly between the 4 surrounding samples so every output cell varies
    // continuously — no plateaus for the voxel staircase to bite on.
    const elevations = new Float32Array(OUT * OUT);
    for (let row = 0; row < OUT; row++) {
        const mgy = (baseY + row) * scale;
        const y0 = Math.floor(mgy), fy = mgy - y0;
        for (let col = 0; col < OUT; col++) {
            const mgx = (baseX + col) * scale;
            const x0 = Math.floor(mgx), fx = mgx - x0;
            const v00 = sampleMH(x0, y0);
            if (v00 === null) return null; // center sample missing → whole-tile Terrarium
            const v10 = sampleMH(x0 + 1, y0) ?? v00;
            const v01 = sampleMH(x0, y0 + 1) ?? v00;
            const v11 = sampleMH(x0 + 1, y0 + 1) ?? v10;
            const top = v00 + (v10 - v00) * fx;
            const bot = v01 + (v11 - v01) * fx;
            elevations[row * OUT + col] = top + (bot - top) * fy;
        }
    }
    return { width: OUT, height: OUT, elevations };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch + decode an elevation tile (cached). Mapterhorn first, Terrarium fallback.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (tileCache.has(key)) return tileCache.get(key);

    // Prefer Mapterhorn (clean, artifact-free). Whole-tile fallback to Terrarium
    // where it has no coverage keeps sources from ever mixing within one tile.
    try {
        const mh = await buildTileFromMapterhorn(z, x, y);
        if (mh) { tileCacheSet(key, mh); return mh; }
    } catch (err) {
        console.warn("[elevation] Mapterhorn build failed, using Terrarium:", err.message);
    }

    const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
    const response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 10000,
        headers: { "User-Agent": "Tellus-Roblox-Proxy/3.5" },
    });

    const { data, info } = await sharp(Buffer.from(response.data))
        .ensureAlpha(0).raw().toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    const elevations = new Float32Array(width * height);
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const idx = (row * width + col) * channels;
            elevations[row * width + col] = clampBathymetry(terrariumToMeters(data[idx], data[idx+1], data[idx+2]));
        }
    }
    repairTileVoids(elevations, width, height);

    const result = { width, height, elevations };
    tileCacheSet(key, result);
    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bilinear interpolation
// ─────────────────────────────────────────────────────────────────────────────
function sampleBilinear(tile, px, py) {
    const { width, height, elevations } = tile;
    const x0 = Math.floor(px), y0 = Math.floor(py);
    const x1 = Math.min(x0+1, width-1), y1 = Math.min(y0+1, height-1);
    const tx = px-x0, ty = py-y0;
    const h00 = elevations[y0*width+x0]||0, h10 = elevations[y0*width+x1]||0;
    const h01 = elevations[y1*width+x0]||0, h11 = elevations[y1*width+x1]||0;
    return (h00+(h10-h00)*tx)+((h01+(h11-h01)*tx)-(h00+(h10-h00)*tx))*ty;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /tile?z=&x=&y=
// ─────────────────────────────────────────────────────────────────────────────
app.get("/tile", async (req, res) => {
    const z = parseInt(req.query.z), x = parseInt(req.query.x), y = parseInt(req.query.y);
    if (isNaN(z)||isNaN(x)||isNaN(y)) return res.status(400).json({ error: "Missing z, x, y" });
    if (z<0||z>15) return res.status(400).json({ error: "Zoom out of range 0-15" });
    try {
        const tile = await fetchTile(z, x, y);
        res.json({ z, x, y, width: tile.width, height: tile.height,
            elevations: Array.from(tile.elevations).map(v => Math.round(v*10)/10) });
    } catch (err) {
        console.error(`[Proxy] /tile ${z}/${x}/${y} failed:`, err.message);
        res.status(500).json({ error: "Tile fetch failed", detail: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /elevation  —  batch pixel samples (global Terrarium)
// ─────────────────────────────────────────────────────────────────────────────
app.post("/elevation", async (req, res) => {
    try {
        const { tiles } = req.body;
        if (!Array.isArray(tiles)) return res.status(400).json({ error: "Body must have 'tiles' array" });

        // Tiles are fetched in PARALLEL (was a sequential for-await loop) —
        // Promise.all preserves array order, so the flattened result stays
        // in the same tile-by-tile, pixel-by-pixel order the Roblox side
        // expects, but one slow/dead tile no longer stalls the whole batch.
        const perTile = await Promise.all(tiles.map(async (tileReq) => {
            const { z, x, y, pixels } = tileReq || {};
            const pxList = Array.isArray(pixels) ? pixels : [];
            if (typeof z!=="number"||typeof x!=="number"||typeof y!=="number") {
                return pxList.map(() => 0);
            }
            let tile;
            try { tile = await fetchTile(z, x, y); }
            catch (err) {
                console.error(`[Proxy] /elevation tile ${z}/${x}/${y} failed:`, err.message);
                return pxList.map(() => 0);
            }
            return pxList.map((entry) => {
                // A malformed entry (not a [x,y] pair) used to throw here,
                // uncaught, which could crash the whole process — see the
                // try/catch wrapping this whole handler.
                if (!Array.isArray(entry) || typeof entry[0] !== "number" || typeof entry[1] !== "number") {
                    return 0;
                }
                const [px, py] = entry;
                const cpx = Math.max(0,Math.min(tile.width-1,px));
                const cpy = Math.max(0,Math.min(tile.height-1,py));
                return Math.round(sampleBilinear(tile,cpx,cpy)*10)/10;
            });
        }));

        res.json({ elevations: perTile.flat() });
    } catch (err) {
        console.error("[Proxy] /elevation failed:", err.message);
        res.status(500).json({ error: "Elevation batch failed", detail: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /water
// ─────────────────────────────────────────────────────────────────────────────
app.post("/water", async (req, res) => {
    const bbox = parseBbox(req.body);
    if (bbox.error) return res.status(400).json({ error: bbox.error });
    const { minLat, minLon, maxLat, maxLon } = bbox;
    try {
        // Water POLYGONS (natural=water / riverbank / beach) PLUS the
        // natural=coastline VECTOR. WaterMaskService needs the coastline ways to
        // draw the ocean edge from the real shoreline instead of thresholding
        // coarse elevation at sea level — the latter produces the blocky,
        // chunk-quantised "vertical-stripe coastline" the [GridDbg] maps showed
        // at flat coasts (Agadir). Coastlines are open linestrings, evaluated by
        // coastlineSide() (a directed side-of-way test), never point-in-polygon.
        // `>;out skel qt;` already pulls every referenced node, so coastline
        // geometry resolves the same as the polygon ways. Cache prefix bumped to
        // "water2" so pre-coastline cached responses are re-fetched.
        const result = await fetchCellsMerged(minLat, minLon, maxLat, maxLon, "water2",
            (a, b, c, d) => `[out:json][timeout:25];(way["natural"="water"](${a},${b},${c},${d});way["waterway"="riverbank"](${a},${b},${c},${d});way["natural"="beach"](${a},${b},${c},${d});way["natural"="coastline"](${a},${b},${c},${d}););out body;>;out skel qt;`);
        res.json(result);
    } catch (err) {
        console.error("[Proxy] /water Overpass failed:", err.message);
        res.status(err.response?.status||500).json({ error: "Overpass fetch failed", detail: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /buildings
// ─────────────────────────────────────────────────────────────────────────────
app.post("/buildings", async (req, res) => {
    const bbox = parseBbox(req.body);
    if (bbox.error) return res.status(400).json({ error: bbox.error });
    const { minLat, minLon, maxLat, maxLon } = bbox;
    try {
        const result = await fetchCellsMerged(minLat, minLon, maxLat, maxLon, "buildings",
            (a, b, c, d) => `[out:json][timeout:25];(way["building"](${a},${b},${c},${d}););out body;>;out skel qt;`);
        res.json(result);
    } catch (err) {
        console.error("[Proxy] /buildings Overpass failed:", err.message);
        res.status(err.response?.status||500).json({ error: "Overpass fetch failed", detail: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /osm
// ─────────────────────────────────────────────────────────────────────────────
app.post("/osm", async (req, res) => {
    const bbox = parseBbox(req.body);
    if (bbox.error) return res.status(400).json({ error: bbox.error });
    const { minLat, minLon, maxLat, maxLon } = bbox;
    const { sLat, sLon } = snapBbox(minLat, minLon, maxLat, maxLon);
    const cacheKey = `osm|${sLat.toFixed(2)},${sLon.toFixed(2)}`;
    if (osmCache.has(cacheKey)) return res.json(osmCache.get(cacheKey));

    const query = `[out:json][timeout:25];(way["building"](${minLat},${minLon},${maxLat},${maxLon});way["highway"](${minLat},${minLon},${maxLat},${maxLon}););out geom;`;
    try {
        const data = await postOverpass(query);
        const buildings=[], roads=[];
        for (const el of (data.elements||[])) {
            if (el.type==="way"&&el.geometry) {
                const nodes = el.geometry.map(g=>({lat:g.lat,lon:g.lon}));
                if (el.tags?.building) buildings.push({nodes,tags:el.tags,name:el.tags.name||"Building"});
                else if (el.tags?.highway) roads.push({nodes,tags:el.tags,type:el.tags.highway});
            }
        }
        const result = { buildings, ways: roads };
        osmCacheSet(cacheKey, result);
        res.json(result);
    } catch (err) {
        console.error("[Proxy] /osm Overpass failed:", err.message);
        res.status(err.response?.status||500).json({ error: "Failed to fetch OSM data", detail: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /roads
// ─────────────────────────────────────────────────────────────────────────────
const ROAD_FILTER = "motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|service";

app.post("/roads", async (req, res) => {
    const bbox = parseBbox(req.body);
    if (bbox.error) return res.status(400).json({ error: bbox.error });
    const { minLat, minLon, maxLat, maxLon } = bbox;
    try {
        // Cache the raw per-cell Overpass elements (nodes+ways, pre-resolution)
        // under their own prefix, then resolve ways->nodes once over the
        // merged set — a way whose nodes fall in different cells still
        // resolves fully as long as every cell it touches was fetched.
        const merged = await fetchCellsMerged(minLat, minLon, maxLat, maxLon, "roads-raw",
            (a, b, c, d) => `[out:json][timeout:25];(way["highway"~"^(${ROAD_FILTER})$"](${a},${b},${c},${d}););out body;>;out skel qt;`);
        const nodes={};
        for (const el of merged.elements) { if (el.type==="node") nodes[el.id]={lat:el.lat,lon:el.lon}; }
        const ways=[];
        for (const el of merged.elements) {
            if (el.type==="way"&&el.nodes) {
                const resolved=el.nodes.map(id=>nodes[id]).filter(Boolean);
                if (resolved.length>=2) ways.push({id:el.id,tags:el.tags||{},nodes:resolved});
            }
        }
        res.json({ ways });
    } catch (err) {
        console.error("[Proxy] /roads Overpass failed:", err.message);
        res.status(err.response?.status||500).json({ error: "Failed to fetch road data", detail: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /geocode
// ─────────────────────────────────────────────────────────────────────────────
app.get("/geocode", async (req, res) => {
    const q=req.query.q;
    if (!q) return res.status(400).json({ error: "Missing query 'q'" });
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 5;
    limit = Math.min(limit, 20);
    try {
        const url=`https://nominatim.openstreetmap.org/search?format=json&limit=${encodeURIComponent(limit)}&q=${encodeURIComponent(q)}`;
        const response=await axios.get(url,{headers:{"User-Agent":"Tellus-Roblox-Proxy/3.5"}});
        res.json(response.data);
    } catch(err) {
        console.error("[Proxy] /geocode failed:",err.message);
        res.status(500).json({error:"Geocode fetch failed"});
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /reverse?lat=&lon=  — reverse geocode (used by PassportService for
// country-of-current-location, and the landing title card)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/reverse", async (req, res) => {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        return res.status(400).json({ error: "lat/lon must be numbers in valid range" });
    }
    try {
        // zoom=3 is Nominatim's "country" level of detail — this endpoint's
        // only real consumer wants a country name, not a street address, so
        // asking for less detail also means a smaller/faster response.
        const url=`https://nominatim.openstreetmap.org/reverse?format=json&zoom=3&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
        const response=await axios.get(url,{headers:{"User-Agent":"Tellus-Roblox-Proxy/3.5"}});
        const data = response.data || {};
        const country = data.address && data.address.country;
        res.json({ country: country || null, displayName: data.display_name || null });
    } catch(err) {
        console.error("[Proxy] /reverse failed:",err.message);
        res.status(500).json({error:"Reverse geocode fetch failed"});
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Köppen–Geiger climate raster
// ─────────────────────────────────────────────────────────────────────────────
const KOPPEN_CODES = [
    null,"Af","Am","Aw","BWh","BWk","BSh","BSk","Csa","Csb","Csc",
    "Cwa","Cwb","Cwc","Cfa","Cfb","Cfc","Dsa","Dsb","Dsc","Dsd",
    "Dwa","Dwb","Dwc","Dwd","Dfa","Dfb","Dfc","Dfd","ET","EF",
];
let koppen=null;

function loadKoppen() {
    try {
        const raw=zlib.gunzipSync(fs.readFileSync(path.join(__dirname,"koppen_packed.bin.gz")));
        if (raw.toString("latin1",0,4)!=="KPKG") throw new Error("bad magic");
        const width=raw.readUInt32LE(6), height=raw.readUInt32LE(10);
        const originLon=raw.readDoubleLE(14), originLat=raw.readDoubleLE(22), deg=raw.readDoubleLE(30);
        koppen={grid:raw.subarray(46,46+width*height),width,height,originLon,originLat,deg};
        console.log(`[Tellus Proxy] Köppen raster loaded: ${width}x${height} @ ${deg.toFixed(4)}deg/px`);
    } catch(err) {
        console.warn("[Tellus Proxy] Köppen raster unavailable:",err.message);
        koppen=null;
    }
}
loadKoppen();

// Normalizes any longitude to (-180, 180]. koppenNearest walks a ring of
// samples out from the query point (lon+dx*d for dx up to ±maxRing) — near
// the antimeridian that ring crosses ±180 and used to land far outside the
// raster's px range (0..width), returning null for every ring cell even
// though the wrapped-around longitude has real data. This silently produced
// "NONE" climate/biome classification for a band of columns straddling
// 180°/-180° longitude (e.g. Fiji, eastern Siberia, the Aleutians).
function wrapLon(lon) {
    let w = lon % 360;
    if (w > 180) w -= 360;
    else if (w <= -180) w += 360;
    return w;
}

function koppenAt(lat,lon) {
    if (!koppen) return null;
    lon = wrapLon(lon);
    const px=Math.floor((lon-koppen.originLon)/koppen.deg);
    const py=Math.floor((koppen.originLat-lat)/koppen.deg);
    if (px<0||py<0||px>=koppen.width||py>=koppen.height) return null;
    const v=koppen.grid[py*koppen.width+px];
    return (v>0&&v<KOPPEN_CODES.length)?KOPPEN_CODES[v]:null;
}

function koppenNearest(lat,lon,maxRing) {
    const direct=koppenAt(lat,lon);
    if (direct) return direct;
    if (!koppen) return null;
    const d=koppen.deg;
    for (let ring=1;ring<=(maxRing||3);ring++) {
        for (let dy=-ring;dy<=ring;dy++) {
            for (let dx=-ring;dx<=ring;dx++) {
                if (Math.max(Math.abs(dx),Math.abs(dy))!==ring) continue;
                const c=koppenAt(lat+dy*d,lon+dx*d);
                if (c) return c;
            }
        }
    }
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /landcover
//
// REAL per-pixel land cover from Esri's Sentinel-2 10 m Land Use/Land Cover
// (Impact Observatory io-lulc, a 2017-2025 yearly time series). This route used
// to hardcode esa:0 for every point — so the engine had NO per-pixel cover and
// fell back to a climate-only guess, which over-greened deserts (Taghazout read
// as "savanna", the Sahara as wooded). We now sample the ImageServer's
// getSamples op — the only op on this service that returns a class value per
// lat/lon (identify + a `where`/`time` filter both reject the [Year] time field;
// getSamples with a mosaicRule locked to one raster is what works). The io-lulc
// classes are remapped to the ESA WorldCover codes BiomeClassification already
// keys on, so nothing downstream changes. Köppen is still returned alongside —
// the engine uses it whenever esa is 0 (clouds / nodata / ocean / fetch failure).
// ─────────────────────────────────────────────────────────────────────────────
const LULC_URL = "https://ic.imagery1.arcgis.com/arcgis/rest/services/Sentinel2_10m_LandCover/ImageServer/getSamples";
// OBJECTID of the raster to sample. On this service OID 7 == year 2023, a
// complete global layer. (OID 9/2025 is incomplete → "Unable to complete
// operation"; a `where Year=` filter is rejected by the service, so we lock by
// raster id.) Override with LULC_RASTER_ID if Esri re-indexes the time series.
const LULC_RASTER_ID   = Number(process.env.LULC_RASTER_ID || 7);
const LULC_MOSAIC_RULE = JSON.stringify({ mosaicMethod: "esriMosaicLockRaster", lockRasterIds: [LULC_RASTER_ID] });
const LULC_BATCH       = 100;   // points per getSamples call; batches run in parallel

// Impact Observatory io-lulc class -> ESA WorldCover code the engine understands.
//   io : 1 Water 2 Trees 4 FloodedVeg 5 Crops 7 Built 8 Bare 9 Snow/Ice 10 Clouds 11 Rangeland
//   esa: 10 tree 20 shrub 30 grass 40 crop 50 built 60 bare 70 snow 80 water 90 wetland 95 mangrove 100 moss
// Clouds (10) -> 0 so the engine falls through to köppen. Water (80) matches the
// engine's own documented water convention (see ElevationService.getLandCover).
const IO_TO_ESA = { 1: 80, 2: 10, 4: 90, 5: 40, 7: 50, 8: 60, 9: 70, 10: 0, 11: 30 };

// LULC is static per year — cache hard by ~11 m (4-decimal) lat/lon key.
const landcoverCache     = new Map();
const LANDCOVER_CACHE_MAX = 20000;
function lcKey(lat, lon) { return lat.toFixed(4) + "," + lon.toFixed(4); }
function lcCacheSet(key, val) {
    if (landcoverCache.size >= LANDCOVER_CACHE_MAX) landcoverCache.delete(landcoverCache.keys().next().value);
    landcoverCache.set(key, val);
}

// Sample Esri LULC for a batch of {lat,lon}. Returns Map<batchIndex, esaCode> on
// success (absent indices = ocean/nodata, which the caller records as esa 0), or
// null on ANY failure so the caller degrades to köppen-only without poisoning
// the cache with a bogus 0.
async function fetchEsriLulc(points) {
    if (points.length === 0) return new Map();
    const geometry = JSON.stringify({
        points: points.map(p => [p.lon, p.lat]),   // Esri wants [x=lon, y=lat]
        spatialReference: { wkid: 4326 },
    });
    const body = new URLSearchParams({
        geometry,
        geometryType: "esriGeometryMultipoint",
        mosaicRule: LULC_MOSAIC_RULE,
        returnFirstValueOnly: "false",
        f: "json",
    });
    try {
        const resp = await axios.post(LULC_URL, body.toString(), {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            timeout: 12000,
        });
        const samples = resp.data && resp.data.samples;
        if (!Array.isArray(samples)) return null;   // Esri error object, not a result set
        const out = new Map();
        for (const s of samples) {
            const id = Number(s.locationId);
            const io = parseInt(s.value, 10);
            if (!isFinite(id) || !isFinite(io)) continue;
            const esa = IO_TO_ESA[io];
            if (esa !== undefined) out.set(id, esa);
        }
        return out;
    } catch (err) {
        console.warn("[landcover] Esri getSamples failed:", err.message);
        return null;
    }
}

app.post("/landcover", async (req, res) => {
    const points = (req.body && req.body.points) || [];
    if (!Array.isArray(points) || points.length === 0) return res.json({ classes: [] });

    // 1. köppen for every point (fast, local) + seed esa from the cache.
    const classes = points.map(p => {
        const lat = Number(p.lat), lon = Number(p.lon);
        if (!isFinite(lat) || !isFinite(lon)) return { esa: 0, koppen: "NONE", _skip: true };
        const koppen = koppenNearest(lat, lon, 3) || "NONE";
        const cached = landcoverCache.get(lcKey(lat, lon));
        return {
            esa: cached !== undefined ? cached : 0,
            koppen, _lat: lat, _lon: lon, _cached: cached !== undefined,
        };
    });

    // 2. Fetch real esa for the uncached, valid points — batched and parallel.
    const need = [];
    for (let i = 0; i < classes.length; i++) {
        if (!classes[i]._skip && !classes[i]._cached) need.push(i);
    }
    if (need.length > 0) {
        const batches = [];
        for (let b = 0; b < need.length; b += LULC_BATCH) {
            const idxs = need.slice(b, b + LULC_BATCH);
            const pts  = idxs.map(i => ({ lat: classes[i]._lat, lon: classes[i]._lon }));
            batches.push({ idxs, promise: fetchEsriLulc(pts) });
        }
        const results = await Promise.all(batches.map(b => b.promise));
        for (let bi = 0; bi < batches.length; bi++) {
            const got = results[bi];
            if (got === null) continue;   // errored batch → köppen-only, don't cache
            const idxs = batches[bi].idxs;
            for (let j = 0; j < idxs.length; j++) {
                const gi  = idxs[j];
                const esa = got.has(j) ? got.get(j) : 0;   // absent = ocean/nodata
                classes[gi].esa = esa;
                lcCacheSet(lcKey(classes[gi]._lat, classes[gi]._lon), esa);
            }
        }
    }

    res.json({ classes: classes.map(c => ({ esa: c.esa, koppen: c.koppen })) });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regional DEM infrastructure
// ─────────────────────────────────────────────────────────────────────────────
const regionalTileCache       = new Map();
const REGIONAL_TILE_CACHE_MAX = 600;

function regionalTileCacheSet(key,value) {
    if (regionalTileCache.size>=REGIONAL_TILE_CACHE_MAX) regionalTileCache.delete(regionalTileCache.keys().next().value);
    regionalTileCache.set(key,value);
}

function tileToBbox(z,x,y) {
    const n=Math.pow(2,z);
    return {
        west:  x/n*360-180,
        east:  (x+1)/n*360-180,
        north: Math.atan(Math.sinh(Math.PI*(1-2*y/n)))*180/Math.PI,
        south: Math.atan(Math.sinh(Math.PI*(1-2*(y+1)/n)))*180/Math.PI,
    };
}

// geotiff.js decode — handles ALL GeoTIFF variants (LZW, DEFLATE, Float32, Int16...)
// sharp previously used here choked on anything Kartverket/Belgium/Germany return.
async function decodeGeoTiff(buffer) {
    try {
        const ab=buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength);
        const tiff=await GeoTIFF.fromArrayBuffer(ab);
        const image=await tiff.getImage();
        const [raw]=await image.readRasters({interleave:false});
        const width=image.getWidth(), height=image.getHeight();
        const elevations=new Float32Array(width*height);
        for (let i=0;i<width*height;i++) {
            const v=raw[i];
            elevations[i]=(isFinite(v)&&v>-9000&&v<9000)?v:0;
        }
        return {width,height,elevations};
    } catch(err) { throw new Error("GeoTIFF decode failed: "+err.message); }
}

async function fetchWcsTile(wcsUrl,coverageName,bbox,resx,resy,crs="EPSG:4326") {
    const {west,east,north,south}=bbox;
    const width=Math.min(256,Math.ceil((east-west)/resx));
    const height=Math.min(256,Math.ceil((north-south)/resy));
    if (width<1||height<1) throw new Error("Tile bbox too small");
    const url=`${wcsUrl}?SERVICE=WCS&VERSION=1.0.0&REQUEST=GetCoverage&COVERAGE=${coverageName}&CRS=${crs}&BBOX=${west},${south},${east},${north}&WIDTH=${width}&HEIGHT=${height}&FORMAT=GeoTIFF`;
    const response=await axios.get(url,{responseType:"arraybuffer",timeout:15000,headers:{"User-Agent":"Tellus-Roblox-Proxy/3.5"}});
    const decoded=await decodeGeoTiff(Buffer.from(response.data));
    // Tag with the bbox this data ACTUALLY covers (== the requested bbox,
    // since the WCS request itself was for exactly this bbox) so
    // handleRegionalElevation can resample against real coverage instead of
    // assuming it matches the caller's tile grid. See fetchJapan for why
    // that assumption is NOT always true.
    decoded.bbox=bbox;
    return decoded;
}

function resampleToPixels(tile,pixels,srcBbox,tileZ,tileX,tileY) {
    const results=[], n=Math.pow(2,tileZ);
    for (const entry of pixels) {
        // See /elevation's handler — a malformed entry used to throw here
        // uncaught instead of degrading to 0.
        if (!Array.isArray(entry) || typeof entry[0] !== "number" || typeof entry[1] !== "number") {
            results.push(0);
            continue;
        }
        const [px,py] = entry;
        const lon=(tileX+px/256)/n*360-180;
        const lat=Math.atan(Math.sinh(Math.PI*(1-2*(tileY+py/256)/n)))*180/Math.PI;
        const fx=(lon-srcBbox.west)/(srcBbox.east-srcBbox.west)*(tile.width-1);
        const fy=(srcBbox.north-lat)/(srcBbox.north-srcBbox.south)*(tile.height-1);
        results.push(Math.round(sampleBilinear(tile,Math.max(0,fx),Math.max(0,fy))*10)/10);
    }
    return results;
}

async function handleRegionalElevation(req,res,fetchFn) {
    try {
        const {tiles}=req.body;
        if (!Array.isArray(tiles)) return res.status(400).json({error:"Body must have 'tiles' array"});

        // Parallel per-tile fetch — see /elevation for why (order preserved
        // by Promise.all, one slow/dead regional source no longer stalls
        // the whole batch).
        const perTile = await Promise.all(tiles.map(async (tileReq) => {
            const {z,x,y,pixels}=tileReq || {};
            const pxList = Array.isArray(pixels) ? pixels : [];
            if (typeof z!=="number"||typeof x!=="number"||typeof y!=="number") {
                return pxList.map(() => 0);
            }
            const bbox=tileToBbox(z,x,y);
            const cacheKey=`regional|${fetchFn.name}|${z}/${x}/${y}`;
            let tile=regionalTileCache.get(cacheKey);
            if (!tile) {
                try { tile=await fetchFn(bbox); regionalTileCacheSet(cacheKey,tile); }
                catch(err) {
                    console.warn(`[RegionalDEM] ${fetchFn.name} ${z}/${x}/${y} failed (${err.message}), falling back to Terrarium`);
                    try { tile=await fetchTile(z,x,y); } catch(_) {}
                }
            }
            if (!tile) return pxList.map(() => 0);
            // Use the tile's OWN real coverage bbox when it reports one
            // (fetchJapan's GSI tile covers a much smaller area than the
            // requested zoom-13 bbox — see fetchJapan). Falls back to the
            // requested bbox for every other regional source, whose WCS
            // fetch always covers exactly what was asked for.
            return resampleToPixels(tile,pxList,tile.bbox||bbox,z,x,y);
        }));

        res.json({elevations: perTile.flat()});
    } catch (err) {
        console.error(`[Proxy] regional elevation (${fetchFn.name}) failed:`, err.message);
        res.status(500).json({ error: "Elevation batch failed", detail: err.message });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-source fetch functions
// ─────────────────────────────────────────────────────────────────────────────

// Switzerland — SwissTopo ALTI3D 0.5m
// FIXED: was ch.swisstopo.swissalti3d-reliefschattierung (hillshade visual, 0-255 grayscale).
async function fetchSwiss(bbox) {
    return fetchWcsTile("https://wcs.geo.admin.ch","ch.swisstopo.swissalti3d",bbox,0.00000463,0.00000463);
}

// Norway — Kartverket DTM1 1m
// Was broken by sharp failing on LZW Float32. Fixed by geotiff.js.
async function fetchNorway(bbox) {
    return fetchWcsTile("https://wcs.geonorge.no/skwms1/wcs.hoyde-dtm1","hoyde-dtm1",bbox,0.00000899,0.00000899);
}

// Netherlands — PDOK AHN4 0.5m
async function fetchNetherlands(bbox) {
    return fetchWcsTile("https://service.pdok.nl/rws/ahn/wcs/v1_0","dtm_05m",bbox,0.00000463,0.00000463);
}

// Belgium — NGI LiDAR HD 1m
async function fetchBelgium(bbox) {
    return fetchWcsTile("https://wcs.ngi.be/geodata/wcs","DTM_1m",bbox,0.00000899,0.00000899);
}

// Spain — IGN PNOA MDT05 2m
async function fetchSpain(bbox) {
    return fetchWcsTile("https://servicios.idee.es/wcs-inspire/mdt","Elevacion4258_5",bbox,0.0000180,0.0000180);
}

// Austria — BEV DGM 1m
// FIXED: ArcGIS ImageServer WCS coverage index is "1", not the service name string.
async function fetchAustria(bbox) {
    return fetchWcsTile("https://gis.bev.gv.at/arcgis/services/DGM/DGM_Oesterreich/ImageServer/WCSServer","1",bbox,0.00000899,0.00000899);
}

// Germany — BKG DGM1 INSPIRE 1m
async function fetchGermany(bbox) {
    return fetchWcsTile("https://sgx.geodatenzentrum.de/wcs_dgm1_inspire","EL.GridCoverage.DTM",bbox,0.00000899,0.00000899);
}

// Czech Republic — CUZK DMR 5G 1m
// FIXED: ArcGIS ImageServer WCS coverage index is "1", not "dmr5g".
async function fetchCzech(bbox) {
    return fetchWcsTile("https://ags.cuzk.cz/arcgis/services/dmr5g/ImageServer/WCSServer","1",bbox,0.00000899,0.00000899);
}

// Slovakia — ZBGIS DMR 1m
// FIXED: ArcGIS ImageServer WCS coverage index is "1", not "DMR".
async function fetchSlovakia(bbox) {
    return fetchWcsTile("https://zbgis.skgeodesy.sk/arcgis/services/ZBGIS/DMR/ImageServer/WCSServer","1",bbox,0.00000899,0.00000899);
}

// Poland — GUGiK ISOK NMT 1m
// FIXED: was "Pokrycie_terenu" (land cover — completely wrong). Now "NMT_GRID1".
async function fetchPoland(bbox) {
    return fetchWcsTile("https://mapy.geoportal.gov.pl/wss/service/PZGIK/NMT/GRID1/WCS/DigitalTerrainModelFormatTIFF","NMT_GRID1",bbox,0.00000899,0.00000899);
}

// Estonia — Maa-amet LiDAR 1m
async function fetchEstonia(bbox) {
    return fetchWcsTile("https://kaart.maaamet.ee/wcs/alus","dem_eesti_euroopa",bbox,0.00000899,0.00000899);
}

// Latvia — LGIA DEM 1m
// FIXED: ArcGIS ImageServer WCS coverage index is "1", not "DEM_1m".
async function fetchLatvia(bbox) {
    return fetchWcsTile("https://services.lgia.gov.lv/arcgis/services/DEM/DEM_1m/ImageServer/WCSServer","1",bbox,0.00000899,0.00000899);
}

// Lithuania — GKD DEM 1m
async function fetchLithuania(bbox) {
    return fetchWcsTile("https://www.geoportal.lt/mapproxy/gisc_dtm/wcs","gisc_dtm",bbox,0.00000899,0.00000899);
}

// Slovenia — GURS DMR 1m
async function fetchSlovenia(bbox) {
    return fetchWcsTile("https://storitve.eprostor.gov.si/ows-ins-wcs/wcs","DMR_1m",bbox,0.00000899,0.00000899);
}

// Croatia — DGU INSPIRE 1m
async function fetchCroatia(bbox) {
    return fetchWcsTile("https://geoportal.dgu.hr/services/inspire/elevation/wcs","EL.GridCoverage",bbox,0.00000899,0.00000899);
}

// Portugal — DGT MDT 2m
async function fetchPortugal(bbox) {
    return fetchWcsTile("https://servicos.dgterritorio.pt/SDISNIGROAPS/wcs","MDT2m",bbox,0.0000180,0.0000180);
}

// Luxembourg — ACT LiDAR MNT 1m
// FIXED: was "lidar_mns_2019" (MNS = surface model, includes buildings/trees).
// Now "lidar_mnt_2019" (MNT = bare-earth terrain model).
async function fetchLuxembourg(bbox) {
    return fetchWcsTile("https://wmts1.geoportail.lu/opendata/service","lidar_mnt_2019",bbox,0.00000899,0.00000899);
}

// USA — USGS 3DEP 1m (+ Alaska IfSAR 5m via same endpoint)
async function fetchUSA(bbox) {
    return fetchWcsTile("https://elevation.nationalmap.gov/arcgis/services/3DEPElevation/ImageServer/WCSServer","DEP3Elevation",bbox,0.00000899,0.00000899);
}

// Canada — Geogratis CDEM 2m
async function fetchCanada(bbox) {
    return fetchWcsTile("https://datacube.services.geo.ca/ows/elevation","dtm",bbox,0.0000180,0.0000180);
}

// Japan — GSI Cyberjapan ASCII grid (not GeoTIFF)
// FIXED (v11.5): this picks a SINGLE zoom-15 GSI tile centered on the
// requested bbox's midpoint — but the caller's bbox is a zoom-13 Terrarium
// tile, roughly 4x wider/taller (16x the area) than what a zoom-15 tile
// actually covers on the ground. handleRegionalElevation used to resample
// against the CALLER's (too-big) bbox regardless, silently stretching this
// tile's real ~1km-wide data across an assumed ~4km-wide area — samples
// near the requested tile's edges landed on the wrong side of real terrain
// features, producing large false elevation swings (this is what caused
// the "floating cliff"/inverted-cone artifacts specifically in Japan, e.g.
// Mount Fuji, while identical requests elsewhere used the correctly-scoped
// global Terrarium path and never showed it). Now returns bbox = the GSI
// tile's OWN real coverage, so resampleToPixels can use ITS actual extent
// instead of assuming it matches the caller's much larger tile.
async function fetchJapan(bbox) {
    const {west,east,north,south}=bbox;
    const midLat=(north+south)/2, midLon=(east+west)/2;
    const z=15, n=Math.pow(2,z);
    const gsiX=Math.floor((midLon+180)/360*n);
    const gsiY=Math.floor((1-Math.log(Math.tan(midLat*Math.PI/180)+1/Math.cos(midLat*Math.PI/180))/Math.PI)/2*n);
    const gsiBbox=tileToBbox(z,gsiX,gsiY);
    for (const layer of ["dem","dem5a","dem10b"]) {
        try {
            const url=`https://cyberjapandata.gsi.go.jp/xyz/${layer}/${z}/${gsiX}/${gsiY}.txt`;
            const response=await axios.get(url,{timeout:10000,headers:{"User-Agent":"Tellus-Roblox-Proxy/3.5"}});
            const lines=response.data.trim().split("\n");
            const height=lines.length, width=lines[0].split(",").length;
            const elevations=new Float32Array(width*height);
            for (let row=0;row<height;row++) {
                const cols=lines[row].split(",");
                for (let col=0;col<width;col++) {
                    const v=parseFloat(cols[col]);
                    elevations[row*width+col]=isFinite(v)?v:0;
                }
            }
            return {width,height,elevations,bbox:gsiBbox};
        } catch(_) {}
    }
    throw new Error("All GSI layers failed");
}

// New Zealand — LINZ NZ 8m DEM (layer 51768)
// FIXED: was a broken URL with empty key slot.
// Set LINZ_API_KEY in Railway env vars. Free account at data.linz.govt.nz.
// Without the key, throws and falls back to Terrarium cleanly.
async function fetchNewZealand(bbox) {
    const key=process.env.LINZ_API_KEY;
    if (!key) throw new Error("LINZ_API_KEY env var not set");
    return fetchWcsTile(`https://data.linz.govt.nz/services;key=${key}/wcs`,"layer-51768",bbox,0.0000720,0.0000720);
}

// Australia — Geoscience Australia ~30m
// FIXED: ArcGIS MapServer WCS coverage index is "1", not the full layer name string.
async function fetchAustralia(bbox) {
    return fetchWcsTile("https://services.ga.gov.au/site_9/services/DEM_SRTM_1Second_Hydro_Enforced/MapServer/WCSServer","1",bbox,0.000277,0.000277);
}

// Arctic — ArcticDEM v4.1 via PGC ArcGIS WCS
// FIXED: was a fabricated S3 WMS URL (doesn't exist). Now PGC's real public endpoint.
async function fetchArctic(bbox) {
    return fetchWcsTile("https://di-pgc.img.arcgis.com/arcgis/services/arcticdem_latest/ImageServer/WCSServer","1",bbox,0.0000180,0.0000180);
}

// Antarctica — REMA v2 via PGC ArcGIS WCS
// FIXED: was a fabricated S3 WMS URL. Now PGC's real overlord endpoint.
async function fetchAntarctica(bbox) {
    return fetchWcsTile("https://overlord.pgc.umn.edu/arcgis/rest/services/elevation/pgc_rema_mosaics_v2/ImageServer/WCSServer","1",bbox,0.0000180,0.0000180);
}

// Rest-of-world named peaks (Aconcagua, Kilimanjaro, Elbrus, Puncak Jaya,
// Mont Blanc) — Copernicus DEM GLO-30 via the public AWS Open Data bucket
// (registry.opendata.aws/copernicus-dem). Verified real: bucket
// "copernicus-dem-30m", eu-central-1, public HTTPS GET, no API key, no
// rate limit — deliberately NOT using OpenTopography's /API/globaldem
// convenience wrapper for the same dataset, which requires a key and caps
// non-academic use at 50 calls/24h, unworkable for a live game server.
//
// Tiles are fixed 1x1 degree COGs named by their SW corner (e.g.
// Copernicus_DSM_COG_10_N27_00_E086_00_DEM). A tile (~111km across) is
// always much larger than the caller's zoom-13 bbox (~20-40km), so unlike
// fetchJapan's original bug (a SMALLER native tile than the requested
// bbox, causing samples to silently land on the wrong side of real
// terrain), the only residual edge case here is a requested bbox that
// straddles a whole-degree line — samples past this tile's real edge get
// clamped by resampleToPixels/sampleBilinear to that edge's value instead
// of reading real terrain from the neighboring tile. That is a far milder
// failure (a few repeated-edge pixels once every ~111km) than what Japan
// produced, but it is a known v1 limitation, not a solved one.
//
// Still returns bbox = the TILE'S OWN real 1x1 degree extent, never the
// caller's requested bbox — the one fix that actually mattered for Japan,
// applied here from the start instead of after the fact.
async function fetchCopernicusGlo30(bbox) {
    const {west,east,north,south}=bbox;
    const midLat=(north+south)/2, midLon=(east+west)/2;
    const tileLat=Math.floor(midLat), tileLon=Math.floor(midLon);
    const ns=tileLat>=0?"N":"S", ew=tileLon>=0?"E":"W";
    const latAbs=String(Math.abs(tileLat)).padStart(2,"0");
    const lonAbs=String(Math.abs(tileLon)).padStart(3,"0");
    const name=`Copernicus_DSM_COG_10_${ns}${latAbs}_00_${ew}${lonAbs}_00_DEM`;
    const url=`https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif`;
    const response=await axios.get(url,{responseType:"arraybuffer",timeout:15000,headers:{"User-Agent":"Tellus-Roblox-Proxy/3.5"}});
    const decoded=await decodeGeoTiff(Buffer.from(response.data));
    decoded.bbox={west:tileLon,east:tileLon+1,north:tileLat+1,south:tileLat};
    return decoded;
}

// ── Regional routes ───────────────────────────────────────────────────────────
app.post("/elevation/arctic",      (req,res)=>handleRegionalElevation(req,res,fetchArctic));
app.post("/elevation/antarctica",  (req,res)=>handleRegionalElevation(req,res,fetchAntarctica));
app.post("/elevation/glo30",       (req,res)=>handleRegionalElevation(req,res,fetchCopernicusGlo30));
app.post("/elevation/ch",  (req,res)=>handleRegionalElevation(req,res,fetchSwiss));
app.post("/elevation/no",  (req,res)=>handleRegionalElevation(req,res,fetchNorway));
app.post("/elevation/nl",  (req,res)=>handleRegionalElevation(req,res,fetchNetherlands));
app.post("/elevation/be",  (req,res)=>handleRegionalElevation(req,res,fetchBelgium));
app.post("/elevation/es",  (req,res)=>handleRegionalElevation(req,res,fetchSpain));
app.post("/elevation/at",  (req,res)=>handleRegionalElevation(req,res,fetchAustria));
app.post("/elevation/de",  (req,res)=>handleRegionalElevation(req,res,fetchGermany));
app.post("/elevation/cz",  (req,res)=>handleRegionalElevation(req,res,fetchCzech));
app.post("/elevation/sk",  (req,res)=>handleRegionalElevation(req,res,fetchSlovakia));
app.post("/elevation/pl",  (req,res)=>handleRegionalElevation(req,res,fetchPoland));
app.post("/elevation/ee",  (req,res)=>handleRegionalElevation(req,res,fetchEstonia));
app.post("/elevation/lv",  (req,res)=>handleRegionalElevation(req,res,fetchLatvia));
app.post("/elevation/lt",  (req,res)=>handleRegionalElevation(req,res,fetchLithuania));
app.post("/elevation/si",  (req,res)=>handleRegionalElevation(req,res,fetchSlovenia));
app.post("/elevation/hr",  (req,res)=>handleRegionalElevation(req,res,fetchCroatia));
app.post("/elevation/pt",  (req,res)=>handleRegionalElevation(req,res,fetchPortugal));
app.post("/elevation/lu",  (req,res)=>handleRegionalElevation(req,res,fetchLuxembourg));
app.post("/elevation/us",  (req,res)=>handleRegionalElevation(req,res,fetchUSA));
app.post("/elevation/ca",  (req,res)=>handleRegionalElevation(req,res,fetchCanada));
app.post("/elevation/jp",  (req,res)=>handleRegionalElevation(req,res,fetchJapan));
app.post("/elevation/nz",  (req,res)=>handleRegionalElevation(req,res,fetchNewZealand));
app.post("/elevation/au",  (req,res)=>handleRegionalElevation(req,res,fetchAustralia));

// ─────────────────────────────────────────────────────────────────────────────
// GET /  — health check
// ─────────────────────────────────────────────────────────────────────────────
app.get("/",(req,res)=>{
    res.json({
        status:"Tellus Elevation Proxy running",
        version:"3.5.0",
        koppen:koppen?`${koppen.width}x${koppen.height} loaded`:"unavailable",
        webshareProxies:webshareAgents.length,
        linzKeyConfigured:!!process.env.LINZ_API_KEY,
        cache:{
            tiles:`${tileCache.size}/${TILE_CACHE_MAX}`,
            regionalTiles:`${regionalTileCache.size}/${REGIONAL_TILE_CACHE_MAX}`,
            osm:`${osmCache.size}/${OSM_CACHE_MAX}`,
        },
        overpass:{
            queueDepth:overpassQueue.length,
            busy:overpassBusy,
            minGapMs:MIN_OVERPASS_GAP_MS,
            nextProxyIdx:_wsIdx%webshareAgents.length,
        },
        endpoints:[
            "GET  /tile?z=&x=&y=         -> decoded Terrarium tile",
            "POST /elevation              -> batched pixel samples (global Terrarium)",
            "POST /elevation/arctic       -> ArcticDEM v4.1 via PGC ArcGIS WCS",
            "POST /elevation/antarctica   -> REMA v2 via PGC ArcGIS WCS",
            "POST /elevation/glo30        -> Copernicus DEM GLO-30 (rest-of-world named peaks)",
            "POST /elevation/ch           -> SwissTopo ALTI3D 0.5m",
            "POST /elevation/no           -> Kartverket DTM1 1m",
            "POST /elevation/nl           -> PDOK AHN4 0.5m",
            "POST /elevation/be           -> NGI LiDAR HD 1m",
            "POST /elevation/es           -> IGN PNOA MDT05 2m",
            "POST /elevation/at           -> BEV DGM 1m",
            "POST /elevation/de           -> BKG DGM1 1m",
            "POST /elevation/cz           -> CUZK DMR 5G 1m",
            "POST /elevation/sk           -> ZBGIS DMR 1m",
            "POST /elevation/pl           -> GUGiK NMT 1m",
            "POST /elevation/ee           -> Maa-amet LiDAR 1m",
            "POST /elevation/lv           -> LGIA DEM 1m",
            "POST /elevation/lt           -> GKD DEM 1m",
            "POST /elevation/si           -> GURS DMR 1m",
            "POST /elevation/hr           -> DGU INSPIRE 1m",
            "POST /elevation/pt           -> DGT MDT 2m",
            "POST /elevation/lu           -> ACT LiDAR MNT 1m",
            "POST /elevation/us           -> USGS 3DEP 1m",
            "POST /elevation/ca           -> Geogratis CDEM 2m",
            "POST /elevation/jp           -> GSI DEM 1m/5m",
            "POST /elevation/nz           -> LINZ NZ 8m (LINZ_API_KEY required)",
            "POST /elevation/au           -> Geoscience Australia ~30m",
            "POST /water                  -> water polygon ways (cached)",
            "POST /buildings              -> building footprint ways (cached)",
            "POST /roads                  -> road ways (cached)",
            "POST /osm                    -> roads + buildings combined (cached)",
            "GET  /geocode?q=             -> Nominatim search",
            "GET  /reverse?lat=&lon=      -> Nominatim reverse geocode (country)",
            "POST /landcover              -> Koppen climate per point",
        ],
        removedSources:[
            "Denmark  - datafordeler.dk WCS requires username+password",
            "Finland  - NLS WCS requires API key; beta endpoint decommissioned",
            "Ireland  - no confirmed public WCS for Tailte Eireann DTM",
        ],
    });
});

app.listen(PORT,()=>{
    console.log(`[Tellus Proxy] v3.5.0 listening on port ${PORT}`);
});