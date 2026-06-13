// Type declarations for the auto-generated cities-data.js module (format v2).
//
// The module assigns a columnar payload to window.ChronometerCities and invokes
// window._chronCitiesCallback. It does not export anything; city-search.ts reads
// the global and decodes it. See planning/2026-06-13-observatory-cities-columnar.md.

export interface ChronometerCitiesV2 {
    v: 2;
    N: number;   // city count
    aN: number;  // airport count
    TZ: string[];
    CC: string[];
    AD: string[];
    /** Sparse map: city row index (as string key) -> admin2/county name. */
    ad2: Record<string, string>;
    // Numeric columns: base64 of raw little-endian typed-array bytes.
    cLat: string; cLon: string; cPop: string;  // Int32 (lat/lon = round(deg*1000)), Uint32
    cTz: string; cCc: string; cAd1: string;     // Uint16 indices into TZ/CC/AD
    // Text columns: newline-joined; row i is the slice between newline i and i+1.
    names: string; ascii: string; alts: string;
    aLat: string; aLon: string; aTz: string; aCc: string;  // airport numeric columns
    aIata: string; aCity: string;                          // airport text columns
}

declare global {
    interface Window {
        ChronometerCities?: ChronometerCitiesV2;
        _chronCitiesCallback?: (data: ChronometerCitiesV2) => void;
    }
}
