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

Slot 1 is automatically populated from the device/browser location. Its city name is resolved from `locationSource` or `findClosestCity()`. Slots 2–4 default to `GAIA_SUBDIAL_DEFAULTS` (New York, London, Sydney). Count is driven by `watch.maxSeparateLoc` (from XML, default 4).

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
`setSlotOverrides()`; `buildShareUrl()` includes them in Share links, and an
incoming link with slot keys triggers the shared-settings prompt.

## Slot Override Flow

```
getSlotOverrides() ──→ buildSlotOverrides(watch)
                  │
                  │  1. Read user slot overrides (r1..r24 or d2..dN)
                  │  2. For worldTimeRing: inject global location into
                  │     best matching slot (overrides user choice there)
                  │
                  ↓
         SlotOverrideResult {
             overrides: Record<number, TerraSlot>
             globalLocationSlot?: number
         }
                  ↓
         createWatchEnvironment(watch, lat, lon, getNow, tz, overrides, globalLocationSlot)
                  ↓
         env._terraSlots    ← merged defaults + overrides
         detectedTopSlot    ← globalLocationSlot (or auto-detected fallback)
                  ↓
         Renderer reads _terraSlots for labels, channels, dots
         Engine reads _terraSlots for post-render overlays (Gaia 24hr labels)
```

## Global Location Override (Terra)

The user's current location **always overrides one ring slot** and is placed at the top (12 o'clock). Slot selection via `validSlotsForTz()`:

1. If exactly **one** valid slot → use it
2. If **multiple** valid slots (common at DST boundaries):
   - If only one has a user URL override → pick the **other** (non-overridden) slot
   - Otherwise → pick the slot whose **standard-time UTC offset** most closely matches the global location's standard-time offset

The chosen slot number is stored as `globalLocationSlot` on the `FaceInstance` and passed to `createWatchEnvironment`.

City name resolution priority:
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

**Gaia**: Search → pick subdial (Upper / Right / Lower) → assign. No timezone validation needed.

Both persist overrides via `setSlotOverrides()` (storage by default) and rebuild the face environment.

## Key Source Files

| File | Purpose |
|------|---------|
| `src/watch/watch-env.ts` | `TERRA_RING_DEFAULTS`, `GAIA_SUBDIAL_DEFAULTS`, environment creation with slot data |
| `src/watch/terra-slots.ts` | Slot↔offset conversion, timezone validation, `getStandardOffsetMinutes()` |
| `src/engine-entry.ts` | `buildSlotOverrides()`, city dialog wiring, slot persistence via app-state |
| `src/shared/app-state.ts` | `getSlotOverrides()` / `setSlotOverrides()` (the `ec:slots` blob) |
| `src/watch/renderer.ts` | Reads `_terraSlots` for city labels, channel lines, dots |
| `src/watch/types.ts` | `Watch` interface with feature flag fields |

## Related Docs

- [Location & Cities](location-and-cities.md) — How location is obtained and city search works
- [XML Parsing](xml-parsing.md) — Feature flag attributes on `<watch>` element
