/**
 * Terra worldtime ring slot validation.
 *
 * Implements the iOS ECGeoNames.m logic for determining which ring
 * slot(s) a timezone can occupy. Each slot's label is centered at
 * offsetHour + 0.5 UTC hours; a timezone is valid for a slot if its
 * "center" (average of standard and DST offsets) is within ±30 minutes
 * of the slot center.
 */

import type { TerraSlot } from './watch-env.js';
import { TERRA_RING_DEFAULTS } from './watch-env.js';

// Constants matching iOS ECFactoryUI.m (renumbered 1-based for web)
const FIRST_ENV_SLOT = 1;
const UTC_SECTOR_NUMBER = 11;

/**
 * Convert env slot number (1–24) to UTC offset hour (-11 to +12).
 */
export function getSlotOffsetHour(envSlot: number): number {
    return envSlot - FIRST_ENV_SLOT - UTC_SECTOR_NUMBER;
}

/**
 * Compute the timezone's "center" in minutes from UTC.
 *
 * For DST zones: average of standard and DST offsets.
 * For non-DST zones: the single offset.
 *
 * Uses Intl.DateTimeFormat to determine offsets at January and July,
 * matching the approach in watch-env.ts.
 */
export function computeTzCenter(olsonId: string): number {
    try {
        const now = new Date();
        const jan = new Date(now.getFullYear(), 0, 1);
        const jul = new Date(now.getFullYear(), 6, 1);
        const janOff = getTzOffsetMinutes(olsonId, jan);
        const julOff = getTzOffsetMinutes(olsonId, jul);
        if (janOff === julOff) {
            // No DST
            return janOff;
        }
        // DST zone: return average of std and dst offsets
        return (janOff + julOff) / 2;
    } catch {
        return 0;
    }
}

/**
 * Get UTC offset in minutes for a timezone at a given date.
 */
function getTzOffsetMinutes(olsonId: string, date: Date): number {
    try {
        const fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: olsonId,
            timeZoneName: 'longOffset',
        });
        const parts = fmt.formatToParts(date);
        const tzPart = parts.find(p => p.type === 'timeZoneName');
        if (!tzPart) return 0;
        const tzStr = tzPart.value;
        if (tzStr === 'GMT' || tzStr === 'UTC') return 0;
        const m = tzStr.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
        if (!m) return 0;
        const sign = m[1] === '+' ? 1 : -1;
        const hours = parseInt(m[2], 10);
        const minutes = m[3] ? parseInt(m[3], 10) : 0;
        return sign * (hours * 60 + minutes);
    } catch {
        return 0;
    }
}

/**
 * Check if a timezone with the given center (in minutes) is valid for a slot.
 * Ported from iOS ECGeoNames.m `validTZCenteredAt:forSlot:`.
 *
 * @param tzCenter  Timezone center in minutes from UTC
 * @param offsetHours  Slot's UTC offset hour (-11 to +12)
 */
export function validTZCenteredAt(tzCenter: number, offsetHours: number): boolean {
    const centerSlotMinutes = offsetHours * 60 + 30;
    let distance = centerSlotMinutes - tzCenter;
    if (distance > 12 * 60) {
        distance -= 24 * 60;
    } else if (distance < -12 * 60) {
        distance += 24 * 60;
    }
    return Math.abs(distance) <= 30;
}

/**
 * Return the list of valid env slot numbers (1–24) for a given timezone.
 */
export function validSlotsForTz(olsonId: string): number[] {
    const tzCenter = computeTzCenter(olsonId);
    const result: number[] = [];
    for (let slot = 1; slot <= 24; slot++) {
        const offsetHour = getSlotOffsetHour(slot);
        if (validTZCenteredAt(tzCenter, offsetHour)) {
            result.push(slot);
        }
    }
    return result;
}

/**
 * Format a human-readable UTC offset label for a slot.
 * e.g., slot 11 → "UTC-5", slot 16 → "UTC±0", slot 21 → "UTC+5:30"
 */
export function formatSlotOffset(envSlot: number): string {
    const h = getSlotOffsetHour(envSlot);
    if (h === 0) return 'UTC±0';
    const sign = h > 0 ? '+' : '';
    return `UTC${sign}${h}`;
}

/**
 * Get the standard-time (non-DST) UTC offset in minutes for a timezone.
 * Returns the minimum of the January and July offsets, which corresponds
 * to the standard-time offset for both northern and southern hemispheres.
 */
export function getStandardOffsetMinutes(olsonId: string): number {
    try {
        const now = new Date();
        const jan = new Date(now.getFullYear(), 0, 1);
        const jul = new Date(now.getFullYear(), 6, 1);
        const janOff = getTzOffsetMinutes(olsonId, jan);
        const julOff = getTzOffsetMinutes(olsonId, jul);
        return Math.min(janOff, julOff);
    } catch {
        return 0;
    }
}

/**
 * Extract a reasonable city name from an Olson timezone ID.
 * e.g., "America/New_York" → "New York", "Asia/Kolkata" → "Kolkata"
 */
export function olsonIdToCityName(olsonId: string): string {
    const parts = olsonId.split('/');
    const city = parts[parts.length - 1];
    return city.replace(/_/g, ' ');
}

/** Number of Terra worldtime ring slots (env slots 1–24). */
export const TERRA_RING_SLOT_COUNT = 24;

/**
 * Parse the user's Terra ring overrides from the flat persisted slot map
 * (`r{slot}`, `r{slot}tz`, `r{slot}lat`, `r{slot}lon` — see app-state
 * getSlotOverrides). A slot needs at least a name and a timezone; missing
 * coordinates read as 0.
 */
export function parseTerraUserOverrides(slotParams: Record<string, string>): Record<number, TerraSlot> {
    const userOverrides: Record<number, TerraSlot> = {};
    for (let slot = 1; slot <= TERRA_RING_SLOT_COUNT; slot++) {
        const name = slotParams[`r${slot}`] ?? null;
        const tz = slotParams[`r${slot}tz`] ?? null;
        const latStr = slotParams[`r${slot}lat`] ?? null;
        const lonStr = slotParams[`r${slot}lon`] ?? null;
        if (name && tz) {
            userOverrides[slot] = {
                cityName: name,
                olsonId: tz,
                lat: latStr ? parseFloat(latStr) : 0,
                lon: lonStr ? parseFloat(lonStr) : 0,
            };
        }
    }
    return userOverrides;
}

/**
 * Serialize the user's Terra ring overrides into a flat slot-map change set
 * for app-state setSlotOverrides: every ring key is cleared (null), then the
 * given slots are set (coordinates to 3 dp). Callers pass the USER overrides
 * only — never the display table, which also carries the auto-injected
 * observer slot (recomputed from the location on every rebuild, never stored).
 */
export function serializeTerraOverrides(userOverrides: Record<number, TerraSlot> | undefined): Record<string, string | null> {
    const changes: Record<string, string | null> = {};
    for (let slot = 1; slot <= TERRA_RING_SLOT_COUNT; slot++) {
        changes[`r${slot}`] = null;
        changes[`r${slot}tz`] = null;
        changes[`r${slot}lat`] = null;
        changes[`r${slot}lon`] = null;
    }
    if (userOverrides) {
        for (const [slotStr, data] of Object.entries(userOverrides)) {
            changes[`r${slotStr}`] = data.cityName;
            changes[`r${slotStr}tz`] = data.olsonId;
            changes[`r${slotStr}lat`] = data.lat.toFixed(3);
            changes[`r${slotStr}lon`] = data.lon.toFixed(3);
        }
    }
    return changes;
}
