/**
 * City search engine for the location picker.
 * Provides prefix-based autocomplete over GeoNames cities1000 + IATA airports.
 *
 * Data is stored columnar (format v2, see scripts/build-cities.js and
 * planning/2026-06-13-observatory-cities-columnar.md): numeric fields live in
 * typed arrays, text fields in newline-joined strings sliced on demand. This
 * avoids materializing 167k array-of-arrays + ~425k small strings (~45 MB heap)
 * — the columnar form is ~22 MB.
 */

/** City search result. */
export interface CityResult {
    /** Display label: "City, State, Country" or "IATA CityName airport" */
    label: string;
    /** Short label for the location bar, e.g. "San Francisco" */
    shortLabel: string;
    lat: number;
    lon: number;
    timezone: string;
    /** True if this is an airport entry */
    isAirport: boolean;
    /** Equirectangular distance in degrees from the query point (only set by findClosestCity) */
    distanceDeg?: number;
}

// ── Lookup tables ──
let TZ: string[] = [];
let CC: string[] = [];
let AD: string[] = [];

// ── City columns (indexed by row, sorted by population descending) ──
let N = 0;
let cLat: Int32Array = new Int32Array(0);  // round(deg * 1000)
let cLon: Int32Array = new Int32Array(0);
let cPop: Uint32Array = new Uint32Array(0);
let cTz: Uint16Array = new Uint16Array(0);
let cCc: Uint16Array = new Uint16Array(0);
let cAd1: Uint16Array = new Uint16Array(0);
let names = '';   let nameOff: Uint32Array = new Uint32Array(0);   // original UTF-8 (display)
let ascii = '';   let asciiOff: Uint32Array = new Uint32Array(0);  // ASCII-folded (search)
let alts = '';    let altOff: Uint32Array = new Uint32Array(0);    // comma-joined alt blobs (search)
let ad2: Map<number, string> = new Map();  // sparse: row index -> county name

// ── Airport columns (sorted by IATA) ──
let aN = 0;
let aLat: Int32Array = new Int32Array(0);
let aLon: Int32Array = new Int32Array(0);
let aTz: Uint16Array = new Uint16Array(0);
let aCc: Uint16Array = new Uint16Array(0);
let aIata = '';   let aIataOff: Uint32Array = new Uint32Array(0);
let aCity = '';   let aCityOff: Uint32Array = new Uint32Array(0);

let loaded = false;

// ============================================================================
// Decode helpers
// ============================================================================

