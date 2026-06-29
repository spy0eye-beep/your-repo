/**
 * proxy_server.js
 * Tellus Elevation & OSM Proxy — Node.js
 *
 * Matches TerrainTilesElevationSource.java Terrarium decode exactly:
 * elevation = (R * 256 + G + B / 256) - 32768
 *
 * ENDPOINTS:
 * GET  /              → health check
 * GET  /tile?z=&x=&y= → full 256×256 tile as { z, x, y, width, height, elevations[] }
 * POST /elevation     → batch pixel samples { tiles: [{z,x,y,pixels:[[px,py],...]}] }
 * POST /osm           → fetches OpenStreetMap building and road vectors
 */

const express = require("express");
const axios   = require("axios");
const sharp   = require("sharp");
const cors    = require("cors");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ── Terrarium decode (matches TerrainTilesElevationSource.java) ───────────────
function terrariumToMeters(r, g, b) {
    return (r * 256 + g + b / 256) - 32768;
}

// ── Tile cache (in-memory, LRU-style by count) ────────────────────────────────
const tileCache = new Map();
const CACHE_MAX = 200;  // max tiles kept in memory

function cacheSet(key, value) {
    if (tileCache.size >= CACHE_MAX) {
        // Evict oldest
        const oldest = tileCache.keys().next().value;
        tileCache.delete(oldest);
    }
    tileCache.set(key, value);
}

// ── Fetch and decode a tile ───────────────────────────────────────────────────
async function fetchTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (tileCache.has(key)) {
        return tileCache.get(key);
    }

    const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

    const response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 10000,
        headers: {
            "User-Agent": "Tellus-Roblox-Proxy/1.0",
        }
    });

    const { data, info } = await sharp(Buffer.from(response.data))
        .ensureAlpha(0)
        .raw()
        .toBuffer({ resolveWithObject: true });

    const width    = info.width;    // always 256
    const height   = info.height;   // always 256
    const channels = info.channels; // 4 (RGBA after ensureAlpha)

    // Build flat elevation array [row * 256 + col] in metres
    const elevations = new Float32Array(width * height);
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const idx = (row * width + col) * channels;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            elevations[row * width + col] = terrariumToMeters(r, g, b);
        }
    }

    const result = { width, height, elevations };
    cacheSet(key, result);
    return result;
}

// ── Bilinear interpolation ─────────────────────────────────────────────────────
function sampleBilinear(tile, px, py) {
    const { width, height, elevations } = tile;
    const x0 = Math.floor(px);
    const y0 = Math.floor(py);
    const x1 = Math.min(x0 + 1, width - 1);
    const y1 = Math.min(y0 + 1, height - 1);
    const tx = px - x0;
    const ty = py - y0;

    const h00 = elevations[y0 * width + x0] || 0;
    const h10 = elevations[y0 * width + x1] || 0;
    const h01 = elevations[y1 * width + x0] || 0;
    const h11 = elevations[y1 * width + x1] || 0;

    const lo = h00 + (h10 - h00) * tx;
    const hi = h01 + (h11 - h01) * tx;
    return lo + (hi - lo) * ty;
}

// ── GET /tile?z=&x=&y= ───────────────────────────────────────────────────────
app.get("/tile", async (req, res) => {
    const z = parseInt(req.query.z);
    const x = parseInt(req.query.x);
    const y = parseInt(req.query.y);

    if (isNaN(z) || isNaN(x) || isNaN(y)) {
        return res.status(400).json({ error: "Missing z, x, y" });
    }
    if (z < 0 || z > 15) {
        return res.status(400).json({ error: "Zoom out of range 0-15" });
    }

    try {
        const tile = await fetchTile(z, x, y);
        res.json({
            z, x, y,
            width:      tile.width,
            height:     tile.height,
            elevations: Array.from(tile.elevations).map(v => Math.round(v * 10) / 10),
        });
    } catch (err) {
        console.error(`[Proxy] /tile ${z}/${x}/${y} failed:`, err.message);
        res.status(500).json({ error: "Tile fetch failed", detail: err.message });
    }
});

// ── POST /elevation ───────────────────────────────────────────────────────────
app.post("/elevation", async (req, res) => {
    const { tiles } = req.body;

    if (!Array.isArray(tiles)) {
        return res.status(400).json({ error: "Body must have 'tiles' array" });
    }

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
            const clampedPx = Math.max(0, Math.min(tile.width - 1, px));
            const clampedPy = Math.max(0, Math.min(tile.height - 1, py));
            results.push(Math.round(sampleBilinear(tile, clampedPx, clampedPy) * 10) / 10);
        }
    }

    res.json({ elevations: results });
});

// ── POST /osm (Fetches Buildings & Roads) ────────────────────────────────────
app.post("/osm", async (req, res) => {
    const { minLat, minLon, maxLat, maxLon } = req.body;
    
    if (!minLat || !minLon || !maxLat || !maxLon) {
        return res.status(400).json({ error: "Missing bounding box" });
    }

    const query = `
        [out:json][timeout:25];
        (
          way["building"](${minLat},${minLon},${maxLat},${maxLon});
          way["highway"](${minLat},${minLon},${maxLat},${maxLon});
        );
        out center;
    `;

    try {
        const response = await axios.post('https://overpass-api.de/api/interpreter', query, {
            headers: { 'Content-Type': 'text/plain' }
        });
        
        const elements = response.data.elements || [];
        const buildings = [];
        const roads = [];

        elements.forEach(el => {
            if (el.tags && el.center) {
                if (el.tags.building) {
                    buildings.push({ lat: el.center.lat, lon: el.center.lon, name: el.tags.name || "Building" });
                } else if (el.tags.highway) {
                    roads.push({ lat: el.center.lat, lon: el.center.lon, type: el.tags.highway });
                }
            }
        });

        res.json({ buildings, roads });
    } catch (error) {
        console.error("[Proxy] /osm Fetch Error:", error.message);
        res.status(500).json({ error: "Failed to fetch OSM data" });
    }
});

// ── GET / — health check ──────────────────────────────────────────────────────
app.get("/", (_req, res) => {
    res.json({
        status:  "Tellus Elevation Proxy running",
        version: "2.1.0",
        cache:   `${tileCache.size}/${CACHE_MAX} tiles`,
        endpoints: [
            "GET  /tile?z=&x=&y=  → full decoded tile",
            "POST /elevation       → batch pixel samples",
            "POST /osm             → fetch buildings and roads"
        ]
    });
});

app.listen(PORT, () => {
    console.log(`[Tellus Proxy] Listening on port ${PORT}`);
});