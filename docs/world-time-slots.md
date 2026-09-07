# World-Time Slots

Watch faces that display time in multiple locations use a **slot** system to manage per-city data (city name, Olson timezone ID, latitude, longitude). Slots are numbered starting from **1** and managed entirely by the engine at runtime.

## Overview

Each face declares which world-time features it uses via boolean attributes on the `<watch>` root element:

| Attribute | Description | Example face |
|-----------|-------------|-------------|
| `worldTimeRing` | 24-city ring around the dial | Terra |
| `worldTimeSubdials` | Separate subdials for 3–4 cities | Gaia |

A face could declare multiple features; the engine allocates slots independently for each.

## Slot Numbering (1-Based)

### `worldTimeRing` (Terra)

| Slots | Count | Purpose |
|-------|-------|---------|
| 1–24 | 24 | One slot per UTC hour offset (−11 to +12) |

Key constants:
- `FIRST_ENV_SLOT = 1`
- `UTC_SECTOR_NUMBER = 11` (sector index within the ring)
- Slot-to-offset: `offsetHour = slot - FIRST_ENV_SLOT - UTC_SECTOR_NUMBER`
- London (UTC±0) = **slot 12**

The XML `firstRingSlot` variable is set to `1`, `UTRingSlot` to `12`. All 24 QWedge date-color hands and QHand dot references use `firstRingSlot + N` where N = 0–23.

### `worldTimeSubdials` (Gaia)

| Slot | Purpose |
|------|---------|
| 1 | Observer's location (auto-populated) |
| 2 | Upper subdial city |
| 3 | Right subdial city |
| 4 | Lower subdial city |

Slot 1 is automatically populated from the device/browser location. Its city name follows the same priority as Terra's global slot (see below): `locationSource`, then `findClosestCity()` once the city database is parsed, then the timezone's representative city via `olsonIdToCityName()`, then "Local". When the database parses *after* the slot was built (the common case for an in-session location change — the DB is loaded lazily), the engine's on-demand reverse-geocode relabels the live environment in place (`relabelTerraSlot`), so the subdial never sits on the placeholder for the rest of the session. Slots 2–4 default to `GAIA_SUBDIAL_DEFAULTS` (New York, London, Sydney). Count is driven by `watch.maxSeparateLoc` (from XML, default 4).

## Slot Override Encoding

Slot overrides persist through `app-state.ts` (the dedicated `ec:slots` blob in
LocalStorage; the URL only in shared links / the `file://` fallback) as a flat
key→value map. Each feature uses a distinct key prefix to avoid collisions:

| Feature | Prefix | Example keys |
|---------|--------|---------|
| `worldTimeRing` | `r` | `r5=Denver`, `r5tz=America/Denver`, `r5lat=39.74`, `r5lon=-104.98` |
| `worldTimeSubdials` | `d` | `d2=Tokyo`, `d2tz=Asia/Tokyo`, `d2lat=35.68`, `d2lon=139.69` |

Each slot stores four keys:
- `{prefix}{slot}` — city display name
- `{prefix}{slot}tz` — Olson timezone ID
- `{prefix}{slot}lat` — latitude
- `{prefix}{slot}lon` — longitude

`engine-entry.ts` reads them via `getSlotOverrides()` and writes via
`setSlotOverrides()` — for the ring through the pure helpers
`parseTerraUserOverrides()` / `serializeTerraOverrides()` in
`terra-slots.ts`; `buildShareUrl()` includes them in Share links, and an
incoming link with slot keys triggers the shared-settings prompt.

## Slot Override Flow

```
getSlotOverrides() ──→ buildSlotOverrides(watch)
                  │
                  │  1. Read user slot overrides (r1..r24 or d2..dN)
                  │     (Terra: parseTerraUserOverrides in terra-slots.ts)
                  │  2. For worldTimeRing: inject global location into
                  │     best matching slot (display only — a user override
                  │     of that slot is retained in userOverrides)
                  │
                  ↓
         SlotOverrideResult {
             overrides: Record<number, TerraSlot>       ← DISPLAY table (user + injected observer)
             userOverrides?: Record<number, TerraSlot>  ← Terra: the user's overrides alone
             globalLocationSlot?: number
         }
                  ↓
         createWatchEnvironment(watch, lat, lon, getNow, tz, overrides, globalLocationSlot)
                  ↓
         env._terraSlots    ← COPY of merged defaults + overrides
         detectedTopSlot    ← globalLocationSlot (or auto-detected fallback)
                  ↓
         Renderer reads _terraSlots for labels, channels, dots
         Engine reads _terraSlots for post-render overlays (Gaia 24hr labels)
```

