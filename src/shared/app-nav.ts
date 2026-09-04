/**
 * Cross-app navigation — hrefs, link wiring, and the i/o/c/a hotkeys behind
 * the header app-nav icons and "Other Apps" links on every page.
 *
 * State rule (planning/2026-07-01-observatory-first-class-app.md §2.0): in
 * persistent (localStorage) mode all three apps read the same `ec:shared`
 * namespace, so cross-app links navigate with a **clean URL** — carrying
 * shareable params would spuriously trigger the incoming-settings dialog on
 * the target app. Only the URL-only `fps` diagnostic is carried (the `f`
 * toggle deliberately propagates it across pages). In the non-persistent
 * fallbacks (file:// URL mode, session-only, in-memory) the full query string
 * is copied, matching `updateNavigationLinks` — there the URL is the only
 * state carrier.
 *
 * Chronometer is a family of pages (faces, all, selected, index, pick), so
 * "go to Chronometer" from another app returns to the page last viewed in
 * this tab: each Chronometer-family entry calls `markChronometerPage()`,
 * which records the page filename in sessionStorage (tab-scoped by intent —
 * this must not persist), and `appNavHref` substitutes it for `index.html`
 * on non-Chronometer pages.
 */

import { isPersistentMode } from './app-state.js';
import { registerHotkey } from './hotkeys.js';

const LAST_CHRONO_KEY = 'ec:lastChronoPage';

/** True once markChronometerPage() has run, i.e. on Chronometer-family
 * pages. Gates the last-page substitution in appNavHref: on Chronometer
 * pages the `c` hotkey and any popup Chronometer entry keep their plain
 * index.html target. */
let onChronometerPage = false;

/**
 * Record this page as the tab's current Chronometer page. Called by the
 * Chronometer-family entries only (engine, index, pick). Embedded frames
 * (Terra embed, help iframe) share the tab's sessionStorage, so they must
 * not clobber the record.
 */
export function markChronometerPage(): void {
    onChronometerPage = true;
    if (new URLSearchParams(window.location.search).has('embed')) return;
    const page = window.location.pathname.split('/').pop();
    if (!page) return;
    try { sessionStorage.setItem(LAST_CHRONO_KEY, page); } catch { /* session-only nicety */ }
}

/** The recorded Chronometer page filename, or null if absent/implausible. */
function lastChronometerPage(): string | null {
    try {
        const page = sessionStorage.getItem(LAST_CHRONO_KEY);
        return page !== null && /^[a-z0-9-]+\.html$/.test(page) ? page : null;
    } catch {
        return null;
    }
}

/** Href for a cross-app link to `page`, per the state rule above. */
export function appNavHref(page: string): string {
    if (page === 'index.html' && !onChronometerPage) {
        page = lastChronometerPage() ?? page;
    }
    if (!isPersistentMode()) return page + window.location.search;
    const fps = new URLSearchParams(window.location.search).get('fps');
    return fps !== null ? `${page}?fps=${encodeURIComponent(fps)}` : page;
}

/**
 * Wire every `a.app-nav-link` on the page: href = appNavHref(data-page),
 * recomputed — after flushing pending state via `flushState` (e.g. the time
 * controller's t/off/dir) — on pointerdown and focus, so the link reflects
 * the exact current state even mid-scrub. Same-tab by design; middle/cmd
 * click still opens a new tab.
 */
export function initAppNavLinks(flushState?: () => void): void {
    document.querySelectorAll<HTMLAnchorElement>('a.app-nav-link').forEach((a) => {
        const page = a.dataset.page || a.getAttribute('href') || 'index.html';
        const setHref = () => { a.href = appNavHref(page); };
        const flushAndSet = () => { flushState?.(); setHref(); };
        a.addEventListener('pointerdown', flushAndSet);  // before click / middle-click
        a.addEventListener('focus', flushAndSet);        // before keyboard activation
        setHref();
    });
}

/**
 * Register the cross-app navigation hotkeys: `i` Inspector, `o` Observatory,
 * `c` Chronometer index, `a` Chronometer all-faces. No-op when already on the
 * target page; otherwise flush and navigate same-tab with appNavHref.
 */
export function registerAppNavHotkeys(flushState?: () => void): void {
    const go = (page: string) => {
        const current = window.location.pathname.split('/').pop() || 'index.html';
        if (current === page) return;
        flushState?.();
        window.location.href = appNavHref(page);
    };
    registerHotkey('i', () => go('inspector.html'));
    registerHotkey('o', () => go('observatory.html'));
    registerHotkey('c', () => go('index.html'));
    registerHotkey('a', () => go('all.html'));
}

export const __test__ = {
    LAST_CHRONO_KEY,
    resetOnChronometerPage(): void { onChronometerPage = false; },
};
