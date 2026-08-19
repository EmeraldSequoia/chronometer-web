"use strict";
(() => {
  // src/astronomy/astro-constants.ts
  var kECAUInKilometers = 149597870691e-3;
  var kECLunarCycleInSeconds = 29.530589 * 24 * 3600;
  var kECRefractionAtHorizonX = 34 / 60 * Math.PI / 180;
  var kECCivilTwilightAltitude = -6 * Math.PI / 180;
  var kECNauticalTwilightAltitude = -12 * Math.PI / 180;
  var kECAstroTwilightAltitude = -18 * Math.PI / 180;
  var kECGoldenHourAltitude = 6 * Math.PI / 180;
  var kECLimitingAzimuthLatitude = 89 * Math.PI / 180;
  var planetRadiiInAU = [
    695500 / kECAUInKilometers,
    // Sun
    1737.1 / kECAUInKilometers,
    // Moon
    2439.7 / kECAUInKilometers,
    // Mercury
    6051.8 / kECAUInKilometers,
    // Venus
    6371 / kECAUInKilometers,
    // Earth
    3389.5 / kECAUInKilometers,
    // Mars
    69911 / kECAUInKilometers,
    // Jupiter
    58232 / kECAUInKilometers,
    // Saturn
    25362 / kECAUInKilometers,
    // Uranus
    24622 / kECAUInKilometers,
    // Neptune
    1195 / kECAUInKilometers
    // Pluto
  ];

  // src/astronomy/es-leap-second.ts
  var kECLeapEraStart = -915235200;
  var kECLeapTableValidUntil = 835833600;
  var kECTTMinusTAI = 32.184;
  var leapSecondTable = [
    -915235200,
    10,
    // 1 Jan 1972
    -899510400,
    11,
    // 1 Jul 1972
    -883612800,
    12,
    // 1 Jan 1973
    -852076800,
    13,
    // 1 Jan 1974
    -820540800,
    14,
    // 1 Jan 1975
    -789004800,
    15,
    // 1 Jan 1976
    -757382400,
    16,
    // 1 Jan 1977
    -725846400,
    17,
    // 1 Jan 1978
    -694310400,
    18,
    // 1 Jan 1979
    -662774400,
    19,
    // 1 Jan 1980
    -615513600,
    20,
    // 1 Jul 1981
    -583977600,
    21,
    // 1 Jul 1982
    -552441600,
    22,
    // 1 Jul 1983
    -489283200,
    23,
    // 1 Jul 1985
    -410313600,
    24,
    // 1 Jan 1988
    -347155200,
    25,
    // 1 Jan 1990
    -315619200,
    26,
    // 1 Jan 1991
    -268358400,
    27,
    // 1 Jul 1992
    -236822400,
    28,
    // 1 Jul 1993
    -205286400,
    29,
    // 1 Jul 1994
    -157852800,
    30,
    // 1 Jan 1996
    -110592e3,
    31,
    // 1 Jul 1997
    -63158400,
    32,
    // 1 Jan 1999
    157766400,
    33,
    // 1 Jan 2006
    252460800,
    34,
    // 1 Jan 2009
    362793600,
    35,
    // 1 Jul 2012
    457401600,
    36,
    // 1 Jul 2015
    504921600,
    37
    // 1 Jan 2017
  ];
  var _cachedIndex = leapSecondTable.length - 2;
  function taiMinusUTCForDateInterval(dateInterval) {
    const cached = _cachedIndex;
    if (dateInterval >= leapSecondTable[cached] && (cached + 2 >= leapSecondTable.length || dateInterval < leapSecondTable[cached + 2])) {
      return leapSecondTable[cached + 1];
    }
    if (dateInterval < leapSecondTable[0]) {
      return leapSecondTable[1];
    }
    let lo = 0;
    let hi = leapSecondTable.length / 2 - 1;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (leapSecondTable[mid * 2] <= dateInterval) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    _cachedIndex = lo * 2;
    return leapSecondTable[lo * 2 + 1];
  }
  function ttMinusUTCForDateInterval(dateInterval) {
    return kECTTMinusTAI + taiMinusUTCForDateInterval(dateInterval);
  }

  // src/astronomy/es-time.ts
  var ES_MIN_ASTRO_DATE = -189344476800;
  var ES_MAX_ASTRO_DATE = 25245561600;
  var MIN_DISPLAY_DATE_MS = (ES_MIN_ASTRO_DATE + 978307200) * 1e3;
  var MAX_DISPLAY_DATE_MS = (ES_MAX_ASTRO_DATE + 978307200) * 1e3;
  function espenakDeltaT(yearValue) {
    if (yearValue >= 2005 && yearValue <= 2050) {
      const t = yearValue - 2e3;
      return 62.92 + 0.32217 * t + 5589e-6 * t * t;
    } else if (yearValue < -500 || yearValue >= 2150) {
      const u = (yearValue - 1820) / 100;
      return -20 + 32 * u * u;
    } else if (yearValue < 500) {
      const u = yearValue / 100;
      const u2 = u * u;
      const u3 = u2 * u;
      const u4 = u2 * u2;
      const u5 = u3 * u2;
      const u6 = u3 * u3;
      return 10583.6 - 1014.41 * u + 33.78311 * u2 - 5.952053 * u3 - 0.1798452 * u4 + 0.022174192 * u5 + 0.0090316521 * u6;
    } else if (yearValue < 1600) {
      const u = (yearValue - 1e3) / 100;
      const u2 = u * u;
      const u3 = u2 * u;
      const u4 = u2 * u2;
      const u5 = u3 * u2;
      const u6 = u3 * u3;
      return 1574.2 - 556.01 * u + 71.23472 * u2 + 0.319781 * u3 - 0.8503463 * u4 - 5050998e-9 * u5 + 0.0083572073 * u6;
    } else if (yearValue < 1700) {
      const t = yearValue - 1600;
      const t2 = t * t;
      const t3 = t2 * t;
      return 120 - 0.9808 * t - 0.01532 * t2 + t3 / 7129;
    } else if (yearValue < 1800) {
      const t = yearValue - 1700;
      const t2 = t * t;
      const t3 = t2 * t;
      const t4 = t2 * t2;
      return 8.83 + 0.1603 * t - 59285e-7 * t2 + 13336e-8 * t3 - t4 / 1174e3;
    } else if (yearValue < 1860) {
      const t = yearValue - 1800;
      const t2 = t * t;
      const t3 = t2 * t;
      const t4 = t2 * t2;
      const t5 = t3 * t2;
      const t6 = t3 * t3;
      const t7 = t4 * t3;
      return 13.72 - 0.332447 * t + 68612e-7 * t2 + 41116e-7 * t3 - 37436e-8 * t4 + 121272e-10 * t5 - 1699e-10 * t6 + 875e-12 * t7;
    } else if (yearValue < 1900) {
      const t = yearValue - 1860;
      const t2 = t * t;
      const t3 = t2 * t;
      const t4 = t2 * t2;
      const t5 = t3 * t2;
      return 7.62 + 0.5737 * t - 0.251754 * t2 + 0.01680668 * t3 - 4473624e-10 * t4 + t5 / 233174;
    } else if (yearValue < 1920) {
      const t = yearValue - 1900;
      const t2 = t * t;
      const t3 = t2 * t;
      const t4 = t2 * t2;
      return -2.79 + 1.494119 * t - 0.0598939 * t2 + 61966e-7 * t3 - 197e-6 * t4;
    } else if (yearValue < 1941) {
      const t = yearValue - 1920;
      const t2 = t * t;
      const t3 = t2 * t;
      return 21.2 + 0.84493 * t - 0.0761 * t2 + 20936e-7 * t3;
    } else if (yearValue < 1961) {
      const t = yearValue - 1950;
      const t2 = t * t;
      const t3 = t2 * t;
      return 29.07 + 0.407 * t - t2 / 233 + t3 / 2547;
    } else if (yearValue < 1986) {
      const t = yearValue - 1975;
      const t2 = t * t;
      const t3 = t2 * t;
      return 45.45 + 1.067 * t - t2 / 260 - t3 / 718;
    } else if (yearValue < 2005) {
      const t = yearValue - 2e3;
      const t2 = t * t;
      const t3 = t2 * t;
      const t4 = t2 * t2;
      const t5 = t3 * t2;
      return 63.86 + 0.3345 * t - 0.060374 * t2 + 17275e-7 * t3 + 651814e-9 * t4 + 2373599e-11 * t5;
    } else {
      const t1 = (yearValue - 1820) / 100;
      return -20 + 32 * t1 * t1 - 0.5628 * (2150 - yearValue);
    }
  }
  var _leapRejoinOffset = null;
  function leapRejoinOffset() {
    if (_leapRejoinOffset === null) {
      _leapRejoinOffset = espenakDeltaT(yearValueForDateInterval(kECLeapTableValidUntil)) - ttMinusUTCForDateInterval(kECLeapTableValidUntil);
    }
    return _leapRejoinOffset;
  }
  function yearValueForDateInterval(utSeconds) {
    const d = new Date((utSeconds + 978307200) * 1e3);
    const year = d.getUTCFullYear();
    const jan1 = Date.UTC(year, 0, 1) / 1e3 - 978307200;
    return year + (utSeconds - jan1) / (365.25 * 24 * 3600);
  }
  function convertUTtoET(ut, yearValue) {
    if (ut < kECLeapEraStart) {
      return ut + espenakDeltaT(yearValue);
    }
    if (ut <= kECLeapTableValidUntil) {
      return ut + ttMinusUTCForDateInterval(ut);
    }
    return ut + espenakDeltaT(yearValue) - leapRejoinOffset();
  }
  function convertETtoUT(et) {
    let ut = et;
    for (let i = 0; i < 2; i++) {
      ut = et - (convertUTtoET(ut, yearValueForDateInterval(ut)) - ut);
    }
    return ut;
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

  // src/eclipse-table-page.ts
  var APPLE_EPOCH_UNIX_S = 978307200;
  function utcMsForTdMs(tdMs) {
    const etSeconds = tdMs / 1e3 - APPLE_EPOCH_UNIX_S;
    return (convertETtoUT(etSeconds) + APPLE_EPOCH_UNIX_S) * 1e3;
  }
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function formatUtcDate(utcMs) {
    const d = new Date(roundToMinute(utcMs));
    return `${d.getUTCFullYear()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  function formatUtcTime(utcMs) {
    const d = new Date(roundToMinute(utcMs));
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
  }
  function roundToMinute(ms) {
    return Math.round(ms / 6e4) * 6e4;
  }
  function formatCoords(lat, lon) {
    const latStr = `${Math.abs(lat).toFixed(2)}\xB0${lat >= 0 ? "N" : "S"}`;
    const lonStr = `${Math.abs(lon).toFixed(2)}\xB0${lon >= 0 ? "E" : "W"}`;
    return `${latStr} ${lonStr}`;
  }
  var KIND_LABELS = {
    "partial-solar": "Partial solar",
    "annular-solar": "Annular solar",
    "total-solar": "Total solar",
    "hybrid-solar": "Hybrid solar",
    "partial-lunar": "Partial lunar",
    "total-lunar": "Total lunar"
  };
  function kindLabel(kind) {
    return KIND_LABELS[kind] ?? kind;
  }
  function queryFor(e, extra) {
    const params = new URLSearchParams(extra);
    params.set("lat", String(e.lat));
    params.set("lon", String(e.lon));
    params.set("tz", e.tz);
    params.set("t", String(Math.round(utcMsForTdMs(e.tdMs))));
    params.set("dir", "0");
    return params.toString();
  }
  function observatoryUrl(e) {
    return `observatory.html?${queryFor(e, [])}`;
  }
  function chronometerUrl(e) {
    const body = e.kind.endsWith("-lunar") ? "moon" : "sun";
    return `selected.html?${queryFor(e, [["picks", "bsvzsl"], ["body", body]])}`;
  }
  function buildCard(doc, e, utcMs, past) {
    const card = doc.createElement("div");
    card.className = past ? "ek-card ek-past" : "ek-card";
    const iconNS = "http://www.w3.org/2000/svg";
    const icon = doc.createElementNS(iconNS, "svg");
    icon.setAttribute("class", "ek-icon");
    icon.setAttribute("aria-hidden", "true");
    const use = doc.createElementNS(iconNS, "use");
    use.setAttribute("href", `#ek-${e.kind}`);
    icon.appendChild(use);
    card.appendChild(icon);
    const globe = doc.createElement("span");
    globe.className = "ek-globe";
    globe.setAttribute("aria-hidden", "true");
    globe.dataset.lat = String(e.lat);
    globe.dataset.lon = String(e.lon);
    card.appendChild(globe);
    const main = doc.createElement("div");
    main.className = "ek-main";
    const when = doc.createElement("div");
    when.className = "ek-when";
    const date = doc.createElement("b");
    date.textContent = formatUtcDate(utcMs);
    const time = doc.createElement("span");
    time.className = "ek-time";
    time.textContent = formatUtcTime(utcMs);
    when.append(date, " ", time);
    const desc = doc.createElement("div");
    desc.className = "ek-desc";
    desc.textContent = `${kindLabel(e.kind)} \u2014 ${e.pathRegion ?? e.region}`;
    const where = doc.createElement("div");
    where.className = "ek-where";
    where.textContent = formatCoords(e.lat, e.lon);
    main.append(when, desc, where);
    card.appendChild(main);
    const links = doc.createElement("div");
    links.className = "ek-links";
    const obs = doc.createElement("a");
    obs.href = observatoryUrl(e);
    obs.textContent = "Observatory";
    const chrono = doc.createElement("a");
    chrono.href = chronometerUrl(e);
    chrono.textContent = "Chronometer";
    const details = doc.createElement("a");
    details.href = e.url;
    details.target = "_blank";
    details.rel = "noopener";
    details.className = "ek-ext";
    details.textContent = "Details";
    const ext = doc.createElement("img");
    ext.src = "help/images/extlink.png";
    ext.alt = "(external link)";
    ext.className = "ek-extlink";
    details.appendChild(ext);
    links.append(obs, chrono, details);
    card.appendChild(links);
    return card;
  }
  function buildTodayMarker(doc, nowMs, ranOut) {
    const marker = doc.createElement("div");
    marker.className = "ek-today";
    marker.id = "today";
    const d = new Date(nowMs);
    const date = `${d.getUTCFullYear()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, "0")}`;
    marker.textContent = ranOut ? `\u2014 Today \xB7 ${date} \u2014 every eclipse listed is in the past \u2014` : `\u2014 Today \xB7 ${date} \u2014 eclipses above have happened; those below are coming \u2014`;
    return marker;
  }
  function renderEclipseTable(data, container, nowMs) {
    const doc = container.ownerDocument;
    container.textContent = "";
    const rows = data.eclipses.map((e) => ({ e, utcMs: utcMsForTdMs(e.tdMs) })).sort((a, b) => a.utcMs - b.utcMs);
    const markerIndex = rows.findIndex((r) => r.utcMs > nowMs);
    const ranOut = markerIndex === -1;
    const allYears = [...new Set(rows.map((r) => new Date(r.utcMs).getUTCFullYear()))];
    let openYears = [];
    if (ranOut) {
      if (allYears.length > 0) openYears = [allYears[allYears.length - 1]];
    } else {
      const containing = new Date(rows[markerIndex].utcMs).getUTCFullYear();
      const ci = allYears.indexOf(containing);
      openYears = allYears.slice(Math.max(0, ci - 1), ci + 2);
    }
    let group = null;
    let groupBody = null;
    let groupYear = NaN;
    rows.forEach((row, i) => {
      const year = new Date(row.utcMs).getUTCFullYear();
      if (year !== groupYear) {
        groupYear = year;
        group = doc.createElement("details");
        group.className = "ek-year";
        group.dataset.year = String(year);
        if (openYears.includes(year)) group.setAttribute("open", "");
        const yearRows = rows.filter((r) => new Date(r.utcMs).getUTCFullYear() === year);
        const summary = doc.createElement("summary");
        const label = doc.createElement("span");
        const yearB = doc.createElement("b");
        yearB.textContent = String(year);
        label.append(yearB, ` \xB7 ${yearRows.length} eclipse${yearRows.length === 1 ? "" : "s"} `);
        const minis = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
        minis.setAttribute("class", "ek-minis");
        minis.setAttribute("viewBox", `0 0 ${yearRows.length * 26} 24`);
        minis.setAttribute("width", String(yearRows.length * 17));
        minis.setAttribute("height", "16");
        minis.setAttribute("aria-hidden", "true");
        yearRows.forEach((r, j) => {
          const use = doc.createElementNS("http://www.w3.org/2000/svg", "use");
          use.setAttribute("href", `#ek-${r.e.kind}`);
          use.setAttribute("x", String(j * 26));
          use.setAttribute("width", "24");
          use.setAttribute("height", "24");
          minis.appendChild(use);
        });
        label.appendChild(minis);
        summary.appendChild(label);
        group.appendChild(summary);
        groupBody = doc.createElement("div");
        groupBody.className = "ek-cards";
        group.appendChild(groupBody);
        container.appendChild(group);
      }
      if (i === markerIndex) {
        groupBody.appendChild(buildTodayMarker(doc, nowMs, false));
      }
      groupBody.appendChild(buildCard(doc, row.e, row.utcMs, row.utcMs <= nowMs));
    });
    if (ranOut && rows.length > 0) {
      container.appendChild(buildTodayMarker(doc, nowMs, true));
      const note = doc.createElement("div");
      note.className = "ek-ranout";
      note.textContent = "This table has run out \u2014 every eclipse listed is in the past. Re-run scripts/scrape-eclipses.mjs to extend it (see the source note above).";
      container.appendChild(note);
    }
    return { openYears, markerIndex: ranOut ? rows.length : markerIndex, ranOut };
  }
  var scratchCanvas = null;
  var globeQueue = Promise.resolve();
  function renderGlobeDataUrl(lat, lon, sizePx) {
    const run = globeQueue.then(async () => {
      scratchCanvas ?? (scratchCanvas = document.createElement("canvas"));
      if (scratchCanvas.width !== sizePx) {
        scratchCanvas.width = sizePx;
        scratchCanvas.height = sizePx;
      }
      if (!scratchCanvas.getContext("2d")) return "";
      await renderGlobe(scratchCanvas, lat, lon);
      return scratchCanvas.toDataURL("image/png");
    });
    globeQueue = run.catch(() => void 0);
    return run;
  }
  function hydrateGlobes(container, renderer = renderGlobeDataUrl) {
    const sizePx = 96;
    const hydrateGroup = (group) => {
      for (const globe of group.querySelectorAll(".ek-globe[data-lat]")) {
        const lat = Number(globe.dataset.lat);
        const lon = Number(globe.dataset.lon);
        delete globe.dataset.lat;
        delete globe.dataset.lon;
        void renderer(lat, lon, sizePx).then(
          (url) => {
            if (url) globe.style.backgroundImage = `url(${url})`;
          },
          () => {
          }
          // a failed globe render leaves the plain disc
        );
      }
    };
    for (const group of container.querySelectorAll("details.ek-year")) {
      if (group.open) hydrateGroup(group);
      else group.addEventListener("toggle", () => hydrateGroup(group), { once: true });
    }
  }
  function renderMeta(data, doc, nowMs) {
    const span = doc.getElementById("ek-span");
    if (span) span.textContent = `${data.meta.startYear} through ${data.meta.endYear}`;
    const counts = doc.getElementById("ek-counts");
    if (counts) {
      counts.textContent = `${data.meta.counts.solar} solar and ${data.meta.counts.lunar} lunar eclipses`;
    }
    const generated = doc.getElementById("ek-generated");
    if (generated) generated.textContent = data.meta.generated;
    const stale = doc.getElementById("ek-stale");
    if (stale) {
      const coverageEndMs = Date.UTC(data.meta.endYear, 11, 31);
      const oneYearMs = 365 * 24 * 3600 * 1e3;
      if (nowMs > coverageEndMs - oneYearMs) {
        stale.textContent = `This table's coverage ends in ${data.meta.endYear} \u2014 time to re-run scripts/scrape-eclipses.mjs to extend it.`;
        stale.hidden = false;
      }
    }
  }
  function initPage() {
    const block = document.getElementById("eclipse-data");
    const container = document.getElementById("eclipse-list");
    if (!block || !container) return;
    let data;
    try {
      data = JSON.parse(block.textContent ?? "");
      if (!Array.isArray(data.eclipses) || data.eclipses.length === 0) throw new Error("no eclipse rows");
    } catch (err) {
      container.textContent = `Could not load the eclipse data baked into this page (${err.message}). This is a build problem \u2014 the {{ECLIPSE_DATA}} injection failed.`;
      container.className = "ek-error";
      return;
    }
    const now = Date.now();
    renderMeta(data, document, now);
    renderEclipseTable(data, container, now);
    hydrateGlobes(container);
    document.getElementById("ek-expand")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      for (const d of document.querySelectorAll("details.ek-year")) d.setAttribute("open", "");
      hydrateGlobes(container);
    });
    const nav = performance.getEntriesByType?.("navigation")?.[0];
    const isReload = nav?.type === "reload" || nav?.type === "back_forward";
    if (!location.hash && !isReload) {
      const recenter = () => document.getElementById("today")?.scrollIntoView({ block: "center" });
      recenter();
      let userScrolled = false;
      for (const evt of ["wheel", "pointerdown", "keydown"]) {
        window.addEventListener(evt, () => {
          userScrolled = true;
        }, { once: true, passive: true });
      }
      window.addEventListener("load", () => {
        if (!userScrolled) recenter();
      }, { once: true });
    }
  }
  if (typeof document !== "undefined") initPage();
})();
