/**
 * Incoming-settings dialog + transient storage warning.
 *
 * Self-contained UI used by app-state.ts when a URL carries shareable
 * parameters (the "incoming settings" prompt) and when the user edits a
 * setting while in session-only mode (the "re-prompt"). Styled to match the
 * existing location dialog (see partials/location-dialog.css) but injects its
 * own <style> so no build.sh partial is required.
 *
 * Touches the DOM only when its functions are called, so importing this module
 * has no side effects (safe for unit tests).
 */

export type SettingsChoice = 'save' | 'session';

const STYLE_ID = 'ec-settings-dialog-style';

const CSS = `
.ec-modal-backdrop {
    position: fixed; inset: 0; z-index: 1000;
    display: flex; align-items: center; justify-content: center;
    padding: 24px 16px;
    background: rgba(0, 0, 0, 0.5);
}
.ec-modal {
    /* No backdrop-filter here — deliberate: a pixel-moving filter with content
       inside it can drop its quad for one composited frame and flash the live
       screen. This panel is 98% opaque so the blur was invisible anyway.
       See the #info-overlay comment in observatory.html. */
    position: relative;
    background: rgba(26, 26, 46, 0.98);
    border: 1px solid #3a3a5e; border-radius: 14px;
    padding: 26px 30px; min-width: 300px; max-width: 400px; width: 100%;
    box-shadow: 0 8px 48px rgba(0, 0, 0, 0.6);
    text-align: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.ec-modal-title {
    font-size: 16px; color: #e0d8c8; margin: 0 0 10px; font-weight: 400;
}
.ec-modal-text {
    font-size: 13px; color: #aab; line-height: 1.5; margin: 0 0 20px;
}
.ec-modal-buttons { display: flex; flex-direction: column; gap: 8px; }
.ec-modal-btn {
    border-radius: 6px; font-size: 13px; padding: 9px 16px;
    cursor: pointer; transition: background 0.15s, color 0.15s;
    background: #2a2a4e; border: 1px solid #3a3a5e; color: #aac;
}
.ec-modal-btn:hover { background: #3a3a6e; color: #ddf; }
.ec-modal-btn.ec-primary {
    background: #34507a; border-color: #4a6fa5; color: #dde9ff;
}
.ec-modal-btn.ec-primary:hover { background: #3f5f92; color: #fff; }

.ec-toast {
    position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
    z-index: 1001; max-width: 340px;
    background: rgba(26, 26, 46, 0.98); border: 1px solid #3a3a5e;
    border-radius: 10px; padding: 12px 16px;
    box-shadow: 0 6px 32px rgba(0, 0, 0, 0.5);
    color: #ccd; font-size: 12.5px; line-height: 1.45;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    display: flex; align-items: center; gap: 12px;
}
.ec-toast-close {
    background: none; border: none; color: #889; font-size: 18px;
    cursor: pointer; padding: 0 2px; line-height: 1;
}
.ec-toast-close:hover { color: #ccd; }

/* The Settings notice (showSettingsNotice): no auto-dismiss, no ×, a Got it
   button; below the Settings dialog's backdrop so an open dialog covers it.
   The line height makes room for the 26 px button miniatures in the prose.
   Sized to its text: a fixed box at left: 50% otherwise shrinks to fit the
   right half of the viewport, which on a phone made it 220 px wide and a
   dozen lines tall. */
.ec-toast.ec-notice {
    z-index: 999; line-height: 1.6;
    width: max-content; max-width: min(380px, calc(100vw - 32px));
}
/* A miniature of a corner button (miniButton): the real svg in a circle of
   the button's own colours, read from the live button. */
.ec-mini-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 26px; height: 26px; border-radius: 50%; vertical-align: middle; margin: 0 2px;
}
.ec-mini-btn svg { width: 15px; height: 15px; fill: currentColor; }
.ec-toast-btn {
    flex: 0 0 auto; min-height: 44px; padding: 0 16px;
    border-radius: 8px; font-size: 13px; cursor: pointer;
    background: #34507a; border: 1px solid #4a6fa5; color: #dde9ff;
    transition: background 0.15s, color 0.15s;
}
.ec-toast-btn:hover { background: #3f5f92; color: #fff; }

/* Settings dialog (settings-dialog.ts): the modal above, with left-aligned
   44 px rows and switch controls. */
.ec-modal.ec-settings { max-width: 440px; padding: 22px 22px 18px; }
/* The dialog takes focus on open (so Esc and Tab start inside it); the
   container itself needs no ring — the rows and buttons keep theirs. */
.ec-modal.ec-settings:focus { outline: none; }
.ec-settings-rows {
    display: flex; flex-direction: column; margin: 0 0 14px; text-align: left;
}
.ec-settings-row {
    display: flex; align-items: center; gap: 14px;
    min-height: 44px; padding: 6px 4px; margin: 0;
    border-top: 1px solid #2e2e4a; cursor: pointer;
    font: inherit; color: inherit; background: none; width: 100%; box-sizing: border-box;
}
.ec-settings-row:first-child { border-top: none; }
/* Section titles (planning/2026-09-23-settings-sections-and-forget-scope.md
   §2): small caps over an hrule, rendered only above at least one row; the
   row under a title needs no rule of its own. */
.ec-settings-section {
    display: flex; align-items: center; gap: 10px; margin: 14px 0 2px;
    font-size: 11px; letter-spacing: 1.2px; text-transform: uppercase; color: #889;
}
.ec-settings-section:first-child { margin-top: 0; }
.ec-settings-section::after { content: ''; flex: 1 1 auto; height: 1px; background: #3a3a5e; }
.ec-settings-section + .ec-settings-row { border-top: none; }
.ec-settings-row:hover .ec-settings-label { color: #fff; }
.ec-settings-text { flex: 1 1 auto; display: flex; flex-direction: column; gap: 2px; }
.ec-settings-label { font-size: 14px; color: #dcd8cc; }
.ec-settings-hint { font-size: 12px; color: #889; line-height: 1.35; }
.ec-switch {
    appearance: none; -webkit-appearance: none;
    flex: 0 0 auto; width: 44px; height: 26px; margin: 0;
    border-radius: 13px; background: #2a2a4e; border: 1px solid #3a3a5e;
    position: relative; cursor: pointer; transition: background 0.15s, border-color 0.15s;
}
.ec-switch::after {
    content: ''; position: absolute; top: 2px; left: 2px;
    width: 20px; height: 20px; border-radius: 50%; background: #99a;
    transition: transform 0.15s, background 0.15s;
}
.ec-switch:checked { background: #34507a; border-color: #4a6fa5; }
.ec-switch:checked::after { transform: translateX(18px); background: #dde9ff; }
.ec-switch:focus-visible { outline: 2px solid #8af; outline-offset: 2px; }
.ec-settings .ec-modal-btn { min-height: 44px; }
/* The Forget row: its button centred, set off from the switches above. */
.ec-settings-action { justify-content: center; margin-top: 10px; padding-top: 14px; cursor: default; }
.ec-modal-btn.ec-danger { background: #5a2a2e; border-color: #8a3a42; color: #f0c8cc; }
.ec-modal-btn.ec-danger:hover { background: #7a3238; color: #fff; }
/* The Forget confirmation: a small modal on its own backdrop, over the
   Settings dialog (later in the DOM, same z-index). */
.ec-modal.ec-confirm { max-width: 360px; }

/* Blur the page behind the Settings dialog — a forward filter on the parked
   content, never backdrop-filter (see the #info-overlay comment in any page
   stylesheet: a full-screen backdrop-filter flashes). The same shape as the
   pages' own body.help-open rules; the face pages override it for their
   #app wrapper (face-template.html), whose fixed descendants a filter on the
   wrapper itself would re-anchor. */
body.ec-settings-open > *:not(.ec-modal-backdrop) { filter: blur(6px); }

.ec-modal-input {
    width: 100%; box-sizing: border-box;
    background: #1d1d30; border: 1px solid #3a3a5e; border-radius: 6px;
    color: #cdd; font-size: 12px; font-family: monospace;
    padding: 8px 10px; margin: 0 0 14px;
    text-align: left;
}

.ec-url-badge {
    position: fixed; left: 10px; bottom: 8px; z-index: 999;
    font-size: 11px; color: #99a; opacity: 0.7;
    background: rgba(0, 0, 0, 0.3); padding: 2px 8px; border-radius: 6px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    pointer-events: none; user-select: none;
}
`;

