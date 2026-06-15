Here's how I'd break it down into phases, where each phase produces something you can see and validate before moving on:

---

## Phase 1: Expression Evaluator
**Goal**: Parse and evaluate the C-like expressions from the XML.

This is the most self-contained piece and a prerequisite for everything else. It's also something you can test thoroughly in isolation.

- Tokenizer for the expression language (numbers, operators, identifiers, function calls, ternaries, commas)
- Recursive-descent parser that builds a simple AST
- Evaluator that walks the AST given a variable/function environment
- Support `init expr` blocks that define variables (e.g., `cr=136, cr2=114, ...`)
- Unit tests comparing against known expression results

The expressions are things like `hour24Number() >= 12 ? 0 : pi` and `r*cos(th*pi/180)` — arithmetic, comparisons, ternaries, function calls, and variable assignment chains.

---

## Phase 2: XML Parser + Watch Model
**Goal**: Parse a watch XML into an in-memory model of parts.

- Parse the XML using the browser's `DOMParser`
- Build a typed model: `Watch` → `Part[]`, where parts are `Hand`, `QHand`, `QDial`, `QWheel`, `QWedge`, `Button`, `Static`, etc.
- Each part has its evaluated `init` variables, plus unevaluated expressions for dynamic attributes (angle, opacity, motion, etc.)
- Pick one watch (I'd suggest **Geneva** since it's moderately complex and you've already examined it) as the target

---

## Phase 3: Canvas Drawing Primitives
**Goal**: Implement the QView drawing methods as Canvas 2D operations.

Tackle these one part type at a time, in rough order of complexity:

1. **QDial** — circles, arcs, marks, text around a dial. This is the most common element.
2. **QHand / hand** — a line/shape drawn at a computed angle (the watch "hands"). Includes `type='rect'` with arrow tips, tails, and center circles (`oRadius`, `oLength`, etc.)
3. **QWheel** — a rotating wheel with text segments
4. **QWedge** — a filled arc/wedge shape
5. **Static parts** — containers that group non-animated children
6. **Buttons** — image-based parts with hit testing
7. **Image parts** — drawing external PNGs (the `src='../partsBin/...'` references)
8. **Terminator leaves** — the moon phase display (most complex single primitive)

For each, you'd write the Canvas 2D drawing code and visually verify it against the original app.

---

## Phase 4: Animation Loop + Time Binding
**Goal**: Make the watch tick.

- `requestAnimationFrame` loop
- For each frame, evaluate dynamic expressions (angle, opacity, motion) with the current time
- Wire up your existing astronomy functions (`hour24Number()`, `moonRelativeAngle()`, etc.) as callable functions in the expression environment
- Implement the `update` interval system — parts specify how often they need to be recalculated (e.g., `update='60'` means once per minute)

---

## Phase 5: Static Layer Caching
**Goal**: Performance optimization.

- Identify parts that are truly static (no `update`, no dynamic expressions)
- Render them once to an off-screen canvas
- Composite the static layer + animated parts each frame
- Group animated parts by update frequency — parts that change every hour don't need to be re-evaluated at 60fps

---

## Phase 6: Interaction
**Goal**: Make buttons and manual-set mode work.

- Hit testing on button parts
- Implement actions (`stemIn()`, `stemOut()`, `advanceDay()`, `reset()`, etc.)
- Crown/drag interactions for manual time setting
- Front/back/night mode switching

---

## Phase 7: Multi-Watch Support
**Goal**: Load additional watch faces.

- Ensure the pipeline generalizes beyond Geneva
- Handle watch-specific assets (partsBin images, custom fonts)
- Watch selection UI / swiping

---

## Suggested starting point

I'd start with **Phase 1** (expression evaluator) since it's pure logic, highly testable, and doesn't depend on the browser at all — it fits naturally alongside the astronomy code you've already been porting. You could validate it against the `init expr` blocks from any watch XML.

Then Phase 2 + 3 together, targeting a **single static frame** of Geneva with no animation — just "draw the watch face at time T." Once that looks right, Phase 4 makes it tick.

Want me to start on the expression evaluator?