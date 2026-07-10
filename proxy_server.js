/**
 * proxy_server.js  â  Tellus Elevation & OSM Proxy  (v3.2.0)
 * Node.js / Express, deploy on Railway.
 *
 * What changed in v3.2 vs v3.0/3.1:
 *
 *   - FIX: Overpass bbox cache now keys on the FULL requested extent
 *     (all four corners, 3-decimal rounding) instead of just the snapped
 *     SW cell corner. The old key collided for different bboxes inside
 *     the same 0.1° cell, silently serving one caller another caller’s
 *     data (missing roads/buildings near cell edges).
 *   - Cache hits now refresh LRU recency (hot cells survive eviction).
 *
 * What changed in v3 vs v2:
 *
 *   1. Overpass request queue + throttle
 *      All /osm, /water, and /buildings calls now go through a single
 *      async queue with a MIN_OVERPASS_GAP_MS gap between dispatches.
 *      No matter how many Roblox servers are running, this proxy sends
 *      at most one Overpass request per gap window â eliminating the
 *      429/504 storms that came from concurrent game-server calls.
 *
 *   2. Overpass bbox response cache
 *      Responses are cached by bbox key (v3.2: keyed on the FULL requested
 *      extent — all four corners, 3-decimal rounding). A hit returns
 *      instantly without touching Overpass. LRU eviction at OSM_CACHE_MAX.
 *
 *   3. /water endpoint
 *      New POST /water â same bbox body as /osm â returns closed water
 *      polygon ways (natural=water, waterway=riverbank, natural=beach).
 *      Matches WaterMaskService.lua's Overpass query exactly so it can
 *      call the proxy instead of Overpass directly.
 *
 *   4. /buildings endpoint
 *      New POST /buildings â bbox body â returns building footprint ways
 *      with tags. Lets BuildingService.lua call the proxy instead of
 *      Overpass directly.
 *
 *   5. /osm now returns ways in the shape OsmService/OsmGenerator expect
 *      (was already fixed in v2 with "out geom;" â kept as-is).
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

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Terrarium decode
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function terrariumToMeters(r, g, b) {
    return (r * 256 + g + b / 256) - 32768;
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Tile cache (elevation PNG tiles, LRU by insertion order)
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const tileCache   = new Map();
const TILE_CACHE_MAX = 200;

function tileCacheSet(key, value) {
    if (tileCache.size >= TILE_CACHE_MAX) {
        tileCache.delete(tileCache.keys().next().value);
    }
    tileCache.set(key, value);
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Overpass bbox response cache
//
// Key: "<endpoint>|<snappedSouth>,<snappedWest>" so /water and /buildings
// results are cached independently even for the same bbox.
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const osmCache     = new Map();
const OSM_CACHE_MAX = 500;  // ~50 MB at typical response sizes

function osmCacheSet(key, value) {
    if (osmCache.size >= OSM_CACHE_MAX) {
        osmCache.delete(osmCache.keys().next().value);
    }
    osmCache.set(key, value);
}

/** LRU-aware get: a hit is re-inserted so hot entries survive eviction. */
function osmCacheGet(key) {
    if (!osmCache.has(key)) return undefined;
    const value = osmCache.get(key);
    osmCache.delete(key);
    osmCache.set(key, value);
    return value;
}

/**
 * Cache key from the FULL requested extent, rounded to 3 decimals (~111 m).
 *
 * v3.2 FIX: the old key was only the bbox's snapped SW cell corner while the
 * Overpass query used the raw requested extent. Two different bboxes landing
 * in the same 0.1Â° cell therefore collided on the key â the second caller got
 * the first caller's data, which did not cover its actual area (missing
 * roads/buildings near cell edges). Keying on all four (rounded) corners
 * makes key and data always describe the same extent. WaterMaskService's
 * cell-aligned /water requests still dedupe perfectly: the same cell always
 * produces the same four corners, regardless of tiny float noise (which the
 * 3-decimal rounding absorbs; `+ 0` normalizes any -0).
 */
