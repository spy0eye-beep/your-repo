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
            if (status === 429 || status === 504) {
                const wait = status === 429 ? 60000 : OVERPASS_RETRY_DELAY;
                console.warn(`[Overpass] ${status} attempt ${attempt} via proxy ${(_wsIdx-1) % webshareAgents.length}, waiting ${wait}ms`);
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

function postOverpass(query) {
    return new Promise((resolve, reject) => {
        overpassQueue.push({ query, resolve, reject });
        _runNextOverpass();
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse bbox from request body
// ─────────────────────────────────────────────────────────────────────────────
function parseBbox(body) {
    const { minLat, minLon, maxLat, maxLon } = body;
    if (minLat == null || minLon == null || maxLat == null || maxLon == null)
        return { error: "Missing bounding box (minLat, minLon, maxLat, maxLon)" };
    const s = parseFloat(minLat), w = parseFloat(minLon);
    const n = parseFloat(maxLat), e = parseFloat(maxLon);
    if ([s, w, n, e].some(isNaN)) return { error: "Bounding box values must be numbers" };
    return { minLat: s, minLon: w, maxLat: n, maxLon: e };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch + decode a Terrarium elevation tile (cached)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (tileCache.has(key)) return tileCache.get(key);

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
            elevations[row * width + col] = terrariumToMeters(data[idx], data[idx+1], data[idx+2]);
        }
    }

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
    const { tiles } = req.body;
    if (!Array.isArray(tiles)) return res.status(400).json({ error: "Body must have 'tiles' array" });

    const results = [];
    for (const tileReq of tiles) {
        const { z, x, y, pixels } = tileReq;
        if (typeof z!=="number"||typeof x!=="number"||typeof y!=="number") {
            for (let i=0;i<(pixels?.length||0);i++) results.push(0); continue;
        }
        let tile;
        try { tile = await fetchTile(z, x, y); }
        catch (err) {
            console.error(`[Proxy] /elevation tile ${z}/${x}/${y} failed:`, err.message);
            for (let i=0;i<(pixels?.length||0);i++) results.push(0); continue;
        }
        for (const [px,py] of (pixels||[])) {
            const cpx = Math.max(0,Math.min(tile.width-1,px));
            const cpy = Math.max(0,Math.min(tile.height-1,py));
            results.push(Math.round(sampleBilinear(tile,cpx,cpy)*10)/10);
        }
    }
    res.json({ elevations: results });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /water
// ─────────────────────────────────────────────────────────────────────────────
app.post("/water", async (req, res) => {
    const bbox = parseBbox(req.body);
    if (bbox.error) return res.status(400).json({ error: bbox.error });
    const { minLat, minLon, maxLat, maxLon } = bbox;
    const { sLat, sLon } = snapBbox(minLat, minLon, maxLat, maxLon);
    const cacheKey = `water|${sLat.toFixed(2)},${sLon.toFixed(2)}`;
    if (osmCache.has(cacheKey)) return res.json(osmCache.get(cacheKey));

    const query = `[out:json][timeout:25];(way["natural"="water"](${minLat},${minLon},${maxLat},${maxLon});way["waterway"="riverbank"](${minLat},${minLon},${maxLat},${maxLon});way["natural"="beach"](${minLat},${minLon},${maxLat},${maxLon}););out body;>;out skel qt;`;
    try {
        const data = await postOverpass(query);
        const result = { elements: data.elements||[] };
        osmCacheSet(cacheKey, result);
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
    const { sLat, sLon } = snapBbox(minLat, minLon, maxLat, maxLon);
    const cacheKey = `buildings|${sLat.toFixed(2)},${sLon.toFixed(2)}`;
    if (osmCache.has(cacheKey)) return res.json(osmCache.get(cacheKey));

    const query = `[out:json][timeout:25];(way["building"](${minLat},${minLon},${maxLat},${maxLon}););out body;>;out skel qt;`;
    try {
        const data = await postOverpass(query);
        const result = { elements: data.elements||[] };
        osmCacheSet(cacheKey, result);
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
    const { sLat, sLon } = snapBbox(minLat, minLon, maxLat, maxLon);
    const cacheKey = `roads|${sLat.toFixed(2)},${sLon.toFixed(2)}`;
    if (osmCache.has(cacheKey)) return res.json(osmCache.get(cacheKey));

    const query = `[out:json][timeout:25];(way["highway"~"^(${ROAD_FILTER})$"](${minLat},${minLon},${maxLat},${maxLon}););out body;>;out skel qt;`;
    try {
        const data = await postOverpass(query);
        const nodes={};
        for (const el of (data.elements||[])) { if (el.type==="node") nodes[el.id]={lat:el.lat,lon:el.lon}; }
        const ways=[];
        for (const el of (data.elements||[])) {
            if (el.type==="way"&&el.nodes) {
                const resolved=el.nodes.map(id=>nodes[id]).filter(Boolean);
                if (resolved.length>=2) ways.push({id:el.id,tags:el.tags||{},nodes:resolved});
            }
        }
        const result = { ways };
        osmCacheSet(cacheKey, result);
        res.json(result);
    } catch (err) {
        console.error("[Proxy] /roads Overpass failed:", err.message);
        res.status(err.response?.status||500).json({ error: "Failed to fetch road data", detail: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /geocode
// ─────────────────────────────────────────────────────────────────────────────
app.get("/geocode", async (req, res) => {
    const q=req.query.q, limit=req.query.limit||5;
    if (!q) return res.status(400).json({ error: "Missing query 'q'" });
    try {
        const url=`https://nominatim.openstreetmap.org/search?format=json&limit=${limit}&q=${encodeURIComponent(q)}`;
        const response=await axios.get(url,{headers:{"User-Agent":"Tellus-Roblox-Proxy/3.5"}});
        res.json(response.data);
    } catch(err) {
        console.error("[Proxy] /geocode failed:",err.message);
        res.status(500).json({error:"Geocode fetch failed"});
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

function koppenAt(lat,lon) {
    if (!koppen) return null;
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
// ─────────────────────────────────────────────────────────────────────────────
app.post("/landcover",(req,res)=>{
    const points=(req.body&&req.body.points)||[];
    if (!Array.isArray(points)||points.length===0) return res.json({classes:[]});
    const classes=points.map(p=>{
        const lat=Number(p.lat),lon=Number(p.lon);
        if (!isFinite(lat)||!isFinite(lon)) return {esa:0,koppen:"NONE"};
        return {esa:0,koppen:koppenNearest(lat,lon,3)||"NONE"};
    });
    res.json({classes});
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
    return decodeGeoTiff(Buffer.from(response.data));
}

function resampleToPixels(tile,pixels,srcBbox,tileZ,tileX,tileY) {
    const results=[], n=Math.pow(2,tileZ);
    for (const [px,py] of pixels) {
        const lon=(tileX+px/256)/n*360-180;
        const lat=Math.atan(Math.sinh(Math.PI*(1-2*(tileY+py/256)/n)))*180/Math.PI;
        const fx=(lon-srcBbox.west)/(srcBbox.east-srcBbox.west)*(tile.width-1);
        const fy=(srcBbox.north-lat)/(srcBbox.north-srcBbox.south)*(tile.height-1);
        results.push(Math.round(sampleBilinear(tile,Math.max(0,fx),Math.max(0,fy))*10)/10);
    }
    return results;
}

async function handleRegionalElevation(req,res,fetchFn) {
    const {tiles}=req.body;
    if (!Array.isArray(tiles)) return res.status(400).json({error:"Body must have 'tiles' array"});
    const results=[];
    for (const tileReq of tiles) {
        const {z,x,y,pixels}=tileReq;
        if (typeof z!=="number"||typeof x!=="number"||typeof y!=="number") {
            for (let i=0;i<(pixels?.length||0);i++) results.push(0); continue;
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
        if (!tile) { for (let i=0;i<(pixels?.length||0);i++) results.push(0); continue; }
        for (const v of resampleToPixels(tile,pixels||[],bbox,z,x,y)) results.push(v);
    }
    res.json({elevations:results});
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
async function fetchJapan(bbox) {
    const {west,east,north,south}=bbox;
    const midLat=(north+south)/2, midLon=(east+west)/2;
    const z=15, n=Math.pow(2,z);
    const gsiX=Math.floor((midLon+180)/360*n);
    const gsiY=Math.floor((1-Math.log(Math.tan(midLat*Math.PI/180)+1/Math.cos(midLat*Math.PI/180))/Math.PI)/2*n);
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
            return {width,height,elevations};
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

// ── Regional routes ───────────────────────────────────────────────────────────
app.post("/elevation/arctic",      (req,res)=>handleRegionalElevation(req,res,fetchArctic));
app.post("/elevation/antarctica",  (req,res)=>handleRegionalElevation(req,res,fetchAntarctica));
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
