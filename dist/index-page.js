"use strict";
(() => {
  // src/shared/city-search.ts
  var TZ = [];
  var CC = [];
  var AD = [];
  var N = 0;
  var cLat = new Int32Array(0);
  var cLon = new Int32Array(0);
  var cPop = new Uint32Array(0);
  var cTz = new Uint16Array(0);
  var cCc = new Uint16Array(0);
  var cAd1 = new Uint16Array(0);
  var names = "";
  var nameOff = new Uint32Array(0);
  var ascii = "";
  var asciiOff = new Uint32Array(0);
  var alts = "";
  var altOff = new Uint32Array(0);
  var ad2 = /* @__PURE__ */ new Map();
  var aN = 0;
  var aLat = new Int32Array(0);
  var aLon = new Int32Array(0);
  var aTz = new Uint16Array(0);
  var aCc = new Uint16Array(0);
  var aIata = "";
  var aIataOff = new Uint32Array(0);
  var aCity = "";
  var aCityOff = new Uint32Array(0);
  var loaded = false;
  var IS_LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
  function b64ToBytes(s) {
    const bin = atob(s);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function swapInPlace(bytes, width) {
    for (let i = 0; i < bytes.length; i += width) {
      for (let j = 0; j < width >> 1; j++) {
        const t = bytes[i + j];
        bytes[i + j] = bytes[i + width - 1 - j];
        bytes[i + width - 1 - j] = t;
      }
    }
  }
  function decodeI32(s) {
    const b = b64ToBytes(s);
    if (!IS_LE) swapInPlace(b, 4);
    return new Int32Array(b.buffer);
  }
  function decodeU32(s) {
    const b = b64ToBytes(s);
    if (!IS_LE) swapInPlace(b, 4);
    return new Uint32Array(b.buffer);
  }
  function decodeU16(s) {
    const b = b64ToBytes(s);
    if (!IS_LE) swapInPlace(b, 2);
    return new Uint16Array(b.buffer);
  }
  function buildOffsets(str, rows) {
    const off = new Uint32Array(rows + 1);
    let r = 1;
    let pos = str.indexOf("\n");
    while (pos !== -1) {
      off[r++] = pos + 1;
      pos = str.indexOf("\n", pos + 1);
    }
    off[rows] = str.length + 1;
    return off;
  }
  function rowStr(str, off, i) {
    return str.slice(off[i], off[i + 1] - 1);
  }
  function rowLen(off, i) {
    return off[i + 1] - 1 - off[i];
  }
  function startsWithAt(h, start, q) {
    for (let k = 0; k < q.length; k++) {
      if (h.charCodeAt(start + k) !== q.charCodeAt(k)) return false;
    }
    return true;
  }
  function rowOfOffset(off, pos) {
    let lo = 0;
    let hi = off.length - 2;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (off[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  var isFileProtocol = typeof location !== "undefined" && location.protocol === "file:";
  var compressedBlob = null;
  var prefetchPromise = null;
  var loadPromise = null;
  function canUseFetchPath() {
    return !isFileProtocol && typeof fetch !== "undefined" && typeof DecompressionStream !== "undefined";
  }
  function ingest(raw) {
    TZ = raw.TZ;
    CC = raw.CC;
    AD = raw.AD;
    N = raw.N;
    aN = raw.aN;
    cLat = decodeI32(raw.cLat);
    cLon = decodeI32(raw.cLon);
    cPop = decodeU32(raw.cPop);
    cTz = decodeU16(raw.cTz);
    cCc = decodeU16(raw.cCc);
    cAd1 = decodeU16(raw.cAd1);
    names = raw.names;
    ascii = raw.ascii;
    alts = raw.alts;
    nameOff = buildOffsets(names, N);
    asciiOff = buildOffsets(ascii, N);
    altOff = buildOffsets(alts, N);
    ad2 = /* @__PURE__ */ new Map();
    for (const k in raw.ad2) ad2.set(+k, raw.ad2[k]);
    aLat = decodeI32(raw.aLat);
    aLon = decodeI32(raw.aLon);
    aTz = decodeU16(raw.aTz);
    aCc = decodeU16(raw.aCc);
    aIata = raw.aIata;
    aCity = raw.aCity;
    aIataOff = buildOffsets(aIata, aN);
    aCityOff = buildOffsets(aCity, aN);
    loaded = true;
    window.ChronometerCities = void 0;
    console.log(`[CitySearch] Loaded ${N} cities, ${aN} airports`);
  }
  function toASCII(s) {
    return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }
  var loadError = "";
  async function fetchCompressed() {
    const resp = await fetch("cities-data.json.gz");
    if (!resp.ok) throw new Error(`fetch cities-data.json.gz: HTTP ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
  }
  async function gunzipToText(bytes) {
    const ds = new DecompressionStream("gzip");
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return await new Response(stream).text();
  }
  async function ensureCompressed() {
    if (compressedBlob) return compressedBlob;
    if (prefetchPromise) await prefetchPromise;
    if (compressedBlob) return compressedBlob;
    compressedBlob = await fetchCompressed();
    return compressedBlob;
  }
  function loadViaScript() {
    return new Promise((resolve, reject) => {
      window._chronCitiesCallback = (data) => {
        if (data) ingest(data);
      };
      const script = document.createElement("script");
      script.src = "cities-data.js";
      const errorHandler = (evt) => {
        if (evt.filename && evt.filename.includes("cities-data")) {
          window.removeEventListener("error", errorHandler);
          loadError = `JS error in cities-data.js: ${evt.message} (line ${evt.lineno})`;
          console.error(`[CitySearch] ${loadError}`);
          reject(new Error(loadError));
        }
      };
      window.addEventListener("error", errorHandler);
      script.onload = () => {
        window.removeEventListener("error", errorHandler);
        delete window._chronCitiesCallback;
        script.remove();
        if (loaded) resolve();
        else {
          loadError = "cities-data.js loaded but data callback was not invoked";
          console.error(`[CitySearch] ${loadError}`);
          reject(new Error(loadError));
        }
      };
      script.onerror = (evt) => {
        window.removeEventListener("error", errorHandler);
        delete window._chronCitiesCallback;
        loadError = `Failed to download cities-data.js`;
        console.error(`[CitySearch] ${loadError}`, evt);
        reject(new Error(loadError));
      };
      document.head.appendChild(script);
    });
  }
  async function loadViaFetch() {
    try {
      const bytes = await ensureCompressed();
      ingest(JSON.parse(await gunzipToText(bytes)));
    } catch (err) {
      console.warn("[CitySearch] fetch/gz load failed, falling back to <script>", err);
      await loadViaScript();
    }
  }
  function loadCityData() {
    if (loaded) return Promise.resolve();
    if (loadError) return Promise.reject(new Error(loadError));
    if (loadPromise) return loadPromise;
    const existing = window.ChronometerCities;
    if (existing) {
      ingest(existing);
      return Promise.resolve();
    }
    loadPromise = (canUseFetchPath() ? loadViaFetch() : loadViaScript()).finally(() => {
      loadPromise = null;
    });
    return loadPromise;
  }
  function isCityDataLoaded() {
    return loaded;
  }
  function cityLabel(i, name) {
    let label = name;
    const a2 = ad2.get(i);
    if (a2) label += ` (${a2})`;
    const admin1 = AD[cAd1[i]] || "";
    if (admin1) label += `, ${admin1}`;
    const cc = CC[cCc[i]] || "";
    if (cc) label += `, ${cc}`;
    return label;
  }
  function searchCities(query, limit = 20) {
    if (!loaded || !query || query.length < 2) return [];
    const q = toASCII(query.trim());
    if (!q) return [];
    const qUpper = query.trim().toUpperCase();
    const results = [];
    for (let i = 0; i < aN; i++) {
      if (!startsWithAt(aIata, aIataOff[i], qUpper)) continue;
      const iata = rowStr(aIata, aIataOff, i);
      const city = rowStr(aCity, aCityOff, i);
      results.push({
        result: {
          label: `${iata}  ${city} airport`,
          shortLabel: `${iata} ${city} airport`,
          lat: aLat[i] / 1e3,
          lon: aLon[i] / 1e3,
          timezone: TZ[aTz[i]] || "",
          isAirport: true
        },
        priority: rowLen(aIataOff, i) === qUpper.length ? 0 : 1,
        // exact match first
        pop: 0
      });
    }
    const matchedRows = /* @__PURE__ */ new Set();
    for (let i = 0; i < N; i++) {
      if (!startsWithAt(ascii, asciiOff[i], q)) continue;
      matchedRows.add(i);
      const name = rowStr(names, nameOff, i);
      results.push({
        result: {
          label: cityLabel(i, name),
          shortLabel: name,
          lat: cLat[i] / 1e3,
          lon: cLon[i] / 1e3,
          timezone: TZ[cTz[i]] || "",
          isAirport: false
        },
        priority: rowLen(asciiOff, i) === q.length ? 0 : 1,
        pop: cPop[i]
      });
    }
    let pos = alts.indexOf(q);
    while (pos >= 0) {
      const prev = pos === 0 ? 10 : alts.charCodeAt(pos - 1);
      if (prev === 10 || prev === 44) {
        const i = rowOfOffset(altOff, pos);
        if (!matchedRows.has(i)) {
          matchedRows.add(i);
          const name = rowStr(names, nameOff, i);
          results.push({
            result: {
              label: cityLabel(i, name),
              shortLabel: name,
              lat: cLat[i] / 1e3,
              lon: cLon[i] / 1e3,
              timezone: TZ[cTz[i]] || "",
              isAirport: false
            },
            priority: 3,
            pop: cPop[i]
          });
        }
      }
      pos = alts.indexOf(q, pos + 1);
    }
    results.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return b.pop - a.pop;
    });
    return results.slice(0, limit).map((r) => r.result);
  }
  function findClosestCity(lat, lon) {
    if (!loaded || N === 0) return null;
    let bestDist = Infinity;
    let bestIdx = -1;
    const cosLat = Math.cos(lat * Math.PI / 180);
    for (let i = 0; i < N; i++) {
      const dLat = cLat[i] / 1e3 - lat;
      const dLon = (cLon[i] / 1e3 - lon) * cosLat;
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
      lat: cLat[bestIdx] / 1e3,
      lon: cLon[bestIdx] / 1e3,
      timezone: TZ[cTz[bestIdx]] || "",
      isAirport: false,
      distanceDeg: Math.sqrt(bestDist)
    };
  }

  // src/blue-marble-data.ts
  var BLUE_MARBLE = "data:image/jpeg;base64,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";

  // src/shared/mini-map.ts
  var textureImg = null;
  var textureCanvas = null;
  var textureCtx = null;
  var textureLoaded = false;
  function ensureTexture() {
    if (textureLoaded) return Promise.resolve();
    if (textureImg) return new Promise((r) => {
      textureImg.onload = () => r();
    });
    return new Promise((resolve) => {
      textureImg = new Image();
      textureImg.onload = () => {
        textureCanvas = document.createElement("canvas");
        textureCanvas.width = textureImg.width;
        textureCanvas.height = textureImg.height;
        textureCtx = textureCanvas.getContext("2d", { willReadFrequently: true });
        textureCtx.drawImage(textureImg, 0, 0);
        textureLoaded = true;
        resolve();
      };
      textureImg.src = BLUE_MARBLE;
    });
  }
  async function renderGlobe(canvas, lat, lon) {
    await ensureTexture();
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(cx, cy) - 2;
    ctx.clearRect(0, 0, w, h);
    const tw = textureCanvas.width;
    const th = textureCanvas.height;
    const texData = textureCtx.getImageData(0, 0, tw, th).data;
    const imgData = ctx.createImageData(w, h);
    const pixels = imgData.data;
    const \u03C60 = lat * Math.PI / 180;
    const \u03BB0 = lon * Math.PI / 180;
    const sin\u03C60 = Math.sin(\u03C60);
    const cos\u03C60 = Math.cos(\u03C60);
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const nx = (sx - cx) / r;
        const ny = (cy - sy) / r;
        const \u03C12 = nx * nx + ny * ny;
        if (\u03C12 > 1) continue;
        const \u03C1 = Math.sqrt(\u03C12);
        const c = Math.asin(\u03C1);
        const sinC = Math.sin(c);
        const cosC = Math.cos(c);
        let \u03C6, \u03BB;
        if (\u03C1 === 0) {
          \u03C6 = \u03C60;
          \u03BB = \u03BB0;
        } else {
          \u03C6 = Math.asin(cosC * sin\u03C60 + ny * sinC * cos\u03C60 / \u03C1);
          \u03BB = \u03BB0 + Math.atan2(nx * sinC, \u03C1 * cos\u03C60 * cosC - ny * sin\u03C60 * sinC);
        }
        const latDeg = \u03C6 * 180 / Math.PI;
        const lonDeg = \u03BB * 180 / Math.PI;
        let tx = (lonDeg + 180) % 360 / 360 * tw;
        let ty = (90 - latDeg) / 180 * th;
        tx = Math.max(0, Math.min(tw - 1, Math.floor(tx)));
        ty = Math.max(0, Math.min(th - 1, Math.floor(ty)));
        const ti = (ty * tw + tx) * 4;
        const pi = (sy * w + sx) * 4;
        const edgeFactor = 1 - \u03C12 * 0.3;
        pixels[pi] = texData[ti] * edgeFactor;
        pixels[pi + 1] = texData[ti + 1] * edgeFactor;
        pixels[pi + 2] = texData[ti + 2] * edgeFactor;
        pixels[pi + 3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
    ctx.fillStyle = "#ff4444";
    ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(100, 160, 255, 0.2)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  function latLonToTile(lat, lon, zoom) {
    const n = 2 ** zoom;
    const xf = (lon + 180) / 360 * n;
    const latRad = lat * Math.PI / 180;
    const yf = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
    const tileX = Math.floor(xf);
    const tileY = Math.floor(yf);
    const px = (xf - tileX) * 256;
    const py = (yf - tileY) * 256;
    return { tileX, tileY, px, py };
  }
  function loadOSMTile(container, _img, markerEl, lat, lon, zoom = 8) {
    const { tileX, tileY, px, py } = latLonToTile(lat, lon, zoom);
    const startX = px >= 128 ? tileX : tileX - 1;
    const startY = py >= 128 ? tileY : tileY - 1;
    const markerX = px + (tileX - startX) * 256;
    const markerY = py + (tileY - startY) * 256;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    container.querySelectorAll(".osm-tile-img").forEach((el) => el.remove());
    const offsetX = Math.round(cw / 2 - markerX);
    const offsetY = Math.round(ch / 2 - markerY);
    markerEl.style.left = `${Math.round(cw / 2)}px`;
    markerEl.style.top = `${Math.round(ch / 2)}px`;
    const promises = [];
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const tx = startX + dx;
        const ty = startY + dy;
        const url = `https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`;
        const img = document.createElement("img");
        img.className = "osm-tile-img";
        img.style.position = "absolute";
        img.style.width = "256px";
        img.style.height = "256px";
        img.style.left = `${offsetX + dx * 256}px`;
        img.style.top = `${offsetY + dy * 256}px`;
        img.alt = "";
        container.insertBefore(img, markerEl);
        promises.push(new Promise((resolve) => {
          img.onload = () => resolve(true);
          img.onerror = () => {
            img.remove();
            resolve(false);
          };
          img.src = url;
        }));
      }
    }
    _img.style.display = "none";
    return Promise.all(promises).then((results) => results.some((ok) => ok));
  }

  // src/shared/tz-resolve.ts
  function resolveTimezone(lat, lon, cityTz) {
    if (cityTz) return cityTz;
    const closest = findClosestCity(lat, lon);
    if (closest?.timezone) return closest.timezone;
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return "Etc/UTC";
    }
  }

  // src/shared/url-state.ts
  function parseLocationSource(v) {
    return v === "browser" || v === "city" || v === "map" || v === "manual" ? v : null;
  }
  function locationSourceOf(s) {
    return s.lsrc ?? (s.bloc ? "browser" : s.city ? "city" : "manual");
  }
  function readUrlState() {
    const params = new URLSearchParams(window.location.search);
    const latStr = params.get("lat");
    const lonStr = params.get("lon") || params.get("long");
    const lat = latStr !== null ? parseFloat(latStr) : NaN;
    const lon = lonStr !== null ? parseFloat(lonStr) : NaN;
    const city = params.get("city");
    const blocStr = params.get("bloc");
    const tcStr = params.get("tc");
    const tStr = params.get("t");
    const offStr = params.get("off");
    const dirStr = params.get("dir");
    let dir = 1;
    if (dirStr === "-1") dir = -1;
    else if (dirStr === "0") dir = 0;
    return {
      lat: !isNaN(lat) ? lat : null,
      lon: !isNaN(lon) ? lon : null,
      city: city || null,
      bloc: blocStr === "1",
      lsrc: parseLocationSource(params.get("lsrc")),
      tc: tcStr === "1",
      t: tStr !== null ? parseInt(tStr, 10) : null,
      off: offStr !== null ? parseInt(offStr, 10) : null,
      dir,
      tz: params.get("tz") || null,
      picks: params.get("picks") || null,
      tp: params.get("tp") === "a" ? "a" : "d",
      embed: params.get("embed") === "1",
      fps: params.has("fps"),
      kyhand: params.get("kyhand"),
      kmode: params.get("kmode"),
      op: (() => {
        const s = params.get("op");
        const n = s !== null ? parseInt(s, 10) : NaN;
        return Number.isFinite(n) ? n : null;
      })(),
      onoon: params.get("onoon") === "1",
      body: params.get("body") || null,
      vnoon: params.get("vnoon") === "1"
    };
  }
  function writeUrlState(changes) {
    const params = new URLSearchParams(window.location.search);
    if ("lat" in changes) {
      if (changes.lat !== null && changes.lat !== void 0) {
        params.set("lat", changes.lat.toFixed(3));
      } else {
        params.delete("lat");
      }
    }
    if ("lon" in changes) {
      if (changes.lon !== null && changes.lon !== void 0) {
        params.set("lon", changes.lon.toFixed(3));
      } else {
        params.delete("lon");
      }
    }
    if ("picks" in changes) {
      if (changes.picks) params.set("picks", changes.picks);
      else params.delete("picks");
    }
    if ("kyhand" in changes) {
      if (changes.kyhand) params.set("kyhand", changes.kyhand);
      else params.delete("kyhand");
    }
    if ("kmode" in changes) {
      if (changes.kmode) params.set("kmode", changes.kmode);
      else params.delete("kmode");
    }
    if ("city" in changes) {
      if (changes.city) {
        params.set("city", changes.city);
      } else {
        params.delete("city");
      }
    }
    if ("bloc" in changes) {
      if (changes.bloc) {
        params.set("bloc", "1");
      } else {
        params.delete("bloc");
      }
    }
    if ("lsrc" in changes) {
      if (changes.lsrc) {
        params.set("lsrc", changes.lsrc);
      } else {
        params.delete("lsrc");
      }
    }
    if ("tc" in changes) {
      if (changes.tc) {
        params.set("tc", "1");
      } else {
        params.delete("tc");
      }
    }
    if ("t" in changes) {
      if (changes.t !== null && changes.t !== void 0) {
        params.set("t", changes.t.toString());
      } else {
        params.delete("t");
      }
    }
    if ("off" in changes) {
      if (changes.off !== null && changes.off !== void 0) {
        params.set("off", changes.off.toString());
      } else {
        params.delete("off");
      }
    }
    if ("dir" in changes) {
      if (changes.dir !== void 0 && changes.dir !== 1) {
        params.set("dir", changes.dir.toString());
      } else {
        params.delete("dir");
      }
    }
    if ("tz" in changes) {
      if (changes.tz) {
        params.set("tz", changes.tz);
      } else {
        params.delete("tz");
      }
    }
    if ("tp" in changes) {
      if (changes.tp === "a") {
        params.set("tp", "a");
      } else {
        params.delete("tp");
      }
    }
    if ("op" in changes) {
      if (changes.op !== null && changes.op !== void 0 && changes.op !== 0) {
        params.set("op", changes.op.toString());
      } else {
        params.delete("op");
      }
    }
    if ("onoon" in changes) {
      if (changes.onoon) {
        params.set("onoon", "1");
      } else {
        params.delete("onoon");
      }
    }
    if ("body" in changes) {
      if (changes.body) params.set("body", changes.body);
      else params.delete("body");
    }
    if ("vnoon" in changes) {
      if (changes.vnoon) params.set("vnoon", "1");
      else params.delete("vnoon");
    }
    params.delete("long");
    params.delete("loc");
    const qs = params.toString();
    const newUrl = window.location.pathname + (qs ? "?" + qs : "");
    history.replaceState(null, "", newUrl);
    updateNavigationLinks();
  }
  var picksProvider = () => new URLSearchParams(window.location.search).get("picks");
  function setPicksProvider(fn) {
    picksProvider = fn;
  }
  function updateNavigationLinks() {
    const search = window.location.search;
    const backLink = document.getElementById("back-link");
    if (backLink) {
      const url = new URL(backLink.getAttribute("data-base-href") || "index.html", window.location.href);
      url.search = search;
      backLink.href = url.toString();
    }
    const allFacesLink = document.getElementById("all-faces-link");
    if (allFacesLink) {
      const url = new URL(allFacesLink.getAttribute("data-base-href") || "all.html", window.location.href);
      url.search = search;
      allFacesLink.href = url.toString();
    }
    const selectedLink = document.getElementById("selected-faces-link");
    if (selectedLink) {
      const hasPicks = !!picksProvider();
      const baseHref = hasPicks ? "selected.html" : "pick.html";
      const url = new URL(baseHref, window.location.href);
      url.search = search;
      selectedLink.href = url.toString();
      selectedLink.title = hasPicks ? "Selected Faces" : "Pick Faces";
    }
    const editPicksLink = document.getElementById("edit-picks-link");
    if (editPicksLink) {
      const url = new URL("pick.html", window.location.href);
      url.search = search;
      editPicksLink.href = url.toString();
    }
    document.querySelectorAll("a.face-card").forEach((a) => {
      const anchor = a;
      const url = new URL(anchor.getAttribute("data-base-href") || anchor.getAttribute("href"), window.location.href);
      url.search = search;
      anchor.href = url.toString();
    });
  }

  // src/shared/incoming-settings-dialog.ts
  var STYLE_ID = "ec-settings-dialog-style";
  var CSS = `
.ec-modal-backdrop {
    position: fixed; inset: 0; z-index: 1000;
    display: flex; align-items: center; justify-content: center;
    padding: 24px 16px;
    background: rgba(0, 0, 0, 0.5);
}
.ec-modal {
    position: relative;
    background: rgba(26, 26, 46, 0.98);
    backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
    border: 1px solid #3a3a5e; border-radius: 14px;
    padding: 26px 30px; min-width: 300px; max-width: 400px; width: 100%;
    box-shadow: 0 8px 48px rgba(0, 0, 0, 0.6);
    text-align: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.ec-modal-title {
    font-size: 16px; color: #e0d8c8; margin: 0 0 10px; font-weight: 400;
}
.ec-modal-text {
    font-size: 13px; color: #aab; line-height: 1.5; margin: 0 0 20px;
}
.ec-modal-buttons { display: flex; flex-direction: column; gap: 8px; }
.ec-modal-btn {
    border-radius: 6px; font-size: 13px; padding: 9px 16px;
    cursor: pointer; transition: background 0.15s, color 0.15s;
    background: #2a2a4e; border: 1px solid #3a3a5e; color: #aac;
}
.ec-modal-btn:hover { background: #3a3a6e; color: #ddf; }
.ec-modal-btn.ec-primary {
    background: #34507a; border-color: #4a6fa5; color: #dde9ff;
}
.ec-modal-btn.ec-primary:hover { background: #3f5f92; color: #fff; }

.ec-toast {
    position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
    z-index: 1001; max-width: 340px;
    background: rgba(26, 26, 46, 0.98); border: 1px solid #3a3a5e;
    border-radius: 10px; padding: 12px 16px;
    box-shadow: 0 6px 32px rgba(0, 0, 0, 0.5);
    color: #ccd; font-size: 12.5px; line-height: 1.45;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    display: flex; align-items: center; gap: 12px;
}
.ec-toast-close {
    background: none; border: none; color: #889; font-size: 18px;
    cursor: pointer; padding: 0 2px; line-height: 1;
}
.ec-toast-close:hover { color: #ccd; }

.ec-modal-input {
    width: 100%; box-sizing: border-box;
    background: #1d1d30; border: 1px solid #3a3a5e; border-radius: 6px;
    color: #cdd; font-size: 12px; font-family: monospace;
    padding: 8px 10px; margin: 0 0 14px;
    text-align: left;
}

.ec-url-badge {
    position: fixed; left: 10px; bottom: 8px; z-index: 999;
    font-size: 11px; color: #99a; opacity: 0.7;
    background: rgba(0, 0, 0, 0.3); padding: 2px 8px; border-radius: 6px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    pointer-events: none; user-select: none;
}
`;
  function ensureModalStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  var COPY = {
    incoming: {
      title: "Use these shared settings?",
      text: "This link includes a saved time, location, or configuration. Save them as your default on this device, or use them just for this visit?",
      save: "Save as my default",
      session: "Use for this visit only"
    },
    reprompt: {
      title: "Save your changes?",
      text: "You changed a setting while viewing shared settings. Save your current settings as the default on this device, or keep them only for this visit?",
      save: "Save as my default",
      session: "Keep for this visit only"
    }
  };
  function showIncomingSettingsDialog(options) {
    ensureModalStyles();
    const copy = COPY[options.mode];
    return new Promise((resolve) => {
      const backdrop = document.createElement("div");
      backdrop.className = "ec-modal-backdrop";
      const modal = document.createElement("div");
      modal.className = "ec-modal";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      const title = document.createElement("h2");
      title.className = "ec-modal-title";
      title.textContent = copy.title;
      const text = document.createElement("p");
      text.className = "ec-modal-text";
      text.textContent = copy.text;
      const buttons = document.createElement("div");
      buttons.className = "ec-modal-buttons";
      const saveBtn = document.createElement("button");
      saveBtn.className = "ec-modal-btn ec-primary";
      saveBtn.textContent = copy.save;
      const sessionBtn = document.createElement("button");
      sessionBtn.className = "ec-modal-btn";
      sessionBtn.textContent = copy.session;
      buttons.append(saveBtn, sessionBtn);
      modal.append(title, text, buttons);
      backdrop.append(modal);
      document.body.appendChild(backdrop);
      let done = false;
      const finish = (choice) => {
        if (done) return;
        done = true;
        document.removeEventListener("keydown", onKey);
        backdrop.remove();
        resolve(choice);
      };
      const onKey = (e) => {
        if (e.key === "Escape") finish("session");
      };
      saveBtn.addEventListener("click", () => finish("save"));
      sessionBtn.addEventListener("click", () => finish("session"));
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) finish("session");
      });
      document.addEventListener("keydown", onKey);
      saveBtn.focus();
    });
  }
  function showStorageWarning(message) {
    ensureModalStyles();
    const toast = document.createElement("div");
    toast.className = "ec-toast";
    const span = document.createElement("span");
    span.textContent = message;
    const close = document.createElement("button");
    close.className = "ec-toast-close";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "\xD7";
    close.addEventListener("click", () => toast.remove());
    toast.append(span, close);
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 12e3);
  }
  function showParadigmNotice() {
    ensureModalStyles();
    const toast = document.createElement("div");
    toast.className = "ec-toast";
    const span = document.createElement("span");
    span.textContent = "Your settings now save in this browser instead of the URL. Use the Share button to copy a link to a view; local storage can be cleared along with your browser history.";
    const close = document.createElement("button");
    close.className = "ec-toast-close";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "\xD7";
    close.addEventListener("click", () => toast.remove());
    toast.append(span, close);
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 16e3);
  }
  function showUrlModeBadge() {
    ensureModalStyles();
    if (document.getElementById("ec-url-badge")) return;
    const badge = document.createElement("div");
    badge.id = "ec-url-badge";
    badge.className = "ec-url-badge";
    badge.textContent = "(URL)";
    badge.title = "Local storage is unavailable here, so settings are kept in the URL.";
    document.body.appendChild(badge);
  }

  // src/shared/app-state.ts
  var LOCALSTORAGE_ENABLED = true;
  var SCHEMA_VERSION = 1;
  var STORAGE_KEY_PREFIX = "ec:";
  var SHARED_FIELDS = /* @__PURE__ */ new Set([
    "lat",
    "lon",
    "city",
    "tz",
    "bloc",
    "lsrc",
    "t",
    "off",
    "dir"
  ]);
  var URL_ONLY_FIELDS = /* @__PURE__ */ new Set([
    "embed",
    "fps",
    "tc"
  ]);
  function namespaceOf(field, app) {
    if (URL_ONLY_FIELDS.has(field)) return null;
    if (SHARED_FIELDS.has(field)) return "shared";
    switch (field) {
      case "picks":
      case "kyhand":
      case "kmode":
      case "body":
      case "vnoon":
        return "chronometer";
      case "op":
      case "onoon":
        return "observatory";
      case "tp":
        return app === "index" || app === "pick" ? null : app;
      default:
        return null;
    }
  }
  function defaultState() {
    return {
      lat: null,
      lon: null,
      city: null,
      bloc: false,
      lsrc: null,
      tc: false,
      t: null,
      off: null,
      dir: 1,
      tz: null,
      picks: null,
      tp: "d",
      embed: false,
      fps: false,
      kyhand: null,
      kmode: null,
      op: null,
      onoon: false,
      body: null,
      vnoon: false
    };
  }
  function isDefaultValue(field, value) {
    if (value === null || value === void 0) return true;
    switch (field) {
      case "dir":
        return value === 1;
      case "tp":
        return value === "d";
      case "bloc":
      case "tc":
      case "embed":
      case "fps":
      case "onoon":
      case "vnoon":
        return value === false;
      case "op":
        return value === 0;
      default:
        return false;
    }
  }
  var UrlBackend = class {
    read() {
      return readUrlState();
    }
    write(changes) {
      writeUrlState(changes);
    }
  };
  var LocalStorageBackend = class {
    constructor(app) {
      this.app = app;
    }
    read() {
      const state = defaultState();
      Object.assign(state, readNamespace("shared"));
      const appNs = appNamespace(this.app);
      if (appNs) Object.assign(state, readNamespace(appNs));
      const url = readUrlState();
      for (const field of URL_ONLY_FIELDS) {
        state[field] = url[field];
      }
      return state;
    }
    write(changes) {
      const buckets = /* @__PURE__ */ new Map();
      for (const key of Object.keys(changes)) {
        const ns = namespaceOf(key, this.app);
        if (!ns) continue;
        let bucket = buckets.get(ns);
        if (!bucket) {
          bucket = {};
          buckets.set(ns, bucket);
        }
        bucket[key] = changes[key];
      }
      for (const [ns, bucket] of buckets) {
        mergeNamespace(ns, bucket);
      }
    }
  };
  function appNamespace(app) {
    switch (app) {
      case "chronometer":
        return "chronometer";
      case "observatory":
        return "observatory";
      case "inspector":
        return "inspector";
      // The home and pick pages both surface the chronometer face set (the
      // pick-card / selected-faces routing reads `picks`), so they read the
      // chronometer namespace too.
      case "pick":
        return "chronometer";
      case "index":
        return "chronometer";
    }
  }
  function readNamespace(ns) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_PREFIX + ns);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      delete obj.v;
      return obj;
    } catch {
      return {};
    }
  }
  function mergeNamespace(ns, changes) {
    const key = STORAGE_KEY_PREFIX + ns;
    let current;
    try {
      current = JSON.parse(localStorage.getItem(key) || "{}");
    } catch {
      current = {};
    }
    for (const field of Object.keys(changes)) {
      const value = changes[field];
      if (isDefaultValue(field, value)) {
        delete current[field];
      } else {
        current[field] = value;
      }
    }
    delete current.v;
    if (Object.keys(current).length === 0) {
      localStorage.removeItem(key);
    } else {
      current.v = SCHEMA_VERSION;
      localStorage.setItem(key, JSON.stringify(current));
    }
  }
  var InMemoryBackend = class {
    constructor(seed) {
      this.state = { ...defaultState(), ...seed || {} };
    }
    read() {
      const url = readUrlState();
      const state = { ...this.state };
      for (const field of URL_ONLY_FIELDS) {
        state[field] = url[field];
      }
      return state;
    }
    write(changes) {
      for (const key of Object.keys(changes)) {
        if (URL_ONLY_FIELDS.has(key)) continue;
        this.state[key] = changes[key];
      }
    }
  };
  function storageWorks() {
    try {
      const k = STORAGE_KEY_PREFIX + "__probe__";
      localStorage.setItem(k, "1");
      const ok = localStorage.getItem(k) === "1";
      localStorage.removeItem(k);
      return ok;
    } catch {
      return false;
    }
  }
  var TIME_FIELDS = /* @__PURE__ */ new Set(["t", "off", "dir"]);
  var SHAREABLE_FIELDS = [
    "lat",
    "lon",
    "city",
    "tz",
    "bloc",
    "lsrc",
    "t",
    "off",
    "dir",
    "picks",
    "kyhand",
    "kmode",
    "op",
    "onoon",
    "body",
    "vnoon",
    "tp"
  ];
  var SHAREABLE_URL_KEYS = [
    "lat",
    "lon",
    "long",
    "city",
    "loc",
    "tz",
    "bloc",
    "lsrc",
    "t",
    "off",
    "dir",
    "picks",
    "kyhand",
    "kmode",
    "op",
    "onoon",
    "body",
    "vnoon",
    "tp"
  ];
  var CLEARED_URL_KEYS = [...SHAREABLE_URL_KEYS, "tc"];
  var SLOT_STORAGE_KEY = STORAGE_KEY_PREFIX + "slots";
  var SLOT_KEY_RE = /^[rd]\d+(tz|lat|lon)?$/;
  function urlSlotMap() {
    const out = {};
    for (const [k, v] of new URLSearchParams(window.location.search)) {
      if (SLOT_KEY_RE.test(k)) out[k] = v;
    }
    return out;
  }
  function storedSlotMap() {
    try {
      const obj = JSON.parse(localStorage.getItem(SLOT_STORAGE_KEY) || "{}");
      delete obj.v;
      return obj;
    } catch {
      return {};
    }
  }
  function urlHasSlotParams() {
    for (const k of new URLSearchParams(window.location.search).keys()) {
      if (SLOT_KEY_RE.test(k)) return true;
    }
    return false;
  }
  function hasShareableParamsInUrl() {
    const params = new URLSearchParams(window.location.search);
    return SHAREABLE_URL_KEYS.some((k) => params.has(k)) || urlHasSlotParams();
  }
  function shareableUrlEqualsStored(ls) {
    const url = readUrlState();
    const stored = ls.read();
    if (!SHAREABLE_FIELDS.every((f) => url[f] === stored[f])) return false;
    const u = urlSlotMap();
    const s = storedSlotMap();
    const keys = /* @__PURE__ */ new Set([...Object.keys(u), ...Object.keys(s)]);
    for (const k of keys) if (u[k] !== s[k]) return false;
    return true;
  }
  function urlScalarOverrides() {
    const params = new URLSearchParams(window.location.search);
    const url = readUrlState();
    const out = {};
    const has = (...keys) => keys.some((k) => params.has(k));
    if (has("lat")) out.lat = url.lat;
    if (has("lon", "long")) out.lon = url.lon;
    if (has("city")) out.city = url.city;
    if (has("tz")) out.tz = url.tz;
    if (has("bloc")) out.bloc = url.bloc;
    if (has("lsrc")) out.lsrc = url.lsrc;
    if (has("t")) out.t = url.t;
    if (has("off")) out.off = url.off;
    if (has("dir")) out.dir = url.dir;
    if (has("picks")) out.picks = url.picks;
    if (has("kyhand")) out.kyhand = url.kyhand;
    if (has("kmode")) out.kmode = url.kmode;
    if (has("op")) out.op = url.op;
    if (has("onoon")) out.onoon = url.onoon;
    if (has("body")) out.body = url.body;
    if (has("vnoon")) out.vnoon = url.vnoon;
    if (has("tp")) out.tp = url.tp;
    return out;
  }
  function clearShareableParamsFromUrl() {
    const params = new URLSearchParams(window.location.search);
    for (const k of CLEARED_URL_KEYS) params.delete(k);
    for (const k of [...params.keys()]) if (SLOT_KEY_RE.test(k)) params.delete(k);
    const qs = params.toString();
    history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : ""));
  }
  var activeBackend = null;
  var appName = "index";
  var sessionRePromptArmed = false;
  var warnedNoPersistence = false;
  var inMemorySlots = {};
  function initAppState(options) {
    appName = options.app;
    setPicksProvider(() => getState().picks);
    if (!LOCALSTORAGE_ENABLED) {
      activeBackend = new UrlBackend();
      return;
    }
    if (readUrlState().embed) {
      activeBackend = new UrlBackend();
      return;
    }
    if (!storageWorks()) {
      if (window.location.protocol === "file:") {
        activeBackend = new UrlBackend();
        showUrlModeBadge();
      } else {
        activeBackend = new InMemoryBackend(readUrlState());
        warnNoPersistence();
      }
      return;
    }
    const ls = new LocalStorageBackend(appName);
    if (!hasShareableParamsInUrl()) {
      activeBackend = ls;
      maybeShowParadigmNotice();
      return;
    }
    if (shareableUrlEqualsStored(ls)) {
      clearShareableParamsFromUrl();
      activeBackend = ls;
      maybeShowParadigmNotice();
      return;
    }
    activeBackend = new UrlBackend();
    void promptIncomingSettings(ls);
  }
  async function promptIncomingSettings(ls) {
    const choice = await showIncomingSettingsDialog({ mode: "incoming" });
    if (choice === "save") {
      adoptCurrentStateAsDefault(ls);
    } else {
      sessionRePromptArmed = true;
    }
  }
  function adoptCurrentStateAsDefault(ls) {
    const overrides = urlScalarOverrides();
    const slots = urlSlotMap();
    activeBackend = ls;
    ls.write(overrides);
    if (Object.keys(slots).length > 0) setSlotOverrides(slots);
    clearShareableParamsFromUrl();
    sessionRePromptArmed = false;
  }
  function warnNoPersistence() {
    if (warnedNoPersistence) return;
    warnedNoPersistence = true;
    showStorageWarning("Your settings can't be saved in this browser and won't persist after you reload.");
  }
  function maybeShowParadigmNotice() {
    let meta = {};
    try {
      meta = JSON.parse(localStorage.getItem(STORAGE_KEY_PREFIX + "meta") || "{}");
    } catch {
    }
    if (meta.noticeSeen) return;
    try {
      localStorage.setItem(STORAGE_KEY_PREFIX + "meta", JSON.stringify({ ...meta, noticeSeen: true, v: SCHEMA_VERSION }));
    } catch {
    }
    showParadigmNotice();
  }
  function downgradeToInMemory() {
    if (activeBackend instanceof InMemoryBackend) return;
    const seed = activeBackend ? activeBackend.read() : void 0;
    inMemorySlots = getSlotOverrides();
    activeBackend = new InMemoryBackend(seed);
    warnNoPersistence();
  }
  function backend() {
    if (!activeBackend) activeBackend = new UrlBackend();
    return activeBackend;
  }
  function hasNonTimePersistableChange(changes) {
    return Object.keys(changes).some(
      (k) => !TIME_FIELDS.has(k) && namespaceOf(k, appName) !== null
    );
  }
  function getState() {
    return backend().read();
  }
  function setState(changes) {
    try {
      backend().write(changes);
    } catch {
      downgradeToInMemory();
      backend().write(changes);
    }
    if (sessionRePromptArmed && hasNonTimePersistableChange(changes)) {
      sessionRePromptArmed = false;
      void promptSessionReprompt();
    }
  }
  function isPersistentMode() {
    return backend() instanceof LocalStorageBackend;
  }
  function getSlotOverrides() {
    const b = backend();
    if (b instanceof LocalStorageBackend) return storedSlotMap();
    if (b instanceof InMemoryBackend) return { ...inMemorySlots };
    return urlSlotMap();
  }
  function setSlotOverrides(changes) {
    const b = backend();
    if (b instanceof InMemoryBackend) {
      for (const [k, v] of Object.entries(changes)) {
        if (v == null) delete inMemorySlots[k];
        else inMemorySlots[k] = v;
      }
      return;
    }
    if (b instanceof LocalStorageBackend) {
      const cur = storedSlotMap();
      for (const [k, v] of Object.entries(changes)) {
        if (v == null) delete cur[k];
        else cur[k] = v;
      }
      delete cur.v;
      try {
        if (Object.keys(cur).length === 0) {
          localStorage.removeItem(SLOT_STORAGE_KEY);
        } else {
          cur.v = SCHEMA_VERSION;
          localStorage.setItem(SLOT_STORAGE_KEY, JSON.stringify(cur));
        }
      } catch {
        downgradeToInMemory();
        setSlotOverrides(changes);
      }
      return;
    }
    const params = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(changes)) {
      if (v == null) params.delete(k);
      else params.set(k, v);
    }
    const qs = params.toString();
    history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : ""));
  }
  async function promptSessionReprompt() {
    const choice = await showIncomingSettingsDialog({ mode: "reprompt" });
    if (choice === "save") {
      adoptCurrentStateAsDefault(new LocalStorageBackend(appName));
    }
  }

  // src/shared/hotkeys.ts
  var handlers = /* @__PURE__ */ new Map();
  var listenerInstalled = false;
  function registerHotkey(key, handler) {
    handlers.set(key.toLowerCase(), handler);
    if (listenerInstalled || typeof window === "undefined") return;
    listenerInstalled = true;
    window.addEventListener("keydown", (ev) => {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const target = ev.target;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      const handler2 = handlers.get(ev.key.toLowerCase());
      if (handler2) {
        ev.preventDefault();
        handler2();
      }
    });
  }

  // src/shared/app-nav.ts
  function appNavHref(page) {
    if (!isPersistentMode()) return page + window.location.search;
    const fps = new URLSearchParams(window.location.search).get("fps");
    return fps !== null ? `${page}?fps=${encodeURIComponent(fps)}` : page;
  }
  function initAppNavLinks(flushState) {
    document.querySelectorAll("a.app-nav-link").forEach((a) => {
      const page = a.dataset.page || a.getAttribute("href") || "index.html";
      const setHref = () => {
        a.href = appNavHref(page);
      };
      const flushAndSet = () => {
        flushState?.();
        setHref();
      };
      a.addEventListener("pointerdown", flushAndSet);
      a.addEventListener("focus", flushAndSet);
      setHref();
    });
  }
  function registerAppNavHotkeys(flushState) {
    const go = (page) => {
      const current = window.location.pathname.split("/").pop() || "index.html";
      if (current === page) return;
      flushState?.();
      window.location.href = appNavHref(page);
    };
    registerHotkey("i", () => go("inspector.html"));
    registerHotkey("o", () => go("observatory.html"));
    registerHotkey("c", () => go("index.html"));
    registerHotkey("a", () => go("all.html"));
  }

  // src/shared/help-popover.ts
  var activeGeneralHelpUrl = "help.html?embed=1";
  function openGeneralHelpTopic(hash) {
    const infoBtn = document.getElementById("info-btn");
    const section = document.getElementById("general-help-section");
    const iframe = document.getElementById("general-help-iframe");
    if (!infoBtn || !section || !iframe) return;
    infoBtn.click();
    if (!iframe.src) {
      iframe.src = activeGeneralHelpUrl + hash;
    } else {
      const w = iframe.contentWindow;
      if (w) w.location.hash = hash;
    }
    section.open = true;
  }

  // src/index-page.ts
  initAppState({ app: "index" });
  var isFileProtocol2 = window.location.protocol === "file:";
  loadCityData().catch(() => {
  });
  function updateLinks() {
    const search = window.location.search;
    document.querySelectorAll("a.face-card").forEach((a) => {
      const baseHref = a.getAttribute("data-base-href") || a.getAttribute("href");
      if (!a.hasAttribute("data-base-href")) a.setAttribute("data-base-href", baseHref);
      const url = new URL(baseHref, window.location.href);
      url.search = search;
      a.href = url.toString();
    });
    const pickCard = document.getElementById("pick-card");
    if (pickCard) {
      const hasPicks = !!getState().picks;
      const baseHref = hasPicks ? "selected.html" : "pick.html";
      const url = new URL(baseHref, window.location.href);
      url.search = search;
      pickCard.href = url.toString();
      const titleEl = document.getElementById("pick-card-title");
      const descEl = document.getElementById("pick-card-desc");
      if (titleEl) titleEl.textContent = hasPicks ? "Selected Faces" : "Pick Faces";
      if (descEl) descEl.textContent = hasPicks ? "View your chosen faces" : "Choose and order your favorite faces";
    }
  }
  function requestBrowserLocation(timeoutMs) {
    if (!navigator.geolocation) return Promise.resolve({ status: "unavailable" });
    return new Promise((resolve) => {
      const options = {};
      if (timeoutMs != null) options.timeout = timeoutMs;
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          console.log(`[Geolocation] fix: ${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)} (\xB1${Math.round(pos.coords.accuracy)}m)`);
          resolve({ status: "success", lat: pos.coords.latitude, lon: pos.coords.longitude });
        },
        (err) => {
          const codeName = err.code === err.PERMISSION_DENIED ? "PERMISSION_DENIED" : err.code === err.TIMEOUT ? "TIMEOUT" : "POSITION_UNAVAILABLE";
          console.warn(`[Geolocation] getCurrentPosition failed: ${codeName} \u2014 ${err.message}`);
          if (err.code === err.PERMISSION_DENIED) resolve({ status: "denied" });
          else if (err.code === err.TIMEOUT) resolve({ status: "timeout" });
          else resolve({ status: "unavailable" });
        },
        options
      );
    });
  }
  var locationPrompt = document.getElementById("location-prompt");
  var lpLatInput = document.getElementById("lp-lat");
  var lpLonInput = document.getElementById("lp-lon");
  var lpUseCoords = document.getElementById("lp-use-coords");
  var lpUseBrowser = document.getElementById("lp-use-browser");
  var lpCityInput = document.getElementById("lp-city-input");
  var lpCityResults = document.getElementById("lp-city-results");
  var lpGlobe = document.getElementById("lp-globe");
  var lpOsmContainer = document.getElementById("lp-osm-container");
  var lpOsmTile = document.getElementById("lp-osm-tile");
  var lpMapMarker = document.getElementById("lp-map-marker");
  var lpOsmOffline = document.getElementById("lp-osm-offline");
  var lpStatusSection = document.getElementById("lp-status-section");
  var lpNoLocation = document.getElementById("lp-no-location");
  var lpNoLocationHint = document.getElementById("lp-no-location-hint");
  var lpNoLocationDefault = document.getElementById("lp-no-location-default");
  var lpLocationName = document.getElementById("lp-location-name");
  var lpOsmAttribution = document.getElementById("lp-osm-attribution");
  var lpDoneBtn = document.getElementById("lp-done");
  var lpDialogFooter = lpDoneBtn.parentElement;
  var hasLocation = false;
  var browserBtnLabel = lpUseBrowser.textContent || "Use device location via browser";
  var currentLat = 0;
  var currentLon = 0;
  var locationSource = "";
  var locationFullLabel = "";
  var locationSourceType = "none";
  var needsPrompt = false;
  function showPrompt(geoDenied) {
    locationPrompt.style.display = "";
    if (geoDenied) {
      lpUseBrowser.disabled = true;
      lpUseBrowser.dataset.tooltip = isFileProtocol2 ? "Not all browsers support location access from file:// URLs" : "Browser location was not granted \u2014 check your browser settings to allow it";
      lpUseBrowser.textContent = browserBtnLabel + " (unavailable)";
    }
    if (hasLocation) {
      lpStatusSection.classList.add("visible");
      lpNoLocation.classList.add("hidden");
      updateMapPreview(currentLat, currentLon);
    } else {
      lpStatusSection.classList.remove("visible");
      lpNoLocation.classList.remove("hidden");
      if (needsPrompt) {
        lpNoLocationHint.style.display = "";
        lpNoLocationDefault.style.display = "none";
      } else {
        lpNoLocationHint.style.display = "none";
        lpNoLocationDefault.style.display = "";
      }
    }
    lpDialogFooter.classList.toggle("visible", hasLocation);
  }
  function hidePrompt() {
    locationPrompt.style.display = "none";
  }
  function buildLocationNameHTML() {
    if (locationSourceType === "city" && locationFullLabel) {
      return `${locationFullLabel} <span class="lp-loc-source">(from cities database)</span>`;
    }
    if (locationSourceType === "browser" || locationSourceType === "map" || locationSourceType === "manual") {
      const closest = findClosestCity(currentLat, currentLon);
      const sourceLabel = locationSourceType === "browser" ? "(from browser)" : locationSourceType === "map" ? "(from map)" : "(manually entered)";
      if (closest) {
        return `${closest.label} <span class="lp-loc-source">${sourceLabel}</span>`;
      }
      return `${currentLat.toFixed(3)}, ${currentLon.toFixed(3)} <span class="lp-loc-source">${sourceLabel}</span>`;
    }
    return `${currentLat.toFixed(3)}, ${currentLon.toFixed(3)}`;
  }
  function updateMapPreview(mapLat, mapLon) {
    lpStatusSection.classList.add("visible");
    lpNoLocation.classList.add("hidden");
    renderGlobe(lpGlobe, mapLat, mapLon);
    if (isFileProtocol2) {
      lpOsmContainer.style.display = "none";
      lpOsmAttribution.style.display = "none";
      lpGlobe.width = 160;
      lpGlobe.height = 160;
      lpGlobe.style.width = "160px";
      lpGlobe.style.height = "160px";
    } else {
      lpOsmContainer.style.display = "";
      lpOsmAttribution.style.display = "";
      lpOsmOffline.style.display = "none";
      loadOSMTile(lpOsmContainer, lpOsmTile, lpMapMarker, mapLat, mapLon).then((ok) => {
        lpOsmOffline.style.display = ok ? "none" : "";
      });
    }
    lpLocationName.innerHTML = buildLocationNameHTML();
  }
  function applyLocation(newLat, newLon, source, fullLabel, sourceType, writeToUrl, cityTz = null) {
    hasLocation = true;
    currentLat = newLat;
    currentLon = newLon;
    locationSource = source;
    locationFullLabel = fullLabel;
    locationSourceType = sourceType;
    if (writeToUrl) {
      const tz = cityTz ? cityTz : isCityDataLoaded() ? resolveTimezone(newLat, newLon, null) : null;
      setState({ bloc: false, lsrc: sourceType, lat: newLat, lon: newLon, city: source || null, ...tz ? { tz } : {} });
    }
    updateLinks();
    updateMapPreview(newLat, newLon);
    lpDialogFooter.classList.add("visible");
  }
  lpUseCoords.addEventListener("click", () => {
    const newLat = parseFloat(lpLatInput.value);
    const newLon = parseFloat(lpLonInput.value);
    if (isNaN(newLat) || isNaN(newLon)) return;
    applyLocation(newLat, newLon, "", "", "manual", true);
  });
  lpUseBrowser.addEventListener("click", async () => {
    lpUseBrowser.textContent = "Requesting\u2026";
    const result = await requestBrowserLocation();
    if (result.status === "success") {
      lpUseBrowser.textContent = browserBtnLabel;
      applyLocation(result.lat, result.lon, "", "", "browser", false);
      setState({ bloc: true, lsrc: null, lat: null, lon: null, city: null });
      updateLinks();
    } else if (result.status === "denied") {
      const btn = lpUseBrowser;
      btn.disabled = true;
      btn.textContent = browserBtnLabel + " (unavailable)";
      btn.dataset.tooltip = isFileProtocol2 ? "Not all browsers support location access from file:// URLs" : "Browser location was not granted \u2014 check your browser settings to allow it";
    } else {
      lpUseBrowser.textContent = browserBtnLabel;
    }
  });
  locationPrompt.querySelector(".lp-backdrop").addEventListener("click", () => {
    if (hasLocation) hidePrompt();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && locationPrompt.style.display !== "none") {
      if (hasLocation) hidePrompt();
    }
  });
  lpDoneBtn.addEventListener("click", () => {
    hidePrompt();
  });
  var citySearchDebounce = null;
  var cityDataLoading = false;
  var cityDataFailed = false;
  var selectedCityIndex = -1;
  function renderCityResults(results) {
    lpCityResults.innerHTML = "";
    selectedCityIndex = -1;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const div = document.createElement("div");
      div.className = "lp-city-item";
      if (r.isAirport) {
        const parts = r.label.split("  ");
        div.innerHTML = `<span class="iata-tag">${parts[0]}</span>${parts.slice(1).join("  ")}`;
      } else {
        div.textContent = r.label;
      }
      div.addEventListener("click", () => {
        applyLocation(r.lat, r.lon, r.shortLabel, r.label, "city", true, r.timezone || null);
        lpCityInput.value = "";
        lpCityResults.innerHTML = "";
        lpLatInput.value = r.lat.toFixed(3);
        lpLonInput.value = r.lon.toFixed(3);
      });
      lpCityResults.appendChild(div);
    }
  }
  async function onCityInput() {
    try {
      let query = lpCityInput.value.trim();
      if (query.length < 2) {
        lpCityResults.innerHTML = "";
        return;
      }
      if (cityDataFailed) {
        lpCityResults.innerHTML = `<div class="lp-city-loading">City search unavailable: ${loadError || "unknown error"}</div>`;
        return;
      }
      if (!isCityDataLoaded()) {
        if (!cityDataLoading) {
          cityDataLoading = true;
          lpCityResults.innerHTML = '<div class="lp-city-loading">Loading city database\u2026</div>';
          try {
            await loadCityData();
          } catch (err) {
            cityDataLoading = false;
            cityDataFailed = true;
            lpCityResults.innerHTML = `<div class="lp-city-loading">Failed to load city data: ${err.message}</div>`;
            return;
          }
          cityDataLoading = false;
          query = lpCityInput.value.trim();
          if (query.length < 2) {
            lpCityResults.innerHTML = "";
            return;
          }
        } else {
          return;
        }
      }
      const results = searchCities(query, 20);
      renderCityResults(results);
    } catch (err) {
      console.error("[CitySearch] Error:", err);
      lpCityResults.innerHTML = `<div class="lp-city-loading">Error: ${err.message}</div>`;
    }
  }
  function debounceCitySearch() {
    if (citySearchDebounce) clearTimeout(citySearchDebounce);
    citySearchDebounce = setTimeout(onCityInput, 150);
  }
  lpCityInput.addEventListener("input", debounceCitySearch);
  lpCityInput.addEventListener("keyup", debounceCitySearch);
  lpCityInput.addEventListener("compositionend", debounceCitySearch);
  lpCityInput.addEventListener("focus", () => {
    setTimeout(() => {
      lpCityInput.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 300);
  });
  lpCityInput.addEventListener("keydown", (e) => {
    const items = lpCityResults.querySelectorAll(".lp-city-item");
    if (items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedCityIndex = Math.min(selectedCityIndex + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle("selected", i === selectedCityIndex));
      items[selectedCityIndex].scrollIntoView({ block: "nearest" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedCityIndex = Math.max(selectedCityIndex - 1, 0);
      items.forEach((el, i) => el.classList.toggle("selected", i === selectedCityIndex));
      items[selectedCityIndex].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && selectedCityIndex >= 0) {
      e.preventDefault();
      items[selectedCityIndex].click();
    } else if (e.key === "Escape") {
      lpCityResults.innerHTML = "";
      lpCityInput.value = "";
    }
  });
  document.querySelectorAll('#other-apps-section .other-app[data-app="chronometer"]').forEach((el) => el.remove());
  initAppNavLinks();
  registerAppNavHotkeys();
  registerHotkey("h", () => document.getElementById("info-btn")?.click());
  registerHotkey("?", () => openGeneralHelpTopic("#hotkeys"));
  registerHotkey("l", () => showPrompt(false));
  (async function init() {
    const urlState = getState();
    if (urlState.lat !== null && urlState.lon !== null) {
      hasLocation = true;
      currentLat = urlState.lat;
      currentLon = urlState.lon;
      locationSource = urlState.city || "";
      locationSourceType = locationSourceOf(urlState);
      updateLinks();
    } else if (urlState.bloc) {
      const result = await requestBrowserLocation(1e4);
      if (result.status === "success") {
        hasLocation = true;
        currentLat = result.lat;
        currentLon = result.lon;
        locationSourceType = "browser";
        updateLinks();
      } else if (result.status === "denied") {
        needsPrompt = true;
        showPrompt(true);
        updateLinks();
      } else {
        needsPrompt = true;
        showPrompt(false);
        updateLinks();
      }
    } else {
      needsPrompt = true;
      showPrompt(false);
      updateLinks();
    }
  })();
})();