`buildSlotOverrides` runs at face construction and again on every location
change (`rebuildAllForLocationFrozen`) — one derivation for both faces.
Because the environment holds a *copy* of the slot table (and Terra caches
the ring names in a knockout image), a label that becomes known later — the
nearest city, once the lazily parsed city database lands — is pushed into the
live environment with `relabelTerraSlot(env, slot, name)` (watch-env.ts),
which also drops the knockout cache; the face is then marked dirty and redrawn.

## Global Location Override (Terra)

The user's current location **always overrides one ring slot** on screen (the persisted override map is untouched) and is placed at the top (12 o'clock). Slot selection via `validSlotsForTz()`:

1. If exactly **one** valid slot → use it
2. If **multiple** valid slots (common at DST boundaries):
   - If only one has a user URL override → pick the **other** (non-overridden) slot
   - Otherwise → pick the slot whose **standard-time UTC offset** most closely matches the global location's standard-time offset

The chosen slot number is stored as `globalLocationSlot` on the `FaceInstance` (alongside `terraSlotOverrides`, the display table, and `terraUserOverrides`, the user's own overrides) and passed to `createWatchEnvironment`.

The derivation lives in `src/watch/observer-slots.ts` (`deriveObserverSlots`,
pure, unit-tested); the engine's `buildSlotOverrides` wraps it with the live
location and `getSlotOverrides()`. Because the observer slot's sector and
`olsonId` follow `locationTimezone`, they are re-derived on **any** change of
the location's zone — a location change, a database timezone correction
(`applyResolvedTimezone`), a slot edit — and never by the DST rebuild path,
which preserves slots by design.

City name resolution priority (applied by `buildSlotOverrides` on startup
and on every location change; step 2 also applies *in-session* — see the
relabel note above):
1. `locationSource` (from city-picker or URL `city=` param)
2. `findClosestCity()` (once city database loads)
3. `olsonIdToCityName()` (e.g., "Los Angeles" from "America/Los_Angeles")
4. Fallback: "Local"

**Embed mode**: When `embed=1`, lat/lon is (0, 0) and the timezone comes from
the browser or `tz` URL parameter. The global location slot is still assigned
based on timezone matching. See [Embedding](embedding.md).

## City Customization Dialog

Both Terra and Gaia reuse `terra-city-dialog.html`, wired differently per feature:

**Terra**: Search → validate compatible UTC offset slots → assign. The global-location slot is annotated with ★ and "(your location)". Overriding it shows a warning.

Terra persists only the **user's** overrides (`face.terraUserOverrides`,
serialized by `serializeTerraOverrides` in terra-slots.ts). The auto-injected
observer slot is recomputed from the current location on every rebuild and is
never written to `ec:slots` — a stored copy would become a ghost "user
override" of that sector once the observer moved to another zone, and would
replace a genuine user override of the same slot. A user override *of* the
observer slot is a user override like any other: it is persisted, the observer
still wins that slot on screen while the timezones match, and the override
shows again once the observer moves elsewhere. (Gaia's writer skips its
observer slot for the same reason.)

**Gaia**: Search → pick subdial (Upper / Right / Lower) → assign. No timezone validation needed.

Both persist overrides via `setSlotOverrides()` (storage by default) and rebuild the face environment — Terra serializes only `terraUserOverrides`, Gaia skips its observer slot 1, so the injected observer never reaches `ec:slots`.

## Key Source Files

| File | Purpose |
|------|---------|
| `src/watch/observer-slots.ts` | `deriveObserverSlots()` / `resolveObserverName()` — the slot-table derivation |
| `src/watch/watch-env.ts` | `TERRA_RING_DEFAULTS`, `GAIA_SUBDIAL_DEFAULTS`, environment creation with slot data, `relabelTerraSlot()` |
| `src/watch/terra-slots.ts` | Slot↔offset conversion, timezone validation, `getStandardOffsetMinutes()`, `parseTerraUserOverrides()` / `serializeTerraOverrides()` |
| `src/engine-entry.ts` | `buildSlotOverrides()`, `backfillObserverSlots()`, city dialog wiring, slot persistence via app-state |
| `src/shared/app-state.ts` | `getSlotOverrides()` / `setSlotOverrides()` (the `ec:slots` blob) |
| `src/watch/renderer.ts` | Reads `_terraSlots` for city labels, channel lines, dots |
| `src/watch/types.ts` | `Watch` interface with feature flag fields |

## Related Docs

- [Location & Cities](location-and-cities.md) — How location is obtained and city search works
- [XML Parsing](xml-parsing.md) — Feature flag attributes on `<watch>` element
