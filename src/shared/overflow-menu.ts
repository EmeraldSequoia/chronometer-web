/**
 * ⋮ overflow menu — the collapsed form of the corner chrome.
 *
 * Every app page keeps its corner buttons (ℹ, share, fullscreen, the app
 * links, the face-page navigation) as long as they fit without costing
 * content; when they would, the page collapses the corner to [⋮] [fullscreen]
 * and this menu holds everything that was folded away. The collapse decision
 * belongs to each page's layout code (docs/chrome.md); this module only
 * builds and runs the menu.
 *
 * The rows are derived from the controls the page has — nothing is
 * duplicated. Action rows `click()` the page's own (hidden) button, so the
 * share dialog, location dialog, time controller and help popover keep a
 * single implementation each. Navigation rows are real anchors whose href is
 * copied from the page's own link at open time and again on pointer-down,
 * after poking that link's pre-navigation handler (app-nav.ts flushes the
 * time state there), so a menu hop carries exactly what the icon hop would.
 *
 * Each row carries the icon its corner button shows — cloned from that
 * button (svg, app thumbnail, or the ℹ glyph) with the button's computed
 * colour, so `currentColor` resolves as it does in the corner. Rows whose
 * corner control is a text button (Set location, the time controller) keep an
 * empty icon column so the labels stay aligned (Steve, 2026-09-22).
 *
 * Markup: partials/overflow-menu.html (#more-btn, #more-menu); appearance:
 * partials/overflow-menu.css. The Settings row heads the menu wherever the
 * page has the ⚙ button (docs/preferences.md).
 */

export interface OverflowMenuOptions {
    /** The running app — decides which "this app's pages" rows can exist. */
    app: 'chronometer' | 'observatory' | 'inspector' | 'eclipses';
}

/** Exported for tests: the row order and what each row is derived from. */
export interface RowSpec {
    label: string | (() => string);
    /** 'click': activate the element with this id. 'nav': copy this anchor's href. */
    kind: 'click' | 'nav';
    id: string;
    /** Start a new group (separator above). */
    group?: boolean;
}

export const ROW_SPECS: readonly RowSpec[] = [
    // Settings first: on a phone the corner is always collapsed, so this row
    // is the only way to the ⚙ dialog there (parent plan decision 1).
    { label: 'Settings…', kind: 'click', id: 'settings-btn', group: true },
    // This app's pages (face pages only; each exists only where the page's
    // body class shows the corresponding corner link).
    { label: 'Home', kind: 'nav', id: 'back-link', group: true },
    { label: 'All faces', kind: 'nav', id: 'all-faces-link' },
    { label: 'Selected faces', kind: 'nav', id: 'selected-faces-link' },
    { label: 'Edit selection', kind: 'nav', id: 'edit-picks-link' },
    // The other apps.
    { label: 'Chronometer', kind: 'nav', id: 'chronometer-link', group: true },
    { label: 'Observatory', kind: 'nav', id: 'observatory-link' },
    { label: 'Inspector', kind: 'nav', id: 'inspector-link' },
    { label: 'Eclipses', kind: 'nav', id: 'eclipses-link' },
    // Actions, at the bottom just above help (Steve, 2026-09-22).
    { label: 'Share this view', kind: 'click', id: 'share-btn', group: true },
    { label: 'Set location', kind: 'click', id: 'set-location-btn' },
    { label: timeControllerLabel, kind: 'click', id: 'time-bar-label' },
    { label: 'About & help', kind: 'click', id: 'info-btn', group: true },
];

/** "Show time controller" / "Hide time controller", from the time bar's own label. */
function timeControllerLabel(): string {
    const text = document.getElementById('time-bar-label')?.textContent ?? 'Time controller';
    return text.replace(/^[^A-Za-z]+/, '').trim() || 'Time controller';
}

/** A control exists for the menu when the page has it and does not hide it (display). */
function present(id: string): HTMLElement | null {
    const el = document.getElementById(id);
    if (!el) return null;
    // Collapsed chrome is hidden with `visibility`, which keeps this true;
    // per-page hiding (e.g. all.html's own link) uses `display: none`.
    if (getComputedStyle(el).display === 'none') return null;
    return el;
}

/**
 * The icon column for a row: a clone of the source button's svg or img, or
 * the ℹ glyph for the help button; empty for text-only sources.
 */