/** Ensure the shared modal/toast styles are present (idempotent). */
export function ensureModalStyles(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
}

export interface IncomingSettingsOptions {
    /**
     * 'incoming' — a shared link's parameters were detected at startup.
     * 'reprompt' — the user edited a setting while in session-only mode.
     */
    mode: 'incoming' | 'reprompt';
}

const COPY: Record<'incoming' | 'reprompt', { title: string; text: string; save: string; session: string }> = {
    incoming: {
        title: 'Use these shared settings?',
        text: 'This link includes a saved time, location, or configuration. ' +
              'Save them as your default on this device, or use them just for this visit?',
        save: 'Save as my default',
        session: 'Use for this visit only',
    },
    reprompt: {
        title: 'Save your changes?',
        text: 'You changed a setting while viewing shared settings. ' +
              'Save your current settings as the default on this device, or keep them only for this visit?',
        save: 'Save as my default',
        session: 'Keep for this visit only',
    },
};

/**
 * Show the incoming-settings dialog. Resolves with the user's choice.
 * Backdrop click and Escape resolve to 'session' (the least-committal option,
 * which never overwrites stored defaults).
 */
export function showIncomingSettingsDialog(options: IncomingSettingsOptions): Promise<SettingsChoice> {
    ensureModalStyles();
    const copy = COPY[options.mode];

    return new Promise<SettingsChoice>((resolve) => {
        const backdrop = document.createElement('div');
        backdrop.className = 'ec-modal-backdrop';

        const modal = document.createElement('div');
        modal.className = 'ec-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');

        const title = document.createElement('h2');
        title.className = 'ec-modal-title';
        title.textContent = copy.title;

        const text = document.createElement('p');
        text.className = 'ec-modal-text';
        text.textContent = copy.text;

        const buttons = document.createElement('div');
        buttons.className = 'ec-modal-buttons';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'ec-modal-btn ec-primary';
        saveBtn.textContent = copy.save;

        const sessionBtn = document.createElement('button');
        sessionBtn.className = 'ec-modal-btn';
        sessionBtn.textContent = copy.session;

        buttons.append(saveBtn, sessionBtn);
        modal.append(title, text, buttons);
        backdrop.append(modal);
        document.body.appendChild(backdrop);

        let done = false;
        const finish = (choice: SettingsChoice) => {
            if (done) return;
            done = true;
            document.removeEventListener('keydown', onKey);
            backdrop.remove();
            resolve(choice);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') finish('session');
        };

        saveBtn.addEventListener('click', () => finish('save'));
        sessionBtn.addEventListener('click', () => finish('session'));
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) finish('session');
        });
        document.addEventListener('keydown', onKey);

        saveBtn.focus();
    });
}

