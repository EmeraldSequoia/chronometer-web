/**
 * Observer-slot derivation for the world-time faces.
 *
 * Terra (worldTimeRing) shows the observer's location in the ring slot whose
 * UTC offset matches the current timezone; Gaia (worldTimeSubdials) shows it
 * in subdial slot 1. This module derives those slot tables from the user's
 * persisted overrides plus the observer's location — pure, so the engine's
 * startup and every in-session location/timezone change go through the same
 * derivation, and it can be unit-tested without booting the engine.
 *
 * Two tables come out for Terra:
 *   - `overrides`      — the DISPLAY table: the user's overrides with the
 *                        observer injected on top of the matching slot.
 *   - `userOverrides`  — the user's overrides alone. This is what the Terra
 *                        city dialog persists; the injected observer is
 *                        recomputed from the location on every rebuild and
 *                        must never be stored (see serializeTerraOverrides).
 *
 * City-name priority for the observer slot (docs/world-time-slots.md):
 * locationSource → nearest DB city (when the DB is parsed) →
 * olsonIdToCityName(timezone) → 'Local'.
 */

import type { TerraSlot } from './watch-env.js';
import { TERRA_RING_DEFAULTS, GAIA_SUBDIAL_DEFAULTS } from './watch-env.js';
import { validSlotsForTz, getStandardOffsetMinutes, olsonIdToCityName, parseTerraUserOverrides } from './terra-slots.js';

/** The watch feature flags the derivation reads. */
export interface ObserverSlotWatch {
    worldTimeRing: boolean;
    worldTimeSubdials: boolean;
    /** Gaia: number of subdials (slot 1 = observer, 2..N = cities). */
    maxSeparateLoc?: number;
}

export interface ObserverSlotContext {
    lat: number;
    lon: number;
    /** Resolved IANA zone of the observer, if known. */
    locationTimezone: string | undefined;
    /** Explicit name for the observer (city pick / stored name), or ''. */
    locationSource: string;
    /** The persisted flat slot map (app-state getSlotOverrides()). */
    slotParams: Record<string, string>;
    /** Nearest DB city name for (lat, lon), or null when the DB is not parsed. */
    nearestCityName: () => string | null;
}

export interface SlotOverrideResult {
    /** Display table: user overrides plus the injected observer slot. */
    overrides: Record<number, TerraSlot>;
    /** worldTimeRing only: the user's overrides alone (what gets persisted). */
    userOverrides?: Record<number, TerraSlot>;
    /** worldTimeRing only: the ring slot holding the observer (1–24). */
    globalLocationSlot?: number;
}

/** Observer display name: locationSource → nearest DB city → timezone city → 'Local'. */
export function resolveObserverName(ctx: ObserverSlotContext): string {
    if (ctx.locationSource) return ctx.locationSource;
    if (ctx.lat !== 0 || ctx.lon !== 0) {
        const nearest = ctx.nearestCityName();
        if (nearest) return nearest;
    }
    if (ctx.locationTimezone) return olsonIdToCityName(ctx.locationTimezone);
    return 'Local';
}

/**
 * Derive the slot tables for a world-time face. Returns undefined for faces
 * without world-time features.
 */
export function deriveObserverSlots(watch: ObserverSlotWatch, ctx: ObserverSlotContext): SlotOverrideResult | undefined {
    const { lat, lon, locationTimezone, slotParams } = ctx;

    if (watch.worldTimeRing) {
        // Collect user overrides from persisted slot state
        const userOverrides = parseTerraUserOverrides(slotParams);

        // Start with user overrides; the observer slot is injected on top
        // below (display only — it is never persisted).
        const overrides: Record<number, TerraSlot> = { ...userOverrides };

        // Determine which slot to use for the global location
        let globalSlot: number | undefined;
        if (locationTimezone && (lat !== 0 || lon !== 0)) {
            const validSlots = validSlotsForTz(locationTimezone);
            if (validSlots.length === 1) {
                globalSlot = validSlots[0];
            } else if (validSlots.length > 1) {
                // Tie-break: prefer the slot NOT overridden by the user
                const nonOverridden = validSlots.filter(s => !(s in userOverrides));
                const overridden = validSlots.filter(s => s in userOverrides);
                if (nonOverridden.length >= 1 && overridden.length >= 1) {
                    // Only one is non-overridden → pick it
                    globalSlot = nonOverridden[0];
                } else {
                    // Neither or both overridden → pick by standard-time match
                    const globalStdOff = getStandardOffsetMinutes(locationTimezone);
                    let bestSlot = validSlots[0];
                    let bestDiff = Infinity;
                    for (const s of validSlots) {
                        const slotCity = userOverrides[s] || TERRA_RING_DEFAULTS[s];
                        if (!slotCity) continue;
                        const slotStdOff = getStandardOffsetMinutes(slotCity.olsonId);
                        const diff = Math.abs(slotStdOff - globalStdOff);
                        if (diff < bestDiff) {
                            bestDiff = diff;
                            bestSlot = s;
                        }
                    }
                    globalSlot = bestSlot;
                }
            } else {
                // Shouldn't happen for real timezones — fall back to offset match
                console.warn(`[Terra] No valid slot for timezone ${locationTimezone}`);
            }

            // Inject the global location into the chosen slot
            if (globalSlot !== undefined) {
                overrides[globalSlot] = {
                    cityName: resolveObserverName(ctx),
                    olsonId: locationTimezone,
                    lat, lon,
                };
            }
        }

        return {
            overrides: Object.keys(overrides).length > 0 ? overrides : {},
            userOverrides,
            globalLocationSlot: globalSlot,
        };
    }

    if (watch.worldTimeSubdials) {
        const nSubdials = watch.maxSeparateLoc || 4;
        const overrides: Record<number, TerraSlot> = {};
        // Slot 1 = observer location. The no-DB fallback to the timezone's
        // representative city (matching the Terra global slot) means lazy
        // loading shows e.g. "Los Angeles" rather than a bare placeholder before
        // any reverse-geocode; 'Local' is the documented last resort (only
        // reachable with no timezone at all).
        overrides[1] = {
            cityName: resolveObserverName(ctx),
            olsonId: locationTimezone || '',
            lat, lon,
        };
        // Slots 2–N: user overrides or defaults
        for (let slot = 2; slot <= nSubdials; slot++) {
            const name = slotParams[`d${slot}`] ?? null;
            const tz = slotParams[`d${slot}tz`] ?? null;
            const latStr = slotParams[`d${slot}lat`] ?? null;
            const lonStr = slotParams[`d${slot}lon`] ?? null;
            if (name && tz) {
                overrides[slot] = {
                    cityName: name,
                    olsonId: tz,
                    lat: latStr ? parseFloat(latStr) : 0,
                    lon: lonStr ? parseFloat(lonStr) : 0,
                };
            } else {
                const def = GAIA_SUBDIAL_DEFAULTS[slot];
                if (def) overrides[slot] = { ...def };
            }
        }
        return { overrides };
    }

    return undefined;
}
