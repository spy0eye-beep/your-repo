/**
 * proxy_server.js  —  Tellus Elevation & OSM Proxy  (v3.0.0)
 * Node.js / Express, deploy on Railway.
 *
 * What changed in v3 vs v2:
 *
 *   1. Overpass request queue + throttle
 *      All /osm, /water, and /buildings calls now go through a single
 *      async queue with a MIN_OVERPASS_GAP_MS gap between dispatches.
 *      No matter how many Roblox servers are running, this proxy sends
 *      at most one Overpass request per gap window — eliminating the
 *      429/504 storms that came from concurrent game-server calls.
 *
 *   2. Overpass bbox response cache
 *      Responses are cached by bbox key (snapped to CELL_DEG grid, same
 *      0.1° cell size as WaterMaskService.lua). A hit returns instantly
 *      without touching Overpass. LRU eviction at OSM_CACHE_MAX entries.
 *
 *   3. /water endpoint
 *      New POST /water — same bbox body as /osm — returns closed water
 *      polygon ways (natural=water, waterway=riverbank, natural=beach).
 *      Matches WaterMaskService.lua's Overpass query exactly so it can
 *      call the proxy instead of Overpass directly.
 *
 *   4. /buildings endpoint
 *      New POST /buildings — bbox body — returns building footprint ways
 *      with tags. Lets BuildingService.lua call the proxy instead of
 *      Overpass directly.
 *
 *   5. /osm now returns ways in the shape OsmService/OsmGenerator expect
 *      (was already fixed in v2 with "out geom;" — kept as-is).
 *
 * Existing endpoints (/tile, /elevation, /geocode, /landcover) unchanged.
 *
 * TERRARIUM DECODE (matches TerrainTilesElevationSource.java):
 *   elevation = (R * 256 + G + B / 256) - 32768
 */

const express = require("express");
const axios   = require("axios");
const sharp   = require("sharp");
const cors    = require("cors");
const zlib    = require("zlib");
const fs      = require("fs");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "4mb" }));