/**
 * Show a dismissible toast. Used to tell the user (once) that their settings
 * cannot be saved in this browser/mode and won't persist after reload.
 */
export function showStorageWarning(message: string): void {
    ensureModalStyles();
    const toast = document.createElement('div');
    toast.className = 'ec-toast';

    const span = document.createElement('span');
    span.textContent = message;

    const close = document.createElement('button');
    close.className = 'ec-toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', () => toast.remove());

    toast.append(span, close);
    document.body.appendChild(toast);

    // Auto-dismiss after a while so it doesn't linger forever.
    setTimeout(() => toast.remove(), 12000);
}

/**
 * A small replica of a corner button — its svg cloned, its computed colours
 * — for prose that points at it. The ⋮ menu clones icons the same way
 * (iconFor in overflow-menu.ts); kept here so this module imports nothing.
 * A folded button (visibility: hidden) or a display: none one still yields
 * its colours from getComputedStyle. The fallback character stands in on a
 * page without the button (not one of the four app pages).
 */
function miniButton(id: string, fallback: string): HTMLElement {
    const box = document.createElement('span');
    box.className = 'ec-mini-btn';
    box.setAttribute('aria-hidden', 'true');
    const src = document.getElementById(id);
    const svg = src?.querySelector('svg');
    if (src && svg) {
        const cs = getComputedStyle(src);
        box.style.background = cs.backgroundColor;
        box.style.color = cs.color;
        box.appendChild(svg.cloneNode(true));
    } else {
        box.textContent = fallback;
    }
    return box;
}

/**
 * The Settings notice — the one first-load toast: where the settings for all
 * three apps are, with miniatures of the real ⚙ and ⋮ buttons in the prose,
 * and on Observatory pages that the Midnight / Noon control moved there. It
 * neither auto-dismisses nor has a × — it stays until Got it is clicked
 * (Steve, 2026-09-16), and the caller records that click (prefs.ts) so the
 * notice stops appearing on load. Returns the toast so the caller can remove
 * it when another tab acknowledges first.
 */
export function showSettingsNotice(options: { observatory: boolean; onGotIt: () => void }): HTMLElement {
    ensureModalStyles();
    const toast = document.createElement('div');
    toast.className = 'ec-toast ec-notice';
    toast.setAttribute('role', 'status');

    // Text nodes around the miniatures: the words carry the meaning for
    // screen readers and copies; the miniatures are aria-hidden.
    const span = document.createElement('span');
    span.append(
        'Settings for Chronometer, Observatory and the Inspector — keep the screen awake, ' +
        'low power, and each app’s own options — are behind the ',
        miniButton('settings-btn', '⚙'),
        ' Settings button at the top right (on a phone, the first row of the ',
        miniButton('more-btn', '⋮'),
        ' menu).',
    );
    if (options.observatory) span.append(' The Midnight / Noon control now lives there too.');

    const btn = document.createElement('button');
    btn.className = 'ec-toast-btn';
    btn.textContent = 'Got it';
    btn.addEventListener('click', () => {
        toast.remove();
        options.onGotIt();
    });

    toast.append(span, btn);
    document.body.appendChild(toast);
    return toast;
}

/**
 * Discreet, persistent badge shown when the app is running in URL-parameter
 * fallback mode (local storage unavailable on a file:// page). Idempotent.
 */
export function showUrlModeBadge(): void {
    ensureModalStyles();
    if (document.getElementById('ec-url-badge')) return;
    const badge = document.createElement('div');
    badge.id = 'ec-url-badge';
    badge.className = 'ec-url-badge';
    badge.textContent = '(URL)';
    badge.title = 'Local storage is unavailable here, so settings are kept in the URL.';
    document.body.appendChild(badge);
}
