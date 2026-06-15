Let me cross-reference the XML parts with the renderer's dispatch:

Viewed renderer.ts:60-94
Searched for "modes='front'"

Here's a breakdown of the front-mode parts in the Haleakala XML and their render status:

| # | XML Tag | Name | Rendered? | Notes |
|---|---------|------|-----------|-------|
| 1 | `SWheel` | day1s | ✅ Wheel | Date ones digit |
| 2 | `SWheel` | day1s (ref) | ✅ Wheel | Date tens digit |
| 3 | `QWheel` | am/pm | ✅ Wheel | AM/PM indicator |
| 4 | `window` | month win | ✅ Window | |
| 5 | `window` | day win | ✅ Window | |
| 6 | `window` | wkday win | ✅ Window | |
| 7 | `Image` | face | ❌ Skipped | Background face image |
| 8 | `Image` | logo | ❌ Skipped | ES logo |
| 9 | [QDial](cci:1://file:///Users/spucci/chronometer-web/src/watch/renderer.ts:132:0-337:1) | az dial | ✅ QDial | N/S/W/E + center mark |
| 10 | [QDial](cci:1://file:///Users/spucci/chronometer-web/src/watch/renderer.ts:132:0-337:1) | az dial2 | ✅ QDial | 30,60…330 demi text + center mark |
| 11 | [QDial](cci:1://file:///Users/spucci/chronometer-web/src/watch/renderer.ts:132:0-337:1) | main dial | ✅ QDial | 12,1,2…11 upright text |
| 12 | [QDial](cci:1://file:///Users/spucci/chronometer-web/src/watch/renderer.ts:132:0-337:1) | main dialx | ✅ QDial | Outer circle at mainR-3 |
| 13 | [QDial](cci:1://file:///Users/spucci/chronometer-web/src/watch/renderer.ts:132:0-337:1) | main dial2 | ✅ QDial | 60 minute ticks |
| 14 | [QDial](cci:1://file:///Users/spucci/chronometer-web/src/watch/renderer.ts:132:0-337:1) | main dial3 | ✅ QDial | 12 hour ticks |
| 15 | [QDial](cci:1://file:///Users/spucci/chronometer-web/src/watch/renderer.ts:132:0-337:1) | main dial4 | ✅ QDial | 180 blue azimuth ticks |
| 16 | [QDial](cci:1://file:///Users/spucci/chronometer-web/src/watch/renderer.ts:132:0-337:1) | main dial4a | ✅ QDial | 36 black azimuth ticks |
| 17 | [QDial](cci:1://file:///Users/spucci/chronometer-web/src/watch/renderer.ts:132:0-337:1) | alt dial | ✅ QDial | Altitude dots (partial arc) |
| 18 | [QDial](cci:1://file:///Users/spucci/chronometer-web/src/watch/renderer.ts:132:0-337:1) | alt dial3 | ✅ QDial | Altitude dots (partial arc) |
| 19 | [QDial](cci:1://file:///Users/spucci/chronometer-web/src/watch/renderer.ts:132:0-337:1) | alt dial2 | ✅ QDial | Altitude dots (partial arc) |
| 20 | [QDial](cci:1://file:///Users/spucci/chronometer-web/src/watch/renderer.ts:132:0-337:1) | alt dialtc/tn/ta | ✅ QDial | Twilight indicator dots |
| 21 | `Qtext` | alt90 | ✅ QText | "90" label |
| 22 | [QDial](cci:1://file:///Users/spucci/chronometer-web/src/watch/renderer.ts:132:0-337:1) | dial-ua | ✅ QDial | Sunrise sub-dial bg |
| 23 | [QDial](cci:1://file:///Users/spucci/chronometer-web/src/watch/renderer.ts:132:0-337:1) | dial-ua txt | ✅ QDial | Sunrise 12,3,6,9 text |
| 24 | [QDial](cci:1://file:///Users/spucci/chronometer-web/src/watch/renderer.ts:132:0-337:1) | ua ticks/ticks2 | ✅ QDial | Sunrise tick marks |
| 25 | [QDial](cci:1://file:///Users/spucci/chronometer-web/src/watch/renderer.ts:132:0-337:1) | dial-u2 | ✅ QDial | Sunset sub-dial bg |
| 26 | [QDial](cci:1://file:///Users/spucci/chronometer-web/src/watch/renderer.ts:132:0-337:1) | dial-u2 txt | ✅ QDial | Sunset 12,3,6,9 text |
| 27 | [QDial](cci:1://file:///Users/spucci/chronometer-web/src/watch/renderer.ts:132:0-337:1) | ub ticks/ticks2 | ✅ QDial | Sunset tick marks |
| 28 | `Qtext` | next rise | ✅ QText | "Sunrise" label |
| 29 | `Qtext` | next set | ✅ QText | "Sunset" label |
| 30 | [QDial](cci:1://file:///Users/spucci/chronometer-web/src/watch/renderer.ts:132:0-337:1) | outermost | ✅ QDial | Dark gray outer ring |
| 31 | `window` | fr am/pm | ✅ Window | AM/PM porthole |
| 32 | `Image` | band | ❌ Skipped | Watch band image |
| 33 | `Image` | case | ❌ Skipped | Watch case image |
| 34 | [QDial](cci:1://file:///Users/spucci/chronometer-web/src/watch/renderer.ts:132:0-337:1) | caseExt | ✅ QDial | Case extension ticks |
| 35 | [QRect](cci:1://file:///Users/spucci/chronometer-web/src/watch/renderer.ts:560:0-601:1) | day back, month back, wkday back | ✅ QRect | Date window backgrounds |
| 36 | `SWheel` | Qmonths | ✅ Wheel | Month wheel |
| 37 | `SWheel` | Qweekdays | ✅ Wheel | Weekday wheel |
| 38 | [QHand](cci:1://file:///Users/spucci/chronometer-web/src/watch/renderer.ts:343:0-395:1) | nxt rs hr/mn | ✅ QHand | Sunrise hands |
| 39 | [QHand](cci:1://file:///Users/spucci/chronometer-web/src/watch/renderer.ts:343:0-395:1) | set hr/min | ✅ QHand | Sunset hands |
| 40 | [QHand](cci:1://file:///Users/spucci/chronometer-web/src/watch/renderer.ts:343:0-395:1) | saz hand | ✅ QHand | Sun azimuth hand |
| 41 | [QHand](cci:1://file:///Users/spucci/chronometer-web/src/watch/renderer.ts:343:0-395:1) | salt hand | ✅ QHand | Sun altitude hand |
| 42 | [QHand](cci:1://file:///Users/spucci/chronometer-web/src/watch/renderer.ts:343:0-395:1) | hr, min, sec | ✅ QHand | Main clock hands |
| 43 | `Button` | stem, Reset, F/R, etc. | ❌ Skipped | Buttons (not rendered) |

**Summary:** Everything renders except **Images** (face, logo, band, case) and **Buttons**. The `terminator` part type is also not handled. The face/case images are the biggest visual gap — everything you see is drawn purely from vector primitives.
