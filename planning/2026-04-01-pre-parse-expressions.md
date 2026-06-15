# Pre-parsing Expressions for Performance

## The Problem
Currently, Chronometer parses string expressions into an Abstract Syntax Tree (AST) every time an attribute is evaluated. During the 60 frames-per-second redraw loop, functions like `evalAttr(part.angle, env)` repetitively call `parse(expr)`, which wastes CPU cycles and battery life.

## The Solution
Parse all mathematical expressions once when the XML is loaded or the environment is initialized. Store the resulting `ASTNode` (the parsed expression tree) directly in the watch part model. The animation loop will then only need to walk the pre-built AST and evaluate the math, bypassing the parser entirely.

## Detailed Plan

### 1. Update Types (`src/watch/types.ts`)
We will change the types of all numeric expression attributes from `string` to `ASTNode | string`. Since we want to completely replace the raw strings as requested, we can use a mapped type strategy or just change the specific properties.
*   **Keep as `string`**: Non-expression textual attributes like `name`, `type`, `wheelVariant`, `orientation`, `text`, `fontName`, `marks`, `src`, `modes`, `action`.
*   **Change to `ASTNode`**: Mathematical properties like `x`, `y`, `radius`, `angle`, `length`, `width`, `update`, `animSpeed`, `fontSize`, etc. 

*Alternative consideration*: To avoid breaking too many things quickly, we could introduce a `parseAttribute(value: string)` function in `xml-parser.ts` that immediately turns the string into an `ASTNode` and assigns it to the properties.

### 2. Update the Parser (`src/watch/xml-parser.ts`)
Introduce a helper function `attrExpr(element, name)`:
```typescript
function attrExpr(el: Element, name: string): ASTNode | undefined {
    const val = el.getAttribute(name);
    if (!val || val.trim() === '') return undefined;
    try {
        return parse(val.trim());
    } catch (e) {
        console.error(`Failed to parse attribute ${name}="${val}"`, e);
        return undefined; // Or a fallback ASTNode returning 0
    }
}
```
Update all the part creation blocks (e.g., inside `QHandPart` building) to use `attrExpr` for their numeric fields instead of `attr()`.

### 3. Update the Evaluator (`src/expr/evaluator.ts` and `src/watch/watch-env.ts`)
*   Change `evalAttr` in `watch-env.ts` to accept an `ASTNode` instead of a string:
    ```typescript
    export function evalAttr(expr: ASTNode | undefined, env: Environment): number {
        if (!expr) return 0;
        return evaluate(expr, env);
    }
    ```
*   Colors are special. `evalColor` currently checks if the string evaluates to a number or a hex string. We'll need to update color parsing to store color expressions as `ASTNode`s as well, or keep them as strings if they are pure hex codes.

### 4. Update the Init Block (`watch-env.ts`)
The `initExprs` inside the `Watch` model are currently strings.
*   We will parse them in `xml-parser.ts` so `watch.initExprs` becomes `ASTNode[]`.
*   `evaluateInit` will directly walk the AST array.

## Implementation Steps
1.  **Refactor Types:** Update `WatchPart` interfaces in `types.ts` so that numeric attributes are `ASTNode`.
2.  **Refactor XML Parser:** Import `parse` from `evaluator.ts` into `xml-parser.ts`. Use it to compile attributes on the fly.
3.  **Refactor Rendering:** Update `renderer.ts`, `watch-env.ts`, and `animation.ts` to expect `ASTNode`s instead of strings in `evalAttr`.
4.  **Test:** verify that hands still move and the watch face still renders correctly.
