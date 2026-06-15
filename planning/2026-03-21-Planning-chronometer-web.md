I'd like to plan how we're going to do render the watch faces on the web. In particular, I want to decide on a fundamental approach.

One approach would be to just port the non-Henry part of Chronometer. This would have the advantage of being far less code to port, but would have the disadvantage that any changes to the code could not be done without having Henry around (and Henry, being an iOS app, would need to track SDK updates as time progresses). In this approach, we could either use WebGL to draw from the OpenGL texture atlases or use some other mechanism that can draw triangles from an atlas in the way the OpenGL does.

Another approach would be to get rid of the two-part organization (Henry and non-Henry), and just use the XML files to draw the watch faces. The C-expressions that Henry parses could in most cases just be interpreted by TypeScript on the fly (presuming that the right functions have been defined). The only hiccup here is we need to emulate the Cocoa drawing primitives used by the Henry code to draw directly into the canvas. There's some risk that on watch faces with hundreds of parts, the drawing won't be fast enough for good animation (the current app runs at 60 fps). In that case, we could revert to a two-part architecture and port Henry as a preprocessing step when loading the watch page.

What advice do you have? Don't write any code yet




Great question — this is a really important architectural decision. Let me first look at your existing codebase and the original Chronometer source to better understand the complexity involved before giving my recommendation.

Listed directory chronometer-web
Listed directory src
Searched for files: *

Now let me look at the original iOS source to understand the Henry/Chronometer architecture better:

Searched for files: *.xml
Searched for files: *henry*
Searched for files: *.md

Let me look at the original Chronometer source to understand the rendering complexity:

Searched for files: *Chronometer*
Searched for files: *EmeraldSequoia*

The original Chronometer source isn't checked out here. Let me check if there's a reference to it or look at the GitHub repo for context:

Listed directory .esastro-ref
Listed directory .agents

Let me look at the original Chronometer repo on GitHub to understand the rendering architecture better:

Read URL: https://github.com/EmeraldSequoia/Chronometer

Now let me look at the XML watch definitions and the Henry drawing code to understand the Cocoa drawing primitives involved:

Read URL: https://github.com/EmeraldSequoia/Chronometer/tree/main/Watches/Builtin
Read URL: https://github.com/EmeraldSequoia/Chronometer/blob/main/specs/henry.md

Now let me look at a watch XML to understand the complexity of the drawing primitives:

Read URL: https://raw.githubusercontent.com/EmeraldSequoia/Chronometer/main/Classes/ECQView.m

Let me look at one of the QView drawing implementations and a sample XML to understand the actual drawing complexity:

Read URL: https://raw.githubusercontent.com/EmeraldSequoia/Chronometer/main/Watches/Builtin/Geneva/Geneva.xml