/** True on little-endian hosts (effectively all browsers). */
const IS_LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Decode a base64 string to a fresh Uint8Array (buffer offset 0, aligned). */
function b64ToBytes(s: string): Uint8Array {
    const bin = atob(s);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

/** Reverse each `width`-byte group in place (only used on big-endian hosts). */
function swapInPlace(bytes: Uint8Array, width: number): void {
    for (let i = 0; i < bytes.length; i += width) {
        for (let j = 0; j < width >> 1; j++) {
            const t = bytes[i + j];
            bytes[i + j] = bytes[i + width - 1 - j];
            bytes[i + width - 1 - j] = t;
        }
    }
}

function decodeI32(s: string): Int32Array {
    const b = b64ToBytes(s);
    if (!IS_LE) swapInPlace(b, 4);
    return new Int32Array(b.buffer);
}
function decodeU32(s: string): Uint32Array {
    const b = b64ToBytes(s);
    if (!IS_LE) swapInPlace(b, 4);
    return new Uint32Array(b.buffer);
}
function decodeU16(s: string): Uint16Array {
    const b = b64ToBytes(s);
    if (!IS_LE) swapInPlace(b, 2);
    return new Uint16Array(b.buffer);
}

/**
 * Build a row-offset index for a newline-joined string of `rows` rows.
 * Row i spans [off[i], off[i+1] - 1) (the -1 drops the trailing delimiter).
 * off has rows+1 entries; off[0]=0 and off[rows]=str.length+1 (sentinel).
 */
function buildOffsets(str: string, rows: number): Uint32Array {
    const off = new Uint32Array(rows + 1);
    let r = 1;
    let pos = str.indexOf('\n');
    while (pos !== -1) {
        off[r++] = pos + 1;
        pos = str.indexOf('\n', pos + 1);
    }
    off[rows] = str.length + 1;
    return off;
}

/** Extract row i's text from a newline-joined string via its offset index. */
function rowStr(str: string, off: Uint32Array, i: number): string {
    return str.slice(off[i], off[i + 1] - 1);
}

/** Length of row i (without allocating the substring). */
function rowLen(off: Uint32Array, i: number): number {
    return off[i + 1] - 1 - off[i];
}

/**
 * True if `q` is a prefix of the row starting at `start` in `h`.
 * Allocation-free. Safe across row boundaries: the '\n' delimiter never appears
 * in a query, so a query longer than the row mismatches at the delimiter.
 */
function startsWithAt(h: string, start: number, q: string): boolean {
    for (let k = 0; k < q.length; k++) {
        if (h.charCodeAt(start + k) !== q.charCodeAt(k)) return false;
    }
    return true;
}

/** Largest i with off[i] <= pos (which row a char position belongs to). */
function rowOfOffset(off: Uint32Array, pos: number): number {
    let lo = 0;
    let hi = off.length - 2;  // last valid row index
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (off[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo;
}

// ============================================================================
// Loading
// ============================================================================
//
// Protocol-aware (see planning/2026-06-14-observatory-cities-lazy-load.md):
//   http(s): fetch cities-data.json.gz once into a resident ~2-3 MB compressed
//            blob (prefetchCityData), then decompress + parse on demand. The
//            blob is download-once insurance independent of HTTP-cache eviction.
//   file://: fetch()/XHR of local files is blocked, and local reads have no
//            latency to hide — so load the <script> form (cities-data.js) on
//            demand, re-injecting it if released.

const isFileProtocol = typeof location !== 'undefined' && location.protocol === 'file:';

/** Resident compressed payload (gzip of cities-data.json), http(s) only. */
let compressedBlob: Uint8Array | null = null;
/** In-flight prefetch (so concurrent callers share one download). */
let prefetchPromise: Promise<void> | null = null;
/** In-flight load (so concurrent callers share one parse). */
let loadPromise: Promise<void> | null = null;

/** Whether the fetch + gunzip path is usable in this environment. */
function canUseFetchPath(): boolean {
    return !isFileProtocol
        && typeof fetch !== 'undefined'
        && typeof DecompressionStream !== 'undefined';
}

/** Decode the v2 payload into the columnar module state. */
function ingest(raw: any): void {
    TZ = raw.TZ; CC = raw.CC; AD = raw.AD;
    N = raw.N; aN = raw.aN;

    cLat = decodeI32(raw.cLat); cLon = decodeI32(raw.cLon); cPop = decodeU32(raw.cPop);
    cTz = decodeU16(raw.cTz); cCc = decodeU16(raw.cCc); cAd1 = decodeU16(raw.cAd1);
    names = raw.names; ascii = raw.ascii; alts = raw.alts;
    nameOff = buildOffsets(names, N);
    asciiOff = buildOffsets(ascii, N);
    altOff = buildOffsets(alts, N);

    ad2 = new Map();
    for (const k in raw.ad2) ad2.set(+k, raw.ad2[k]);

    aLat = decodeI32(raw.aLat); aLon = decodeI32(raw.aLon);
    aTz = decodeU16(raw.aTz); aCc = decodeU16(raw.aCc);
    aIata = raw.aIata; aCity = raw.aCity;
    aIataOff = buildOffsets(aIata, aN);
    aCityOff = buildOffsets(aCity, aN);

    loaded = true;

    // Release the raw payload. The numeric base64 blobs (~4 MB) are now decoded
    // into typed arrays, and the text columns survive via the module-level
    // string references above (JS strings are shared by reference). Dropping the
    // global lets the GC reclaim the redundant base64 strings and the wrapper.
    (window as any).ChronometerCities = undefined;

    console.log(`[CitySearch] Loaded ${N} cities, ${aN} airports`);
}

/** ASCII-fold a string for diacritics-insensitive search. */
function toASCII(s: string): string {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Error message from last load attempt, if any. */
export let loadError: string = '';

/** Fetch the compressed JSON payload as raw bytes (http(s) only). */
async function fetchCompressed(): Promise<Uint8Array> {
    const resp = await fetch('cities-data.json.gz');
    if (!resp.ok) throw new Error(`fetch cities-data.json.gz: HTTP ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
}

/** Gunzip raw bytes to the decompressed UTF-8 text. */
async function gunzipToText(bytes: Uint8Array): Promise<string> {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds);
    return await new Response(stream).text();
}

/** Ensure the compressed blob is resident, reusing any in-flight prefetch. */
async function ensureCompressed(): Promise<Uint8Array> {
    if (compressedBlob) return compressedBlob;
    if (prefetchPromise) await prefetchPromise;
    if (compressedBlob) return compressedBlob;
    compressedBlob = await fetchCompressed();
    return compressedBlob;
}

/** Load via on-demand <script> injection (file:// and fetch-path fallback). */
function loadViaScript(): Promise<void> {
    return new Promise((resolve, reject) => {
        // Register a callback that the data file invokes on execution. This is
        // more reliable than checking a global after onload, because onload fires
        // on download success — not execution success.
        (window as any)._chronCitiesCallback = (data: any) => {
            if (data) ingest(data);
        };

        const script = document.createElement('script');
        script.src = 'cities-data.js';

        const errorHandler = (evt: ErrorEvent) => {
            if (evt.filename && evt.filename.includes('cities-data')) {
                window.removeEventListener('error', errorHandler);
                loadError = `JS error in cities-data.js: ${evt.message} (line ${evt.lineno})`;
                console.error(`[CitySearch] ${loadError}`);
                reject(new Error(loadError));
            }
        };
        window.addEventListener('error', errorHandler);

        script.onload = () => {
            window.removeEventListener('error', errorHandler);
            delete (window as any)._chronCitiesCallback;
            script.remove();
            if (loaded) resolve();
            else {
                loadError = 'cities-data.js loaded but data callback was not invoked';
                console.error(`[CitySearch] ${loadError}`);
                reject(new Error(loadError));
            }
        };
        script.onerror = (evt) => {
            window.removeEventListener('error', errorHandler);
            delete (window as any)._chronCitiesCallback;
            loadError = `Failed to download cities-data.js`;
            console.error(`[CitySearch] ${loadError}`, evt);
            reject(new Error(loadError));
        };
        document.head.appendChild(script);
    });
}

/** Load via fetch + gunzip + parse (http(s)), falling back to <script>. */
async function loadViaFetch(): Promise<void> {
    try {
        const bytes = await ensureCompressed();
        ingest(JSON.parse(await gunzipToText(bytes)));
    } catch (err) {
        console.warn('[CitySearch] fetch/gz load failed, falling back to <script>', err);
        await loadViaScript();
    }
}

/**
 * Begin downloading the compressed city DB into a resident ~2-3 MB blob
 * *without* parsing it (http(s) only). Idempotent and best-effort — failures are
 * swallowed (loadCityData() retries / falls back). No-op on file:// and when the
 * data is already loaded. Callers gate this on save-data / embed.
 */
export function prefetchCityData(): Promise<void> {
    if (loaded || loadError || compressedBlob || !canUseFetchPath()) return Promise.resolve();
    if (prefetchPromise) return prefetchPromise;
    prefetchPromise = fetchCompressed()
        .then(bytes => { compressedBlob = bytes; })
        .catch(err => { console.warn('[CitySearch] prefetch failed (will retry on demand)', err); });
    return prefetchPromise;
}

/**
 * Load + parse the city database. Must complete before search()/findClosestCity.
 * Uses the resident compressed blob when present (no network round-trip).
 */
export function loadCityData(): Promise<void> {
    if (loaded) return Promise.resolve();
    if (loadError) return Promise.reject(new Error(loadError));
    if (loadPromise) return loadPromise;

    // Fast path: a standalone HTML build may have set the global directly.
    const existing = (window as any).ChronometerCities;
    if (existing) {
        ingest(existing);
        return Promise.resolve();
    }

    loadPromise = (canUseFetchPath() ? loadViaFetch() : loadViaScript())
        .finally(() => { loadPromise = null; });
    return loadPromise;
}

/**
 * Drop the parsed columnar form to free memory (~22 MB). The resident compressed
 * blob (http(s)) is kept so the next loadCityData() re-parses without a network
 * round-trip; on file:// the next load re-injects the <script>.
 */
export function releaseCityData(): void {
    if (!loaded) return;
    loaded = false;
    N = 0; aN = 0;
    TZ = []; CC = []; AD = [];
    cLat = new Int32Array(0); cLon = new Int32Array(0); cPop = new Uint32Array(0);
    cTz = new Uint16Array(0); cCc = new Uint16Array(0); cAd1 = new Uint16Array(0);
    names = ''; ascii = ''; alts = '';
    nameOff = new Uint32Array(0); asciiOff = new Uint32Array(0); altOff = new Uint32Array(0);
    ad2 = new Map();
    aLat = new Int32Array(0); aLon = new Int32Array(0); aTz = new Uint16Array(0); aCc = new Uint16Array(0);
    aIata = ''; aCity = '';
    aIataOff = new Uint32Array(0); aCityOff = new Uint32Array(0);
    console.log('[CitySearch] Released parsed city data');
}

/** Check if city data is loaded. */
export function isCityDataLoaded(): boolean {
    return loaded;
}

// ============================================================================
// Search
// ============================================================================

/** Build the "City (County), State, Country" display label for city row i. */
function cityLabel(i: number, name: string): string {
    let label = name;
    const a2 = ad2.get(i);
    if (a2) label += ` (${a2})`;
    const admin1 = AD[cAd1[i]] || '';
    if (admin1) label += `, ${admin1}`;
    const cc = CC[cCc[i]] || '';
    if (cc) label += `, ${cc}`;
    return label;
}

/**
 * Search for cities matching the given query string.
 * Returns up to `limit` results sorted by relevance (exact prefix first, then population).
 */
export function searchCities(query: string, limit: number = 20): CityResult[] {
    if (!loaded || !query || query.length < 2) return [];

    const q = toASCII(query.trim());
    if (!q) return [];

    const qUpper = query.trim().toUpperCase();
    const results: { result: CityResult; priority: number; pop: number }[] = [];

    // Search airports by IATA code (exact prefix match)
    for (let i = 0; i < aN; i++) {
        if (!startsWithAt(aIata, aIataOff[i], qUpper)) continue;
        const iata = rowStr(aIata, aIataOff, i);
        const city = rowStr(aCity, aCityOff, i);
        results.push({
            result: {
                label: `${iata}  ${city} airport`,
                shortLabel: `${iata} ${city} airport`,
                lat: aLat[i] / 1000,
                lon: aLon[i] / 1000,
                timezone: TZ[aTz[i]] || '',
                isAirport: true,
            },
            priority: rowLen(aIataOff, i) === qUpper.length ? 0 : 1,  // exact match first
            pop: 0,
        });
    }

    const matchedRows = new Set<number>();

    // Cities — primary ASCII name (prefix match), priorities 0 (exact) / 1.
    for (let i = 0; i < N; i++) {
        if (!startsWithAt(ascii, asciiOff[i], q)) continue;
        matchedRows.add(i);
        const name = rowStr(names, nameOff, i);
        results.push({
            result: {
                label: cityLabel(i, name),
                shortLabel: name,
                lat: cLat[i] / 1000,
                lon: cLon[i] / 1000,
                timezone: TZ[cTz[i]] || '',
                isAirport: false,
            },
            priority: rowLen(asciiOff, i) === q.length ? 0 : 1,
            pop: cPop[i],
        });
    }

    // Cities — alternate-name prefix match (priority 3). Scan the concatenated
    // alt blob globally and map each hit back to its row. A hit is a prefix
    // match iff it sits at an alt-entry boundary (start of row, or after a comma).
    let pos = alts.indexOf(q);
    while (pos >= 0) {
        const prev = pos === 0 ? 10 : alts.charCodeAt(pos - 1);  // 10 = '\n'
        if (prev === 10 || prev === 44 /* ',' */) {
            const i = rowOfOffset(altOff, pos);
            if (!matchedRows.has(i)) {
                matchedRows.add(i);
                const name = rowStr(names, nameOff, i);
                results.push({
                    result: {
                        label: cityLabel(i, name),
                        shortLabel: name,
                        lat: cLat[i] / 1000,
                        lon: cLon[i] / 1000,
                        timezone: TZ[cTz[i]] || '',
                        isAirport: false,
                    },
                    priority: 3,
                    pop: cPop[i],
                });
            }
        }
        pos = alts.indexOf(q, pos + 1);
    }

    // Sort: lower priority first, then by population descending
    results.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return b.pop - a.pop;
    });

    return results.slice(0, limit).map(r => r.result);
}

/**
 * Find the closest city in the database to the given coordinates.
 * Uses a fast equirectangular approximation for distance.
 * Returns null if city data is not loaded.
 */
export function findClosestCity(lat: number, lon: number): CityResult | null {
    if (!loaded || N === 0) return null;

    let bestDist = Infinity;
    let bestIdx = -1;

    // Equirectangular approximation (fast, good enough for nearest-city)
    const cosLat = Math.cos(lat * Math.PI / 180);

    for (let i = 0; i < N; i++) {
        const dLat = cLat[i] / 1000 - lat;
        const dLon = (cLon[i] / 1000 - lon) * cosLat;
        const dist = dLat * dLat + dLon * dLon;
        if (dist < bestDist) {
            bestDist = dist;
            bestIdx = i;
        }
    }

    if (bestIdx < 0) return null;

    const name = rowStr(names, nameOff, bestIdx);
    return {
        label: cityLabel(bestIdx, name),
        shortLabel: name,
        lat: cLat[bestIdx] / 1000,
        lon: cLon[bestIdx] / 1000,
        timezone: TZ[cTz[bestIdx]] || '',
        isAirport: false,
        distanceDeg: Math.sqrt(bestDist),
    };
}

/**
 * Find the largest city within `radiusDeg` degrees of (lat, lon).
 *
 * Cities are stored sorted by population descending, so the **first** city
 * found inside the radius is guaranteed to be the most populous — early exit.
 * In populated areas (Tokyo, NYC, London) this returns almost immediately.
 * In empty regions the full scan runs and returns null.
 *
 * Uses the same equirectangular distance approximation as `findClosestCity`.
 */
export function findLargestCityNear(
    lat: number, lon: number, radiusDeg: number,
): CityResult | null {
    if (!loaded || N === 0) return null;

    const cosLat = Math.cos(lat * Math.PI / 180);
    const r2 = radiusDeg * radiusDeg;

    for (let i = 0; i < N; i++) {
        const dLat = cLat[i] / 1000 - lat;
        const dLon = (cLon[i] / 1000 - lon) * cosLat;
        if (dLat * dLat + dLon * dLon <= r2) {
            const name = rowStr(names, nameOff, i);
            return {
                label: cityLabel(i, name),
                shortLabel: name,
                lat: cLat[i] / 1000,
                lon: cLon[i] / 1000,
                timezone: TZ[cTz[i]] || '',
                isAirport: false,
                distanceDeg: Math.sqrt(dLat * dLat + dLon * dLon),
            };
        }
    }
    return null;
}
