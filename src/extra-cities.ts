export type ExtraCity = {
    name: string;
    latitude: number;
    longitude: number;
    olsonTimezone: string;
    countryCode: string;    // ISO 3166 two-letter code, uppercase
    admin1Name?: string;    // state/province display name, e.g. "California" (default '')
    admin2Name?: string;    // county/district display name, e.g. "San Mateo County" (default '')
    // Note: population is both the search-result ranking key and the selection
    // key for the map-drag pick (findLargestCityNear). A tiny value means the
    // entry is findable by typed search but will never win the map-drag pick.
    population: number;
}

export const extraCities: ExtraCity[] = [
    {
        name: "Dolphin Island", latitude: -17.3053513,
        longitude: 178.2253116, olsonTimezone: 'Pacific/Fiji',
        countryCode: 'FJ', population: 10
    },
    {
        // Admin/state/country/timezone from GeoNames "Emerald Lake Hills"
        // (geonameid 5346413); population is half of its 4278.
        name: "Emerald Hills", latitude: 37.46082428240359,
        longitude: -122.26997850548051, olsonTimezone: 'America/Los_Angeles',
        countryCode: 'US', admin1Name: 'California',
        admin2Name: 'San Mateo County', population: 2139
    }
];