Now let me also look at a simpler watch and the Haleakala one (since you've been working on its astronomy):

Now I have a very good understanding of the architecture. Let me look at a few more specifics — the QView drawing primitives to understand what Cocoa APIs are used:

Now I have a thorough understanding of the architecture. Let me give you my analysis and recommendation.

---

This is a great question, and having dug through the Chronometer source, the XML definitions, and the Henry/QView drawing code, here's my thinking:

## My Recommendation: **Approach 2 — Direct XML-to-Canvas**, with a fallback plan

### Why I favor the unified approach

**1. The Cocoa drawing primitives used are actually quite limited and map well to Canvas 2D.**

Looking at `ECQView.m`, the drawing primitives Henry uses are essentially:
- `CGContextAddArc` → `CanvasRenderingContext2D.arc()`
- `CGContextAddLineToPoint` → `ctx.lineTo()`
- `CGContextMoveToPoint` → `ctx.moveTo()`
- `CGContextFillPath` / `CGContextStrokePath` → `ctx.fill()` / `ctx.stroke()`
- `CGContextDrawImage` → `ctx.drawImage()`
- `CGContextSetAlpha` → `ctx.globalAlpha`
- `CGContextAddRect` → `ctx.rect()`
- `CGContextSaveGState` / `CGContextRestoreGState` → `ctx.save()` / `ctx.restore()`
- `CGContextScaleCTM` / `CGContextTranslateCTM` → `ctx.scale()` / `ctx.translate()`
- `CGContextEOClip` → `ctx.clip()` with `evenodd`
- `CGContextSetLineWidth` → `ctx.lineWidth`
- Text drawing → `ctx.fillText()` / `ctx.strokeText()`

This is a **very manageable** set of primitives to wrap. There's nothing exotic that Canvas 2D can't handle.

**2. The C-expressions are straightforward to interpret in TypeScript.**

Looking at the XML, the expressions are things like:
```
hour24Number() >= 12 ? 0 : pi
moonriseForDayHour24Number() >= 12 ? 0 : pi
DSTNumber() ? pi*7/4 : pi/4
```
These are basic arithmetic with function calls and ternary operators. You already have the astronomy functions being ported. A simple expression evaluator (or even a transpiler that converts these to TypeScript at load time) would handle this easily.

**3. Long-term maintenance is dramatically simpler.** No Henry dependency means:
- No iOS SDK tracking
- No Xcode simulator needed
- Changes to watch faces are just XML edits
- The entire build pipeline disappears

**4. The archive format is an optimization, not a necessity.** The original motivation for the two-step process was memory management on 128MB iPhones and the limitations of early OpenGL. Neither constraint applies to a modern web browser.

### The performance question

Your concern about watches with hundreds of parts is valid. Here are the key performance considerations:

| Factor | Assessment |
|--------|-----------|
| **Number of parts** | Geneva XML has ~100+ parts. Some watches may have more. |
| **Canvas 2D speed** | Modern browsers can draw hundreds of simple shapes per frame at 60fps easily. |
| **Expression evaluation** | Arithmetic + function calls is trivially fast. |
| **Static vs. animated parts** | Most parts (dials, marks, text) are **static** — only hands/indicators move each frame. |

**The key optimization insight**: You don't need to redraw everything every frame. Static elements (backgrounds, dial marks, text) can be drawn once to an off-screen canvas and composited. Only animated parts (hands, rotating elements) need per-frame updates. This is essentially what the atlas approach does, but you can do it lazily at runtime.

### Suggested hybrid strategy

1. **Start with direct rendering from XML** — parse XML, evaluate expressions, draw with Canvas 2D.
2. **Cache static layers** — pre-render static parts to off-screen canvases (essentially generating a "runtime atlas" in the browser). This gives you Henry's performance benefits without Henry.
3. **If performance is still insufficient** (unlikely, but possible for the most complex faces), you could add a build-time pre-rendering step that's just a Node.js script using the same Canvas API (via `node-canvas`), not an iOS app.

### What you'd need to build

1. **XML parser** — straightforward DOM parsing in the browser
2. **Expression evaluator** — a small recursive-descent parser for the C-like expressions (or use a library). These expressions are simpler than what `lex/yacc` handles since they're basically arithmetic + function calls + ternaries
3. **Canvas drawing layer** — a thin wrapper around `CanvasRenderingContext2D` that mirrors the QView drawing methods (`QDial`, `QHand`, `QWedge`, `QWheel`, etc.)
4. **Part system** — the watch part hierarchy (static, hand, button, etc.) with update intervals and animation

### What you'd avoid

- Porting the binary archive reader
- Porting the OpenGL rendering code
- Porting/maintaining Henry as an iOS app
- WebGL complexity (which is overkill for 2D watch rendering)
- Dealing with texture atlas formats and memory management

### Bottom line

The Canvas 2D API is a **remarkably good match** for the Cocoa drawing primitives Henry uses. The expressions are simple enough to interpret at runtime. And the performance concern is addressable through off-screen canvas caching, which is the web equivalent of the atlas concept but generated on-the-fly. I'd save WebGL as a last resort — you almost certainly won't need it.