function iconFor(src: HTMLElement): HTMLSpanElement {
    const box = document.createElement('span');
    box.className = 'more-icon';
    box.setAttribute('aria-hidden', 'true');
    const graphic = src.querySelector('svg, img');
    if (graphic) {
        box.appendChild(graphic.cloneNode(true));
    } else if (src.id === 'info-btn') {
        const glyph = document.createElement('span');
        glyph.className = 'more-icon-glyph';
        glyph.textContent = src.textContent?.trim() || 'ℹ';
        box.appendChild(glyph);
    }
    if (box.firstChild) box.style.color = getComputedStyle(src).color;
    return box;
}

function fillRow(row: HTMLElement, src: HTMLElement, label: string): void {
    const text = document.createElement('span');
    text.className = 'more-label';
    text.textContent = label;
    row.append(iconFor(src), text);
}

let closeActive: (() => void) | null = null;
let openActive: (() => boolean) | null = null;

/** Close the menu if it is open (pages call this when the corner un-collapses). */
export function closeOverflowMenu(): void {
    closeActive?.();
}

/** True while the menu is open (the time controller's Escape yields to it). */
export function isOverflowMenuOpen(): boolean {
    return openActive?.() ?? false;
}

export function initOverflowMenu(_opts: OverflowMenuOptions): void {
    const btn = document.getElementById('more-btn');
    const menu = document.getElementById('more-menu');
    if (!btn || !menu) return;

    let open = false;

    function build(): void {
        menu!.replaceChildren();
        let pendingGroup = false;
        let any = false;
        for (const spec of ROW_SPECS) {
            const src = present(spec.id);
            if (spec.group) pendingGroup = true;
            if (!src) continue;
            if (pendingGroup && any) {
                const sep = document.createElement('div');
                sep.className = 'more-sep';
                menu!.appendChild(sep);
            }
            pendingGroup = false;
            any = true;
            const label = typeof spec.label === 'function' ? spec.label() : spec.label;
            if (spec.kind === 'nav') {
                const a = document.createElement('a');
                a.className = 'more-row';
                a.setAttribute('role', 'menuitem');
                fillRow(a, src, label);
                const link = src as HTMLAnchorElement;
                a.href = link.href;
                // Let the page's link refresh its href (app-nav flushes the
                // time state on pointerdown) and mirror the result.
                const refresh = () => { link.dispatchEvent(new Event('pointerdown')); a.href = link.href; };
                a.addEventListener('pointerdown', refresh);
                a.addEventListener('focus', refresh);
                a.addEventListener('click', () => setOpen(false));
                menu!.appendChild(a);
            } else {
                const b = document.createElement('button');
                b.className = 'more-row';
                b.type = 'button';
                b.setAttribute('role', 'menuitem');
                fillRow(b, src, label);
                b.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    setOpen(false);
                    src.click();
                });
                menu!.appendChild(b);
            }
        }
    }

    function position(): void {
        const r = btn!.getBoundingClientRect();
        const top = Math.round(r.bottom + 6);
        menu!.style.top = `${top}px`;
        menu!.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
        // Never taller than the visible area below the button — the menu
        // scrolls inside itself instead (a single-face page's menu is ~450 px,
        // taller than any phone in landscape). 100dvh tracks Safari's toolbar
        // as it comes and goes; 100vh is the fallback where dvh is unknown
        // (an unsupported value leaves the previous one in place). The bottom
        // safe-area inset keeps the last row clear of the home indicator.
        const below = `${top + 8}px - env(safe-area-inset-bottom, 0px)`;
        menu!.style.maxHeight = `calc(100vh - ${below})`;
        menu!.style.maxHeight = `calc(100dvh - ${below})`;
    }

    function setOpen(v: boolean): void {
        if (v === open) return;
        open = v;
        if (v) {
            build();
            position();
        }
        menu!.hidden = !v;
        btn!.setAttribute('aria-expanded', String(v));
    }
    closeActive = () => setOpen(false);
    openActive = () => open;

    btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        setOpen(!open);
    });
    document.addEventListener('pointerdown', (ev) => {
        if (!open) return;
        const t = ev.target as Node | null;
        if (t && (menu.contains(t) || btn.contains(t))) return;
        setOpen(false);
    });
    window.addEventListener('keydown', (ev) => {
        if (open && ev.key === 'Escape') setOpen(false);
    });
    // Viewport changes (rotation, Safari's toolbar showing or hiding) move
    // the button and change the room below it: follow. The pages themselves
    // close the menu when the corner un-collapses (closeOverflowMenu).
    window.addEventListener('resize', () => { if (open) position(); });
}
