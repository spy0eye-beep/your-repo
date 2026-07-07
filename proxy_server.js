/**
 * proxy_server.js  —  Tellus Elevation & OSM Proxy  (v3.2.0)
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
const LANDCOVER_URL = process.env.LANDCOVER_URL || "";

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
// POST /landcover
//
// If LANDCOVER_URL is configured, this forwards { points } to that service.
// Expected response: { classes: [{ esa: number, koppen: string }, ...] }.
// Without a provider, return a deterministic ESA/Koppen-style approximation
// so Roblox keeps using the real landcover path instead of disabling it.
// ─────────────────────────────────────────────────────────────────────────────
function approximateLandcover(lat, lon) {
    const a = Math.abs(lat);
    const n = Math.sin((lat * 12.9898 + lon * 78.233) * Math.PI / 180) * 43758.5453;
    const noise = n - Math.floor(n);

    let esa = 30;      // grassland
    let koppen = "Cfb";

    if (a >= 72) {
        esa = 70; koppen = "EF";       // permanent snow/ice
    } else if (a >= 62) {
        esa = noise > 0.35 ? 20 : 60; koppen = "ET";
    } else if (a >= 48) {
        esa = noise > 0.55 ? 10 : 30; koppen = "Dfb";
    } else if (a >= 35) {
        esa = noise > 0.4 ? 10 : 40; koppen = lat > 0 ? "Cfb" : "Cfa";
    } else if (a >= 17 && a <= 34 && noise > 0.18) {
        esa = noise > 0.65 ? 60 : 20; koppen = noise > 0.65 ? "BWh" : "BSh";
    } else if (a < 12) {
        esa = noise > 0.22 ? 10 : 90; koppen = noise > 0.22 ? "Af" : "Am";
    } else {
        esa = noise > 0.45 ? 10 : 30; koppen = "Aw";
    }

    return { esa, koppen };
}

app.post("/landcover", async (req, res) => {
    const points = req.body?.points;
    if (!Array.isArray(points)) {
        return res.status(400).json({ error: "Body must have 'points' array" });
    }

    if (LANDCOVER_URL) {
        try {
            const response = await axios.post(
                LANDCOVER_URL,
                { points },
                { timeout: 20000, headers: { "User-Agent": "Tellus-Roblox-Proxy/3.2" } }
            );
            const classes = Array.isArray(response.data?.classes) ? response.data.classes : [];
            if (classes.length === points.length) {
                return res.json({ classes });
            }
            console.warn("[Proxy] LANDCOVER_URL returned unexpected shape; using approximation");
        } catch (err) {
            console.warn("[Proxy] LANDCOVER_URL failed; using approximation:", err.message);
        }
    }

    const classes = points.map(pt => approximateLandcover(
        Math.max(-85.05112878, Math.min(85.05112878, Number(pt.lat) || 0)),
        Math.max(-180, Math.min(180, Number(pt.lon) || 0))
    ));
    res.json({ classes });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /  — health check
// ─────────────────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
    res.json({
        status:  "Tellus Elevation Proxy running",
        version: "3.2.0",
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
            "GET  /tile?z=&x=&y=    → decoded Terrarium tile",
            "POST /elevation         → batched pixel samples",
            "POST /water             → water polygon ways (cached)",
            "POST /buildings         → building footprint ways (cached)",
            "POST /roads             → road ways (cached)",
            "POST /osm               → roads + buildings combined (cached)",
            "GET  /geocode?q=        → Nominatim search",
            "POST /landcover         → ESA/Koppen classes (provider or approximation)",
        ],
    });
});

app.listen(PORT, () => {
    console.log(`[Tellus Proxy] v3.2.0 listening on port ${PORT}`);
});
