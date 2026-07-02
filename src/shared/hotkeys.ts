/**
 * Shared single-key hotkey registry.
 *
 * One `keydown` listener per page dispatches to registered handlers. Keys are
 * matched case-insensitively with no Ctrl/Meta/Alt modifier (Shift is allowed
 * — `?` needs it) and ignored while focus is in a text input, textarea, or
 * contenteditable element, so typing "o" in the city search never navigates.
 *
 * The key table is documented in help.html's "Keyboard Shortcuts" section —
 * keep the two in sync. The cross-app navigation keys (i/o/c/a) are registered
 * by `registerAppNavHotkeys` in app-nav.ts; each entry script registers the
 * page-specific keys (h/t/n/l/…) for the controls that exist on its page.
 */

const handlers = new Map<string, () => void>();
let listenerInstalled = false;

/** Register `handler` for a single-character key (case-insensitive). */
export function registerHotkey(key: string, handler: () => void): void {
    handlers.set(key.toLowerCase(), handler);
    if (listenerInstalled || typeof window === 'undefined') return;
    listenerInstalled = true;
    window.addEventListener('keydown', (ev: KeyboardEvent) => {
        if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
        const target = ev.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
            return;
        }
        const handler = handlers.get(ev.key.toLowerCase());
        if (handler) {
            ev.preventDefault();
            handler();
        }
    });
}