function bboxCacheKey(endpoint, s, w, n, e) {
    const f = (v) => (v + 0).toFixed(3);
    return `${endpoint}|${f(s)},${f(w)},${f(n)},${f(e)}`;
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Overpass request queue
//
// All calls to postOverpass() are serialized through this queue with a
// MIN_GAP_MS minimum spacing. No concurrent Overpass calls ever leave this
// server, regardless of how many Roblox game-servers are calling us.
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const MIN_OVERPASS_GAP_MS   = 1100;  // ~1 req/sec â well within Overpass limits
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

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Parse bbox from request body, validate, return {minLat,minLon,maxLat,maxLon}
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Fetch + decode an elevation tile (cached)
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Bilinear interpolation over a decoded tile
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// GET /tile?z=&x=&y=
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// POST /elevation  â  batch pixel samples (unchanged from v2)
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// POST /water  â NEW
//
// Body: { minLat, minLon, maxLat, maxLon }
// Returns: { elements: [...] }  â same raw Overpass JSON, cached by cell.
//
// WaterMaskService.lua should POST here instead of hitting Overpass directly.
// The query matches WaterMaskService's fetchCell() query exactly:
//   natural=water, waterway=riverbank, natural=beach (closed polygon ways),
//   PLUS waterway=river/stream/canal/drain (open linestrings â rivers,
//   streams, and waterfalls are almost always tagged this way, not as a
//   closed riverbank polygon). WaterMaskService.lua buffers these lines by
//   their tagged/default width into a synthetic polygon client-side, since
//   Overpass has no server-side buffering. Without this, any narrow water
//   feature not wrapped in a riverbank polygon (most rivers/streams on
//   Earth, including every waterfall) was completely invisible in-game.
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.post("/water", async (req, res) => {
    const bbox = parseBbox(req.body);
    if (bbox.error) return res.status(400).json({ error: bbox.error });
    const { minLat, minLon, maxLat, maxLon } = bbox;

    const cacheKey = bboxCacheKey("water", minLat, minLon, maxLat, maxLon);

    const cached = osmCacheGet(cacheKey);
    if (cached) {
        return res.json(cached);
    }

    const query = `[out:json][timeout:25];(way["natural"="water"](${minLat},${minLon},${maxLat},${maxLon});way["waterway"="riverbank"](${minLat},${minLon},${maxLat},${maxLon});way["natural"="beach"](${minLat},${minLon},${maxLat},${maxLon});way["waterway"~"^(river|stream|canal|drain)$"](${minLat},${minLon},${maxLat},${maxLon}););out body;>;out skel qt;`;

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

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// POST /buildings  â NEW
//
// Body: { minLat, minLon, maxLat, maxLon }
// Returns raw Overpass JSON (nodes + ways with building tags), cached by cell.
//
// BuildingService.lua should POST here instead of Overpass directly.
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.post("/buildings", async (req, res) => {
    const bbox = parseBbox(req.body);
    if (bbox.error) return res.status(400).json({ error: bbox.error });
    const { minLat, minLon, maxLat, maxLon } = bbox;

    const cacheKey = bboxCacheKey("buildings", minLat, minLon, maxLat, maxLon);

    const cached = osmCacheGet(cacheKey);
    if (cached) {
        return res.json(cached);
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

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// POST /osm  â  roads + buildings (kept from v2, now runs through the queue)
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.post("/osm", async (req, res) => {
    const bbox = parseBbox(req.body);
    if (bbox.error) return res.status(400).json({ error: bbox.error });
    const { minLat, minLon, maxLat, maxLon } = bbox;

    const cacheKey = bboxCacheKey("osm", minLat, minLon, maxLat, maxLon);

    const cached = osmCacheGet(cacheKey);
    if (cached) {
        return res.json(cached);
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

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// POST /roads  â roads-only (for OsmService.lua if you want to split it out)
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const ROAD_FILTER = "motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|service";

app.post("/roads", async (req, res) => {
    const bbox = parseBbox(req.body);
    if (bbox.error) return res.status(400).json({ error: bbox.error });
    const { minLat, minLon, maxLat, maxLon } = bbox;

    const cacheKey = bboxCacheKey("roads", minLat, minLon, maxLat, maxLon);

    const cached = osmCacheGet(cacheKey);
    if (cached) {
        return res.json(cached);
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

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// GET /geocode
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// KÃ¶ppenâGeiger climate raster (packed binary, mode-downsampled to 0.0333Â°)
//
// koppen_packed.bin.gz is a gzipped, self-describing grid built from the
// Tellus mod's koppen_geiger_0p00833333.tif (43200x21600 uint8, values
// 0..30). We downsampled 4x by DOMINANT non-zero class per block â so a
// mostly-land cell keeps its real climate even with a sliver of nodata â
// giving a 10800x5400 grid (~58MB raw, ~0.9MB gzipped, decompressed into
// memory once on boot). Value 0 = nodata/ocean.
//
// Header (little-endian): 4s magic "KPKG", u16 version, u32 width,
// u32 height, f64 originLon, f64 originLat, f64 degPerPixel, f64 factor.
// Sampling is plain equirectangular: px=(lon-originLon)/deg,
// py=(originLat-lat)/deg â no projection math needed.
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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
        console.log(`[Tellus Proxy] KÃ¶ppen raster loaded: ${width}x${height} @ ${deg.toFixed(4)}Â°/px`);
    } catch (err) {
        console.warn("[Tellus Proxy] KÃ¶ppen raster unavailable â /landcover will return null koppen:", err.message);
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

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// POST /landcover  â real KÃ¶ppen climate per point (item: biome realism)
//
// Body: { points: [{lat, lon}, ...] }
// Returns: { classes: [{esa, koppen}, ...] } in the SAME order as points.
//
// esa: we don't ship an ESA WorldCover raster (10m, terabytes), so esa is
//   left at 0 ("no data") and the Lua BiomeClassification uses its
//   esa=NONE fallback rows keyed on KÃ¶ppen alone â still a massive upgrade
//   over the old latitude-only guess. Wire a real ESA source here later and
//   the Lua side needs no changes.
// koppen: the KÃ¶ppenâGeiger code string ("Af", "BWh", ...) or null (ocean/
//   nodata) â the Lua side treats null as "use latitude fallback".
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// GET /  â health check
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get("/", (_req, res) => {
    res.json({
        status:  "Tellus Elevation Proxy running",
        version: "3.2.0",
        koppen:  koppen ? `${koppen.width}x${koppen.height} loaded` : "unavailable",
        cache: {
            tiles: `${tileCache.size}/${TILE_CACHE_MAX}`,
            osm:   `${osmCache.size}/${OSM_CACHE_MAX}`,
        },
        overpass: {
            queueDepth:    overpassQueue.length,
            busy:          overpassBusy,
            minGapMs:      MIN_OVERPASS_GAP_MS,
        },
        endpoints: [
            "GET  /tile?z=&x=&y=    â decoded Terrarium tile",
            "POST /elevation         â batched pixel samples",
            "POST /water             â water polygon ways (cached)",
            "POST /buildings         â building footprint ways (cached)",
            "POST /roads             â road ways (cached)",
            "POST /osm               â roads + buildings combined (cached)",
            "GET  /geocode?q=        â Nominatim search",
            "POST /landcover         â KÃ¶ppen climate per point",
        ],
    });
});

app.listen(PORT, () => {
    console.log(`[Tellus Proxy] v3.2.0 listening on port ${PORT}`);
});