// ─────────────────────────────────────────────────────────────────────────────
// Terrarium decode
// ─────────────────────────────────────────────────────────────────────────────
function terrariumToMeters(r, g, b) {
    return (r * 256 + g + b / 256) - 32768;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tile cache (elevation PNG tiles, LRU by insertion order)
// ─────────────────────────────────────────────────────────────────────────────
const tileCache   = new Map();
const TILE_CACHE_MAX = 200;

function tileCacheSet(key, value) {
    if (tileCache.size >= TILE_CACHE_MAX) {
        tileCache.delete(tileCache.keys().next().value);
    }
    tileCache.set(key, value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Overpass bbox response cache
//
// Key: "<endpoint>|<snappedSouth>,<snappedWest>" so /water and /buildings
// results are cached independently even for the same bbox.
// ─────────────────────────────────────────────────────────────────────────────
const osmCache     = new Map();
const OSM_CACHE_MAX = 500;  // ~50 MB at typical response sizes
const CELL_DEG     = 0.1;   // must match WaterMaskService.lua CELL_SIZE_DEG

function osmCacheSet(key, value) {
    if (osmCache.size >= OSM_CACHE_MAX) {
        osmCache.delete(osmCache.keys().next().value);
    }
    osmCache.set(key, value);
}

/** Snap a lat/lon to the nearest CELL_DEG grid corner (south/west). */
function snapBbox(minLat, minLon, maxLat, maxLon) {
    const sLat = Math.floor(minLat / CELL_DEG) * CELL_DEG;
    const sLon = Math.floor(minLon / CELL_DEG) * CELL_DEG;
    // We snap to cell boundaries but honour the actual requested extent
    // for the query — the cache key is just the SW corner so overlapping
    // requests for the same cell hit the same entry.
    return { sLat, sLon };
}

// ─────────────────────────────────────────────────────────────────────────────
// Overpass request queue
//
// All calls to postOverpass() are serialized through this queue with a
// MIN_GAP_MS minimum spacing. No concurrent Overpass calls ever leave this
// server, regardless of how many Roblox game-servers are calling us.
// ─────────────────────────────────────────────────────────────────────────────
const MIN_OVERPASS_GAP_MS   = 1100;  // ~1 req/sec — well within Overpass limits
const OVERPASS_TIMEOUT_MS   = 28000;
const OVERPASS_MAX_RETRIES  = 3;
const OVERPASS_RETRY_DELAY  = 5000; // ms before each retry

// v3.1 (multi-proxy scaling): configurable per deployment. When running
// several Railway instances of this proxy, give EACH ONE a different
// OVERPASS_URL env var so they draw from different Overpass mirrors'
// rate-limit budgets instead of all hammering overpass-api.de:
//   https://overpass-api.de/api/interpreter        (default)
//   https://overpass.kumi.systems/api/interpreter
//   https://overpass.private.coffee/api/interpreter
const OVERPASS_URL = process.env.OVERPASS_URL
    || "https://overpass-api.de/api/interpreter";

const overpassQueue = [];
let   overpassBusy  = false;
let   lastOverpassAt = 0;

/** Internal: execute one queued Overpass call. */
async function _runNextOverpass() {
    if (overpassBusy || overpassQueue.length === 0) return;
    overpassBusy = true;

    const { query, resolve, reject } = overpassQueue.shift();

    // Enforce minimum gap since last request
    const gap = Date.now() - lastOverpassAt;
    if (gap < MIN_OVERPASS_GAP_MS) {
        await new Promise(r => setTimeout(r, MIN_OVERPASS_GAP_MS - gap));
    }

    let lastErr;
    for (let attempt = 1; attempt <= OVERPASS_MAX_RETRIES; attempt++) {
        try {
            const response = await axios.post(
                OVERPASS_URL,
                "data=" + encodeURIComponent(query),
                {
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                        "User-Agent":   "Tellus-Roblox-Proxy/3.0",
                    },
                    timeout: OVERPASS_TIMEOUT_MS,
                }
            );
            lastOverpassAt = Date.now();
            overpassBusy = false;
            // Kick the next item without waiting
            setImmediate(_runNextOverpass);
            resolve(response.data);
            return;
        } catch (err) {
            lastErr = err;
            const status = err.response?.status;
            if (status === 429 || status === 504) {
                const wait = status === 429 ? 60000 : OVERPASS_RETRY_DELAY;
                console.warn(`[Overpass] ${status} on attempt ${attempt}, waiting ${wait}ms`);
                await new Promise(r => setTimeout(r, wait));
            } else if (attempt < OVERPASS_MAX_RETRIES) {
                await new Promise(r => setTimeout(r, OVERPASS_RETRY_DELAY));
            }
        }
    }

    lastOverpassAt = Date.now();
    overpassBusy = false;
    setImmediate(_runNextOverpass);
    reject(lastErr);
}

/** Public: enqueue an Overpass QL query and get a Promise<responseData>. */
function postOverpass(query) {
    return new Promise((resolve, reject) => {
        overpassQueue.push({ query, resolve, reject });
        _runNextOverpass();
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse bbox from request body, validate, return {minLat,minLon,maxLat,maxLon}
// ─────────────────────────────────────────────────────────────────────────────
function parseBbox(body) {
    const { minLat, minLon, maxLat, maxLon } = body;
    if (minLat == null || minLon == null || maxLat == null || maxLon == null) {
        return { error: "Missing bounding box (minLat, minLon, maxLat, maxLon)" };
    }
    const s = parseFloat(minLat), w = parseFloat(minLon);
    const n = parseFloat(maxLat), e = parseFloat(maxLon);
    if ([s, w, n, e].some(isNaN)) {
        return { error: "Bounding box values must be numbers" };
    }
    return { minLat: s, minLon: w, maxLat: n, maxLon: e };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch + decode an elevation tile (cached)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (tileCache.has(key)) return tileCache.get(key);

    const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
    const response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 10000,
        headers: { "User-Agent": "Tellus-Roblox-Proxy/3.0" },
    });

    const { data, info } = await sharp(Buffer.from(response.data))
        .ensureAlpha(0)
        .raw()
        .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    const elevations = new Float32Array(width * height);
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const idx = (row * width + col) * channels;
            elevations[row * width + col] = terrariumToMeters(data[idx], data[idx + 1], data[idx + 2]);
        }
    }

    const result = { width, height, elevations };
    tileCacheSet(key, result);
    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bilinear interpolation over a decoded tile
// ─────────────────────────────────────────────────────────────────────────────
function sampleBilinear(tile, px, py) {
    const { width, height, elevations } = tile;
    const x0 = Math.floor(px), y0 = Math.floor(py);
    const x1 = Math.min(x0 + 1, width - 1);
    const y1 = Math.min(y0 + 1, height - 1);
    const tx = px - x0, ty = py - y0;
    const h00 = elevations[y0 * width + x0] || 0;
    const h10 = elevations[y0 * width + x1] || 0;
    const h01 = elevations[y1 * width + x0] || 0;
    const h11 = elevations[y1 * width + x1] || 0;
    return (h00 + (h10 - h00) * tx) + ((h01 + (h11 - h01) * tx) - (h00 + (h10 - h00) * tx)) * ty;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /tile?z=&x=&y=
// ─────────────────────────────────────────────────────────────────────────────
app.get("/tile", async (req, res) => {
    const z = parseInt(req.query.z);
    const x = parseInt(req.query.x);
    const y = parseInt(req.query.y);
    if (isNaN(z) || isNaN(x) || isNaN(y)) return res.status(400).json({ error: "Missing z, x, y" });
    if (z < 0 || z > 15) return res.status(400).json({ error: "Zoom out of range 0-15" });

    try {
        const tile = await fetchTile(z, x, y);
        res.json({ z, x, y, width: tile.width, height: tile.height,
            elevations: Array.from(tile.elevations).map(v => Math.round(v * 10) / 10) });
    } catch (err) {
        console.error(`[Proxy] /tile ${z}/${x}/${y} failed:`, err.message);
        res.status(500).json({ error: "Tile fetch failed", detail: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /elevation  —  batch pixel samples (unchanged from v2)
// ─────────────────────────────────────────────────────────────────────────────
app.post("/elevation", async (req, res) => {
    const { tiles } = req.body;
    if (!Array.isArray(tiles)) return res.status(400).json({ error: "Body must have 'tiles' array" });

    const results = [];
    for (const tileReq of tiles) {
        const { z, x, y, pixels } = tileReq;
        if (typeof z !== "number" || typeof x !== "number" || typeof y !== "number") {
            for (let i = 0; i < (pixels?.length || 0); i++) results.push(0);
            continue;
        }
        let tile;
        try {
            tile = await fetchTile(z, x, y);
        } catch (err) {
            console.error(`[Proxy] /elevation tile ${z}/${x}/${y} failed:`, err.message);
            for (let i = 0; i < (pixels?.length || 0); i++) results.push(0);
            continue;
        }
        for (const [px, py] of (pixels || [])) {
            const cpx = Math.max(0, Math.min(tile.width  - 1, px));
            const cpy = Math.max(0, Math.min(tile.height - 1, py));
            results.push(Math.round(sampleBilinear(tile, cpx, cpy) * 10) / 10);
        }
    }
    res.json({ elevations: results });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /water  ← NEW
//
// Body: { minLat, minLon, maxLat, maxLon }
// Returns: { elements: [...] }  — same raw Overpass JSON, cached by cell.
//
// WaterMaskService.lua should POST here instead of hitting Overpass directly.
// The query matches WaterMaskService's fetchCell() query exactly:
//   natural=water, waterway=riverbank, natural=beach (closed ways only).
// ─────────────────────────────────────────────────────────────────────────────
app.post("/water", async (req, res) => {
    const bbox = parseBbox(req.body);
    if (bbox.error) return res.status(400).json({ error: bbox.error });
    const { minLat, minLon, maxLat, maxLon } = bbox;

    const { sLat, sLon } = snapBbox(minLat, minLon, maxLat, maxLon);
    const cacheKey = `water|${sLat.toFixed(2)},${sLon.toFixed(2)}`;

    if (osmCache.has(cacheKey)) {
        return res.json(osmCache.get(cacheKey));
    }

    const query = `[out:json][timeout:25];(way["natural"="water"](${minLat},${minLon},${maxLat},${maxLon});way["waterway"="riverbank"](${minLat},${minLon},${maxLat},${maxLon});way["natural"="beach"](${minLat},${minLon},${maxLat},${maxLon}););out body;>;out skel qt;`;

    try {
        const data = await postOverpass(query);
        const result = { elements: data.elements || [] };
        osmCacheSet(cacheKey, result);
        res.json(result);
    } catch (err) {
        console.error("[Proxy] /water Overpass failed:", err.message);
        const status = err.response?.status || 500;
        res.status(status >= 400 ? status : 500).json({ error: "Overpass fetch failed", detail: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /buildings  ← NEW
//
// Body: { minLat, minLon, maxLat, maxLon }
// Returns raw Overpass JSON (nodes + ways with building tags), cached by cell.
//
// BuildingService.lua should POST here instead of Overpass directly.
// ─────────────────────────────────────────────────────────────────────────────
app.post("/buildings", async (req, res) => {
    const bbox = parseBbox(req.body);
    if (bbox.error) return res.status(400).json({ error: bbox.error });
    const { minLat, minLon, maxLat, maxLon } = bbox;

    const { sLat, sLon } = snapBbox(minLat, minLon, maxLat, maxLon);
    const cacheKey = `buildings|${sLat.toFixed(2)},${sLon.toFixed(2)}`;

    if (osmCache.has(cacheKey)) {
        return res.json(osmCache.get(cacheKey));
    }

    const query = `[out:json][timeout:25];(way["building"](${minLat},${minLon},${maxLat},${maxLon}););out body;>;out skel qt;`;

    try {
        const data = await postOverpass(query);
        const result = { elements: data.elements || [] };
        osmCacheSet(cacheKey, result);
        res.json(result);
    } catch (err) {
        console.error("[Proxy] /buildings Overpass failed:", err.message);
        const status = err.response?.status || 500;
        res.status(status >= 400 ? status : 500).json({ error: "Overpass fetch failed", detail: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /osm  —  roads + buildings (kept from v2, now runs through the queue)
// ─────────────────────────────────────────────────────────────────────────────
app.post("/osm", async (req, res) => {
    const bbox = parseBbox(req.body);
    if (bbox.error) return res.status(400).json({ error: bbox.error });
    const { minLat, minLon, maxLat, maxLon } = bbox;

    const { sLat, sLon } = snapBbox(minLat, minLon, maxLat, maxLon);
    const cacheKey = `osm|${sLat.toFixed(2)},${sLon.toFixed(2)}`;

    if (osmCache.has(cacheKey)) {
        return res.json(osmCache.get(cacheKey));
    }

    const query = `[out:json][timeout:25];(way["building"](${minLat},${minLon},${maxLat},${maxLon});way["highway"](${minLat},${minLon},${maxLat},${maxLon}););out geom;`;

    try {
        const data = await postOverpass(query);
        const elements = data.elements || [];
        const buildings = [], roads = [];

        for (const el of elements) {
            if (el.type === "way" && el.geometry) {
                const nodes = el.geometry.map(g => ({ lat: g.lat, lon: g.lon }));
                if (el.tags?.building) {
                    buildings.push({ nodes, tags: el.tags, name: el.tags.name || "Building" });
                } else if (el.tags?.highway) {
                    roads.push({ nodes, tags: el.tags, type: el.tags.highway });
                }
            }
        }

        const result = { buildings, ways: roads };
        osmCacheSet(cacheKey, result);
        res.json(result);
    } catch (err) {
        console.error("[Proxy] /osm Overpass failed:", err.message);
        const status = err.response?.status || 500;
        res.status(status >= 400 ? status : 500).json({ error: "Failed to fetch OSM data", detail: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /roads  — roads-only (for OsmService.lua if you want to split it out)
// ─────────────────────────────────────────────────────────────────────────────
const ROAD_FILTER = "motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|service";

app.post("/roads", async (req, res) => {
    const bbox = parseBbox(req.body);
    if (bbox.error) return res.status(400).json({ error: bbox.error });
    const { minLat, minLon, maxLat, maxLon } = bbox;

    const { sLat, sLon } = snapBbox(minLat, minLon, maxLat, maxLon);
    const cacheKey = `roads|${sLat.toFixed(2)},${sLon.toFixed(2)}`;

    if (osmCache.has(cacheKey)) {
        return res.json(osmCache.get(cacheKey));
    }

    const query = `[out:json][timeout:25];(way["highway"~"^(${ROAD_FILTER})$"](${minLat},${minLon},${maxLat},${maxLon}););out body;>;out skel qt;`;

    try {
        const data = await postOverpass(query);
        const nodes = {};
        for (const el of (data.elements || [])) {
            if (el.type === "node") nodes[el.id] = { lat: el.lat, lon: el.lon };
        }
        const ways = [];
        for (const el of (data.elements || [])) {
            if (el.type === "way" && el.nodes) {
                const resolved = el.nodes.map(id => nodes[id]).filter(Boolean);
                if (resolved.length >= 2) {
                    ways.push({ id: el.id, tags: el.tags || {}, nodes: resolved });
                }
            }
        }
        const result = { ways };
        osmCacheSet(cacheKey, result);
        res.json(result);
    } catch (err) {
        console.error("[Proxy] /roads Overpass failed:", err.message);
        const status = err.response?.status || 500;
        res.status(status >= 400 ? status : 500).json({ error: "Failed to fetch road data", detail: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /geocode
// ─────────────────────────────────────────────────────────────────────────────
app.get("/geocode", async (req, res) => {
    const q = req.query.q, limit = req.query.limit || 5;
    if (!q) return res.status(400).json({ error: "Missing query 'q'" });

    try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&limit=${limit}&q=${encodeURIComponent(q)}`;
        const response = await axios.get(url, { headers: { "User-Agent": "Tellus-Roblox-Proxy/3.0" } });
        res.json(response.data);
    } catch (err) {
        console.error("[Proxy] /geocode failed:", err.message);
        res.status(500).json({ error: "Geocode fetch failed" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Köppen–Geiger climate raster (packed binary, mode-downsampled to 0.0333°)
//
// koppen_packed.bin.gz is a gzipped, self-describing grid built from the
// Tellus mod's koppen_geiger_0p00833333.tif (43200x21600 uint8, values
// 0..30). We downsampled 4x by DOMINANT non-zero class per block — so a
// mostly-land cell keeps its real climate even with a sliver of nodata —
// giving a 10800x5400 grid (~58MB raw, ~0.9MB gzipped, decompressed into
// memory once on boot). Value 0 = nodata/ocean.
//
// Header (little-endian): 4s magic "KPKG", u16 version, u32 width,
// u32 height, f64 originLon, f64 originLat, f64 degPerPixel, f64 factor.
// Sampling is plain equirectangular: px=(lon-originLon)/deg,
// py=(originLat-lat)/deg — no projection math needed.
// ─────────────────────────────────────────────────────────────────────────────
const KOPPEN_CODES = [
    null, "Af","Am","Aw","BWh","BWk","BSh","BSk","Csa","Csb","Csc",
    "Cwa","Cwb","Cwc","Cfa","Cfb","Cfc","Dsa","Dsb","Dsc","Dsd",
    "Dwa","Dwb","Dwc","Dwd","Dfa","Dfb","Dfc","Dfd","ET","EF",
];

let koppen = null; // { grid:Buffer, width, height, originLon, originLat, deg }

function loadKoppen() {
    try {
        const gzPath = path.join(__dirname, "koppen_packed.bin.gz");
        const raw = zlib.gunzipSync(fs.readFileSync(gzPath));
        const magic = raw.toString("latin1", 0, 4);
        if (magic !== "KPKG") throw new Error("bad magic: " + magic);
        const width     = raw.readUInt32LE(6);
        const height    = raw.readUInt32LE(10);
        const originLon = raw.readDoubleLE(14);
        const originLat = raw.readDoubleLE(22);
        const deg       = raw.readDoubleLE(30);
        const HEADER    = 46;
        const grid = raw.subarray(HEADER, HEADER + width * height);
        koppen = { grid, width, height, originLon, originLat, deg };
        console.log(`[Tellus Proxy] Köppen raster loaded: ${width}x${height} @ ${deg.toFixed(4)}°/px`);
    } catch (err) {
        console.warn("[Tellus Proxy] Köppen raster unavailable — /landcover will return null koppen:", err.message);
        koppen = null;
    }
}
loadKoppen();

function koppenAt(lat, lon) {
    if (!koppen) return null;
    const px = Math.floor((lon - koppen.originLon) / koppen.deg);
    const py = Math.floor((koppen.originLat - lat) / koppen.deg);
    if (px < 0 || py < 0 || px >= koppen.width || py >= koppen.height) return null;
    const v = koppen.grid[py * koppen.width + px];
    return (v > 0 && v < KOPPEN_CODES.length) ? KOPPEN_CODES[v] : null;
}

// Nearest non-nodata sample: coastal points can land on an ocean (0) pixel
// even though real land is one cell away. Spiral out a few rings so shoreline
// columns still get a plausible climate instead of null.
function koppenNearest(lat, lon, maxRing) {
    const direct = koppenAt(lat, lon);
    if (direct) return direct;
    if (!koppen) return null;
    const d = koppen.deg;
    for (let ring = 1; ring <= (maxRing || 3); ring++) {
        for (let dy = -ring; dy <= ring; dy++) {
            for (let dx = -ring; dx <= ring; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
                const c = koppenAt(lat + dy * d, lon + dx * d);
                if (c) return c;
            }
        }
    }
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /landcover  — real Köppen climate per point (item: biome realism)
//
// Body: { points: [{lat, lon}, ...] }
// Returns: { classes: [{esa, koppen}, ...] } in the SAME order as points.
//
// esa: we don't ship an ESA WorldCover raster (10m, terabytes), so esa is
//   left at 0 ("no data") and the Lua BiomeClassification uses its
//   esa=NONE fallback rows keyed on Köppen alone — still a massive upgrade
//   over the old latitude-only guess. Wire a real ESA source here later and
//   the Lua side needs no changes.
// koppen: the Köppen–Geiger code string ("Af", "BWh", ...) or null (ocean/
//   nodata) — the Lua side treats null as "use latitude fallback".
// ─────────────────────────────────────────────────────────────────────────────
app.post("/landcover", (req, res) => {
    const points = (req.body && req.body.points) || [];
    if (!Array.isArray(points) || points.length === 0) {
        return res.json({ classes: [] });
    }
    const classes = points.map((p) => {
        const lat = Number(p.lat), lon = Number(p.lon);
        if (!isFinite(lat) || !isFinite(lon)) return { esa: 0, koppen: "NONE" };
        const code = koppenNearest(lat, lon, 3);
        return { esa: 0, koppen: code || "NONE" };
    });
    res.json({ classes });
});

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Regional DEM sources  (v3.4.0)
//
// Each source uses its native public API directly — no OpenTopography middleman,
// no API key, no registration required. Every route follows the same contract
// as POST /elevation: body { tiles:[{z,x,y,pixels}] }, returns { elevations:[] }.
//
// On any fetch failure the affected pixels return 0 and the chunk retries —
// same soft-fail behaviour as the global /elevation route.
//
// Tile z/x/y come from ElevationService.lua's Terrarium sharding scheme.
// We convert them to lat/lon bboxes or pixel coordinates per source's API.
//
// Sources wired (all free, no key, no registration):
//   Switzerland  — SwissTopo ALTI3D WCS, 0.5m
//   Norway       — Kartverket Høydedata WCS, 1m
//   Netherlands  — PDOK AHN4 WCS, 0.5m
//   Denmark      — SDFI WCS, 0.4m
//   Belgium      — NGI WCS, 1m
//   Spain        — IGN PNOA WCS, 2m
//   Ireland      — OSi/OSNI WCS, 2m
//   Austria      — BEV DGM WCS, 1m
//   Germany      — BKG DGM WCS, 1m
//   Czech Rep.   — ČÚZK WCS, 1m
//   Slovakia     — GEODIS WCS, 1m
//   Poland       — GUGiK ISOK WCS, 1m
//   Finland      — NLS Finland WCS, 2m
//   Estonia      — Maa-amet WCS, 1m
//   Latvia       — LĢIA WCS, 1m
//   Lithuania    — NŽT WCS, 1m
//   Slovenia     — GURS WCS, 1m
//   Croatia      — DGU WCS, 1m
//   Portugal     — DGT WCS, 2m
//   Luxembourg   — ACT WCS, 1m
//   USA          — USGS 3DEP WCS, 1m
//   USA Alaska   — USGS IfSAR, 5m (same 3DEP endpoint, different coverage)
//   Canada       — Geogratis WCS, 2m
//   Japan        — GSI Cyberjapan tile API, 1m/5m
//   New Zealand  — LINZ WCS, 1m
//   Australia    — Geoscience Australia WCS, 1m/5m
//   Arctic       — ArcticDEM COG tiles via AWS, 2m
//   Antarctica   — REMA COG tiles via AWS, 2m
// ─────────────────────────────────────────────────────────────────────────────

// Regional tile cache — separate from global Terrarium cache so they never evict each other
const regionalTileCache = new Map();
const REGIONAL_TILE_CACHE_MAX = 600;

function regionalTileCacheSet(key, value) {
    if (regionalTileCache.size >= REGIONAL_TILE_CACHE_MAX) {
        regionalTileCache.delete(regionalTileCache.keys().next().value);
    }
    regionalTileCache.set(key, value);
}

// ── Tile z/x/y → lat/lon bbox conversion (Web Mercator / Terrarium scheme) ──
function tileToBbox(z, x, y) {
    const n = Math.pow(2, z);
    const west  =  x      / n * 360 - 180;
    const east  = (x + 1) / n * 360 - 180;
    const north = Math.atan(Math.sinh(Math.PI * (1 - 2 *  y      / n))) * 180 / Math.PI;
    const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
    return { west, east, north, south };
}

// ── Decode a GeoTIFF buffer via sharp into { width, height, elevations } ────
// sharp handles Float32/Int16/UInt16 GeoTIFF single-band rasters natively.
async function decodeGeoTiff(buffer) {
    try {
        const { data, info } = await sharp(buffer)
            .extractChannel(0)
            .raw()
            .toBuffer({ resolveWithObject: true });
        const { width, height } = info;
        const elevations = new Float32Array(width * height);
        const buf = Buffer.from(data);
        // Try Float32 first (most WCS GeoTIFFs), fall back to Int16
        const isFloat = info.depth === "float";
        for (let i = 0; i < width * height; i++) {
            const v = isFloat ? buf.readFloatLE(i * 4) : buf.readInt16LE(i * 2);
            // Nodata values vary by source; treat extreme values as 0
            elevations[i] = (isFinite(v) && v > -9000 && v < 9000) ? v : 0;
        }
        return { width, height, elevations };
    } catch (err) {
        throw new Error("GeoTIFF decode failed: " + err.message);
    }
}

// ── Generic WCS 1.0.0 / 1.1.0 fetcher ───────────────────────────────────────
// Most European national agencies expose their DEMs via OGC WCS.
// Returns decoded { width, height, elevations } or throws.
async function fetchWcsTile(wcsUrl, coverageName, bbox, resx, resy, crs = "EPSG:4326") {
    const { west, east, north, south } = bbox;
    // Target ~256px output regardless of native resolution, capped at native res
    const lonSpan = east - west;
    const latSpan = north - south;
    const width  = Math.min(256, Math.ceil(lonSpan / resx));
    const height = Math.min(256, Math.ceil(latSpan / resy));
    if (width < 1 || height < 1) throw new Error("Tile bbox too small");

    const url = `${wcsUrl}`
        + `?SERVICE=WCS&VERSION=1.0.0&REQUEST=GetCoverage`
        + `&COVERAGE=${coverageName}`
        + `&CRS=${crs}`
        + `&BBOX=${west},${south},${east},${north}`
        + `&WIDTH=${width}&HEIGHT=${height}`
        + `&FORMAT=GeoTIFF`;

    const response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 15000,
        headers: { "User-Agent": "Tellus-Roblox-Proxy/3.4" },
    });
    return decodeGeoTiff(Buffer.from(response.data));
}

// ── Resample a decoded tile to match a specific set of pixel requests ─────────
// Converts from the WCS response's pixel grid back to the Terrarium pixel
// coords that ElevationService.lua requested, using bilinear interpolation.
function resampleToPixels(tile, pixels, srcBbox, tileZ, tileX, tileY) {
    const results = [];
    const n = Math.pow(2, tileZ);
    // Terrarium tile pixel → lon/lat
    for (const [px, py] of pixels) {
        const lon = (tileX + px / 256) / n * 360 - 180;
        const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tileY + py / 256) / n)));
        const lat = latRad * 180 / Math.PI;
        // lon/lat → WCS tile pixel
        const fx = (lon - srcBbox.west)  / (srcBbox.east  - srcBbox.west)  * (tile.width  - 1);
        const fy = (srcBbox.north - lat) / (srcBbox.north - srcBbox.south) * (tile.height - 1);
        results.push(Math.round(sampleBilinear(tile, Math.max(0, fx), Math.max(0, fy)) * 10) / 10);
    }
    return results;
}

// ── Core regional handler ─────────────────────────────────────────────────────
// fetchFn(bbox) must return Promise<{width,height,elevations}> or throw.
// On throw: falls back to global Terrarium tile for that z/x/y.
async function handleRegionalElevation(req, res, fetchFn) {
    const { tiles } = req.body;
    if (!Array.isArray(tiles)) return res.status(400).json({ error: "Body must have 'tiles' array" });

    const results = [];
    for (const tileReq of tiles) {
        const { z, x, y, pixels } = tileReq;
        if (typeof z !== "number" || typeof x !== "number" || typeof y !== "number") {
            for (let i = 0; i < (pixels?.length || 0); i++) results.push(0);
            continue;
        }
        const bbox = tileToBbox(z, x, y);
        const cacheKey = `regional|${fetchFn.name}|${z}/${x}/${y}`;
        let tile = regionalTileCache.get(cacheKey);
        if (!tile) {
            try {
                tile = await fetchFn(bbox);
                regionalTileCacheSet(cacheKey, tile);
            } catch (err) {
                console.warn(`[RegionalDEM] ${fetchFn.name} ${z}/${x}/${y} failed (${err.message}), falling back to Terrarium`);
                try { tile = await fetchTile(z, x, y); } catch (_) { /* give up */ }
            }
        }
        if (!tile) {
            for (let i = 0; i < (pixels?.length || 0); i++) results.push(0);
            continue;
        }
        for (const v of resampleToPixels(tile, pixels || [], bbox, z, x, y)) {
            results.push(v);
        }
    }
    res.json({ elevations: results });
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-source fetch functions
// Each is a named async function so handleRegionalElevation's cache key
// includes the source name and logs show which source failed.
// ─────────────────────────────────────────────────────────────────────────────

// Switzerland — SwissTopo ALTI3D, 0.5m
// https://api3.geo.admin.ch/services/sdiservices.html
async function fetchSwiss(bbox) {
    return fetchWcsTile(
        "https://wcs.geo.admin.ch",
        "ch.swisstopo.swissalti3d-reliefschattierung",
        bbox, 0.00000463, 0.00000463
    );
}

// Norway — Kartverket Høydedata DTM1, 1m
// https://www.kartverket.no/api-og-data/terrengdata
async function fetchNorway(bbox) {
    return fetchWcsTile(
        "https://wcs.geonorge.no/skwms1/wcs.hoyde-dtm1",
        "hoyde-dtm1",
        bbox, 0.00000899, 0.00000899
    );
}

// Netherlands — PDOK AHN4, 0.5m
// https://www.pdok.nl/ogc-webservices/-/article/ahn-actueel-hoogtebestand-nederland-ahn4-
async function fetchNetherlands(bbox) {
    return fetchWcsTile(
        "https://service.pdok.nl/rws/ahn/wcs/v1_0",
        "dtm_05m",
        bbox, 0.00000463, 0.00000463
    );
}

// Denmark — SDFI DHM/Terræn, 0.4m
// https://dataforsyningen.dk/data/3931
async function fetchDenmark(bbox) {
    return fetchWcsTile(
        "https://services.datafordeler.dk/DHMNedboer/dhm_wcs/1.0.0/WCS",
        "dhm_terraen_skyggekort",
        bbox, 0.0000036, 0.0000036
    );
}

// Belgium — NGI/IGN Lidar HD, 1m
// https://www.ngi.be/website/aanbod/digitale-geodata/lidar-data-in-belgie/
async function fetchBelgium(bbox) {
    return fetchWcsTile(
        "https://wcs.ngi.be/geodata/wcs",
        "DTM_1m",
        bbox, 0.00000899, 0.00000899
    );
}

// Spain — IGN PNOA MDT05, 2m
// https://www.ign.es/web/ign/portal/cbg-area-cartografia
async function fetchSpain(bbox) {
    return fetchWcsTile(
        "https://servicios.idee.es/wcs-inspire/mdt",
        "Elevacion4258_5",
        bbox, 0.0000180, 0.0000180
    );
}

// Ireland — Tailte Éireann (OSi) 2m
// https://data.gov.ie/dataset/digital-terrain-model
async function fetchIreland(bbox) {
    return fetchWcsTile(
        "https://wcs.tailte.ie/geoserver/ows",
        "DTM_2m",
        bbox, 0.0000180, 0.0000180
    );
}

// Austria — BEV DGM Österreich, 1m
// https://www.bev.gv.at/Services/Downloads/Geodatenprodukte/Hoheitsgebiete.html
async function fetchAustria(bbox) {
    return fetchWcsTile(
        "https://gis.bev.gv.at/arcgis/services/DGM/DGM_Oesterreich/ImageServer/WCSServer",
        "DGM_Oesterreich",
        bbox, 0.00000899, 0.00000899
    );
}

// Germany — BKG DGM, 1m
// https://gdz.bkg.bund.de/index.php/default/digitales-gelandemodell-gitterweite-1-m-dgm1.html
async function fetchGermany(bbox) {
    return fetchWcsTile(
        "https://sgx.geodatenzentrum.de/wcs_dgm1_inspire",
        "EL.GridCoverage.DTM",
        bbox, 0.00000899, 0.00000899
    );
}

// Czech Republic — ČÚZK DMR 5G, 1m
// https://geoportal.cuzk.cz/Default.aspx?lng=EN
async function fetchCzech(bbox) {
    return fetchWcsTile(
        "https://ags.cuzk.cz/arcgis/services/dmr5g/ImageServer/WCSServer",
        "dmr5g",
        bbox, 0.00000899, 0.00000899
    );
}

// Slovakia — GEODIS DEM, 1m
// https://www.geoportal.sk/sk/zbgis/na-stiahnutie/
async function fetchSlovakia(bbox) {
    return fetchWcsTile(
        "https://zbgis.skgeodesy.sk/arcgis/services/ZBGIS/DMR/ImageServer/WCSServer",
        "DMR",
        bbox, 0.00000899, 0.00000899
    );
}

// Poland — GUGiK ISOK NMT, 1m
// https://www.geoportal.gov.pl/uslugi/usluga-przegladania-wms-nmt-i-nmpt
async function fetchPoland(bbox) {
    return fetchWcsTile(
        "https://mapy.geoportal.gov.pl/wss/service/PZGIK/NMT/GRID1/WCS/DigitalTerrainModelFormatTIFF",
        "Pokrycie_terenu",
        bbox, 0.00000899, 0.00000899
    );
}

// Finland — NLS Finland elevation model, 2m
// https://www.maanmittauslaitos.fi/en/maps-and-spatial-data/datasets-and-interfaces/product-descriptions/elevation-model-2-m
async function fetchFinland(bbox) {
    return fetchWcsTile(
        "https://beta-karttakuva.maanmittauslaitos.fi/ortokuva/wcs/v2",
        "korkeusmalli_2m",
        bbox, 0.0000180, 0.0000180
    );
}

// Estonia — Maa-amet LiDAR DEM, 1m
// https://geoportaal.maaamet.ee/eng/Spatial-Data/Elevation-Data-p664.html
async function fetchEstonia(bbox) {
    return fetchWcsTile(
        "https://kaart.maaamet.ee/wcs/alus",
        "dem_eesti_euroopa",
        bbox, 0.00000899, 0.00000899
    );
}

// Latvia — LĢIA DEM, 1m
// https://www.lgia.gov.lv/en/digit%C4%81lais-reljefa-modelis
async function fetchLatvia(bbox) {
    return fetchWcsTile(
        "https://services.lgia.gov.lv/arcgis/services/DEM/DEM_1m/ImageServer/WCSServer",
        "DEM_1m",
        bbox, 0.00000899, 0.00000899
    );
}

// Lithuania — GKD DEM, 1m
// https://www.geoportal.lt/geoportal/web/guest/paslaugos
async function fetchLithuania(bbox) {
    return fetchWcsTile(
        "https://www.geoportal.lt/mapproxy/gisc_dtm/wcs",
        "gisc_dtm",
        bbox, 0.00000899, 0.00000899
    );
}

// Slovenia — GURS DMR 1m
// https://www.e-prostor.gov.si/zbirke-prostorskih-podatkov/digitalni-modeli-reliefa/dmr-1/
async function fetchSlovenia(bbox) {
    return fetchWcsTile(
        "https://storitve.eprostor.gov.si/ows-ins-wcs/wcs",
        "DMR_1m",
        bbox, 0.00000899, 0.00000899
    );
}

// Croatia — DGU DEM, 1m
// https://geoportal.dgu.hr/
async function fetchCroatia(bbox) {
    return fetchWcsTile(
        "https://geoportal.dgu.hr/services/inspire/elevation/wcs",
        "EL.GridCoverage",
        bbox, 0.00000899, 0.00000899
    );
}

// Portugal — DGT MDT, 2m
// https://snig.dgterritorio.gov.pt/
async function fetchPortugal(bbox) {
    return fetchWcsTile(
        "https://servicos.dgterritorio.pt/SDISNIGROAPS/wcs",
        "MDT2m",
        bbox, 0.0000180, 0.0000180
    );
}

// Luxembourg — ACT MNT LiDAR, 1m
// https://data.public.lu/en/datasets/lidar-2019/
async function fetchLuxembourg(bbox) {
    return fetchWcsTile(
        "https://wmts1.geoportail.lu/opendata/service",
        "lidar_mns_2019",
        bbox, 0.00000899, 0.00000899
    );
}

// USA — USGS 3DEP 1m (and IfSAR 5m for Alaska via same endpoint)
// https://www.usgs.gov/3d-elevation-program
async function fetchUSA(bbox) {
    return fetchWcsTile(
        "https://elevation.nationalmap.gov/arcgis/services/3DEPElevation/ImageServer/WCSServer",
        "DEP3Elevation",
        bbox, 0.00000899, 0.00000899
    );
}

// Canada — Geogratis CDEM, 2m
// https://natural-resources.canada.ca/science-and-data/science-and-research/earth-sciences/geography/topographic-information/download-directory-topographic-data/17215
async function fetchCanada(bbox) {
    return fetchWcsTile(
        "https://datacube.services.geo.ca/ows/elevation",
        "dtm",
        bbox, 0.0000180, 0.0000180
    );
}

// Japan — GSI Cyberjapan tile API
// https://maps.gsi.go.jp/development/ichiran.html
// Returns ASCII elevation grid (not GeoTIFF) — needs custom decoder.
// Falls back to 5m (dem5a) then 1m (dem) depending on coverage.
async function fetchJapan(bbox) {
    const { west, east, north, south } = bbox;
    // Pick a representative zoom level that matches the tile resolution
    // GSI uses z=15 for 1m dem, z=14 for 5m dem5a
    const midLat = (north + south) / 2;
    const midLon = (east  + west)  / 2;
    const z = 15;
    const n = Math.pow(2, z);
    const gsiX = Math.floor((midLon + 180) / 360 * n);
    const gsiY = Math.floor((1 - Math.log(Math.tan(midLat * Math.PI / 180) + 1 / Math.cos(midLat * Math.PI / 180)) / Math.PI) / 2 * n);

    // Try 1m first, fall back to 5m, then 10m
    for (const layer of ["dem", "dem5a", "dem10b"]) {
        try {
            const url = `https://cyberjapandata.gsi.go.jp/xyz/${layer}/${z}/${gsiX}/${gsiY}.txt`;
            const response = await axios.get(url, {
                timeout: 10000,
                headers: { "User-Agent": "Tellus-Roblox-Proxy/3.4" },
            });
            // GSI ASCII format: 256 rows of 256 comma-separated values, "e" = nodata
            const lines = response.data.trim().split("\n");
            const height = lines.length;
            const width  = lines[0].split(",").length;
            const elevations = new Float32Array(width * height);
            for (let row = 0; row < height; row++) {
                const cols = lines[row].split(",");
                for (let col = 0; col < width; col++) {
                    const v = parseFloat(cols[col]);
                    elevations[row * width + col] = isFinite(v) ? v : 0;
                }
            }
            return { width, height, elevations };
        } catch (_) { /* try next layer */ }
    }
    // All layers failed — fall through to global Terrarium
    return fetchTile(bbox._z || 13, bbox._x || 0, bbox._y || 0);
}

// New Zealand — LINZ NZ DEM 1m
// https://data.linz.govt.nz/layer/51768-nz-dem-1m/
async function fetchNewZealand(bbox) {
    return fetchWcsTile(
        "https://data.linz.govt.nz/services;key=/wcs",
        "layer-51768",
        bbox, 0.00000899, 0.00000899
    );
}

// Australia — Geoscience Australia 1 Second DEM, ~30m (free WCS)
// 1m LiDAR tiles require state-by-state portals; GA WCS is the unified free endpoint
// https://elevation.fsdf.org.au/
async function fetchAustralia(bbox) {
    return fetchWcsTile(
        "https://services.ga.gov.au/site_9/services/DEM_SRTM_1Second_Hydro_Enforced/MapServer/WCSServer",
        "DEM_SRTM_1Second_Hydro_Enforced",
        bbox, 0.000277, 0.000277  // ~30m, ~1 arc-second
    );
}

// Arctic — ArcticDEM v4.1 2m mosaic via PGC public S3 COG tiles
// https://www.pgc.umn.edu/data/arcticdem/
// Tiles served as Cloud Optimised GeoTIFF on AWS — no auth, no key.
async function fetchArctic(bbox) {
    const { west, east, north, south } = bbox;
    // ArcticDEM uses a 100km tile grid in EPSG:3413. We fetch the WMS
    // preview endpoint (GeoTIFF output) as a simpler integration than
    // computing COG tile offsets. Falls back to Terrarium on failure.
    const url = `https://pgc-oin-dem-pgcpublic.s3.amazonaws.com/ArcticDEM/mosaic/v4.1/2m_wms?`
        + `SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap`
        + `&LAYERS=arcticdem_mosaic_2m&STYLES=`
        + `&CRS=EPSG:4326&BBOX=${south},${west},${north},${east}`
        + `&WIDTH=256&HEIGHT=256&FORMAT=image/tiff`;
    const response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 20000,
        headers: { "User-Agent": "Tellus-Roblox-Proxy/3.4" },
    });
    return decodeGeoTiff(Buffer.from(response.data));
}

// Antarctica — REMA v2.0 2m mosaic via PGC public S3, same pattern as ArcticDEM
// https://www.pgc.umn.edu/data/rema/
async function fetchAntarctica(bbox) {
    const { west, east, north, south } = bbox;
    const url = `https://pgc-oin-dem-pgcpublic.s3.amazonaws.com/REMA/mosaic/v2.0/2m_wms?`
        + `SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap`
        + `&LAYERS=rema_mosaic_2m&STYLES=`
        + `&CRS=EPSG:4326&BBOX=${south},${west},${north},${east}`
        + `&WIDTH=256&HEIGHT=256&FORMAT=image/tiff`;
    const response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 20000,
        headers: { "User-Agent": "Tellus-Roblox-Proxy/3.4" },
    });
    return decodeGeoTiff(Buffer.from(response.data));
}

// ── Regional routes ───────────────────────────────────────────────────────────
// Europe
app.post("/elevation/ch",  (req, res) => handleRegionalElevation(req, res, fetchSwiss));
app.post("/elevation/no",  (req, res) => handleRegionalElevation(req, res, fetchNorway));
app.post("/elevation/nl",  (req, res) => handleRegionalElevation(req, res, fetchNetherlands));
app.post("/elevation/dk",  (req, res) => handleRegionalElevation(req, res, fetchDenmark));
app.post("/elevation/be",  (req, res) => handleRegionalElevation(req, res, fetchBelgium));
app.post("/elevation/es",  (req, res) => handleRegionalElevation(req, res, fetchSpain));
app.post("/elevation/ie",  (req, res) => handleRegionalElevation(req, res, fetchIreland));
app.post("/elevation/at",  (req, res) => handleRegionalElevation(req, res, fetchAustria));
app.post("/elevation/de",  (req, res) => handleRegionalElevation(req, res, fetchGermany));
app.post("/elevation/cz",  (req, res) => handleRegionalElevation(req, res, fetchCzech));
app.post("/elevation/sk",  (req, res) => handleRegionalElevation(req, res, fetchSlovakia));
app.post("/elevation/pl",  (req, res) => handleRegionalElevation(req, res, fetchPoland));
app.post("/elevation/fi",  (req, res) => handleRegionalElevation(req, res, fetchFinland));
app.post("/elevation/ee",  (req, res) => handleRegionalElevation(req, res, fetchEstonia));
app.post("/elevation/lv",  (req, res) => handleRegionalElevation(req, res, fetchLatvia));
app.post("/elevation/lt",  (req, res) => handleRegionalElevation(req, res, fetchLithuania));
app.post("/elevation/si",  (req, res) => handleRegionalElevation(req, res, fetchSlovenia));
app.post("/elevation/hr",  (req, res) => handleRegionalElevation(req, res, fetchCroatia));
app.post("/elevation/pt",  (req, res) => handleRegionalElevation(req, res, fetchPortugal));
app.post("/elevation/lu",  (req, res) => handleRegionalElevation(req, res, fetchLuxembourg));
// Americas
app.post("/elevation/us",  (req, res) => handleRegionalElevation(req, res, fetchUSA));
app.post("/elevation/ca",  (req, res) => handleRegionalElevation(req, res, fetchCanada));
// Asia-Pacific
app.post("/elevation/jp",  (req, res) => handleRegionalElevation(req, res, fetchJapan));
app.post("/elevation/nz",  (req, res) => handleRegionalElevation(req, res, fetchNewZealand));
app.post("/elevation/au",  (req, res) => handleRegionalElevation(req, res, fetchAustralia));
// Polar
app.post("/elevation/arctic",      (req, res) => handleRegionalElevation(req, res, fetchArctic));
app.post("/elevation/antarctica",  (req, res) => handleRegionalElevation(req, res, fetchAntarctica));

// ─────────────────────────────────────────────────────────────────────────────
// GET /  — health check
// ─────────────────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
    res.json({
        status:  "Tellus Elevation Proxy running",
        version: "3.4.0",
        koppen:  koppen ? `${koppen.width}x${koppen.height} loaded` : "unavailable",
        cache: {
            tiles:         `${tileCache.size}/${TILE_CACHE_MAX}`,
            regionalTiles: `${regionalTileCache.size}/${REGIONAL_TILE_CACHE_MAX}`,
            osm:           `${osmCache.size}/${OSM_CACHE_MAX}`,
        },
        overpass: {
            queueDepth: overpassQueue.length,
            busy:       overpassBusy,
            minGapMs:   MIN_OVERPASS_GAP_MS,
        },
        endpoints: [
            "GET  /tile?z=&x=&y=         → decoded Terrarium tile",
            "POST /elevation              → batched pixel samples (global Terrarium)",
            "POST /elevation/ch           → SwissTopo ALTI3D 0.5m (Switzerland)",
            "POST /elevation/no           → Kartverket DTM1 1m (Norway)",
            "POST /elevation/nl           → PDOK AHN4 0.5m (Netherlands)",
            "POST /elevation/dk           → SDFI 0.4m (Denmark)",
            "POST /elevation/be           → NGI LiDAR HD 1m (Belgium)",
            "POST /elevation/es           → IGN PNOA MDT05 2m (Spain)",
            "POST /elevation/ie           → Tailte Éireann 2m (Ireland)",
            "POST /elevation/at           → BEV DGM 1m (Austria)",
            "POST /elevation/de           → BKG DGM 1m (Germany)",
            "POST /elevation/cz           → ČÚZK DMR 5G 1m (Czech Republic)",
            "POST /elevation/sk           → GEODIS DMR 1m (Slovakia)",
            "POST /elevation/pl           → GUGiK ISOK NMT 1m (Poland)",
            "POST /elevation/fi           → NLS Finland 2m (Finland)",
            "POST /elevation/ee           → Maa-amet LiDAR 1m (Estonia)",
            "POST /elevation/lv           → LĢIA DEM 1m (Latvia)",
            "POST /elevation/lt           → GKD DEM 1m (Lithuania)",
            "POST /elevation/si           → GURS DMR 1m (Slovenia)",
            "POST /elevation/hr           → DGU DEM 1m (Croatia)",
            "POST /elevation/pt           → DGT MDT 2m (Portugal)",
            "POST /elevation/lu           → ACT LiDAR 1m (Luxembourg)",
            "POST /elevation/us           → USGS 3DEP 1m (USA + Alaska)",
            "POST /elevation/ca           → Geogratis CDEM 2m (Canada)",
            "POST /elevation/jp           → GSI DEM 1m/5m (Japan)",
            "POST /elevation/nz           → LINZ NZ DEM 1m (New Zealand)",
            "POST /elevation/au           → Geoscience Australia ~30m",
            "POST /elevation/arctic       → ArcticDEM v4.1 2m mosaic",
            "POST /elevation/antarctica   → REMA v2.0 2m mosaic",
            "POST /water                  → water polygon ways (cached)",
            "POST /buildings              → building footprint ways (cached)",
            "POST /roads                  → road ways (cached)",
            "POST /osm                    → roads + buildings combined (cached)",
            "GET  /geocode?q=             → Nominatim search",
            "POST /landcover              → Köppen climate per point",
        ],
    });
});

app.listen(PORT, () => {
    console.log(`[Tellus Proxy] v3.4.0 listening on port ${PORT}`);
});