/**
 * Settings dialog — the panel behind the ⚙ button, the ⋮ menu's Settings row
 * and the `,` hotkey (docs/preferences.md; Part 3 of
 * planning/2026-09-14-user-options-panel.md, decisions in its §7).
 *
 * Rows, in sections by app (planning/2026-09-23-settings-sections-and-forget-scope.md):
 * General on every page — Keep screen awake and Low power (device
 * preferences, prefs.ts; the wake-lock row only where the API exists);
 * Observatory, on observatory.html only — noon-on-top (view state: the
 * existing `onoon` setting, observatory namespace, so it still travels in
 * Observatory share links); Chronometer — no row yet, so no section. A
 * section renders only when it has a row. Last and apart from the sections,
 * Forget all settings on this device: an action, confirmed in a small modal
 * of its own on top of the dialog, and it means everything, for all three
 * apps.
 *
 * Built on the incoming-settings dialog's modal conventions
 * (`ensureModalStyles`, `.ec-modal`): a forward blur on the page content
 * behind (`body.ec-settings-open`; never backdrop-filter — it flashes);
 * Esc / backdrop / Done close it. Opening closes the help popover and the ⋮
 * menu first, so only one overlay is ever up.
 *
 * The page's render loop keeps running underneath — deliberately unlike the
 * help popover, which parks it. The dialog is up for seconds, not minutes;
 * a forward `filter` over a repainting layer is safe (the flash the pages
 * guard against came from `backdrop-filter`'s destination readback, and the
 * face pages' location dialog has always blurred a live grid this way); and
 * the toggles are meant to be seen taking effect: the Observatory's
 * noon-on-top sweep plays behind the blur, and Low power's slower cadence
 * shows at once (Steve, 2026-09-23 — parking had turned the sweep into a
 * snap on close).
 *
 * The Got-it notice (showSettingsNotice) is shown from initSettingsDialog on
 * every load until acknowledged — the only first-load toast. It yields to a
 * toast already on screen (app-state's storage warning, in in-memory mode),
 * so the two never stack, and returns on the next load.
 */

import { ensureModalStyles, showSettingsNotice } from './incoming-settings-dialog.js';
import {
    getPrefs, setPref, onPrefsChange, isOptionsSeen, markOptionsSeen, onOptionsSeen, forgetAllSettings,
    type Prefs,
} from './prefs.js';
import { isWakeLockSupported } from './wake-lock.js';
import { closeHelpPopover } from './help-popover.js';
import { closeOverflowMenu } from './overflow-menu.js';

export interface SettingsDialogOptions {
    app: 'chronometer' | 'observatory' | 'inspector' | 'index';
    /**
     * Observatory only: read and write its live noon-on-top state, so the
     * dial animates to the flipped positions. The noon row is built only on
     * `app: 'observatory'`, and only when this is supplied.
     */
    noonOnTop?: { get: () => boolean; set: (value: boolean) => void };
    /** Show the Got-it notice on this load if it has not been acknowledged (default true). */
    notice?: boolean;
}

let activeOptions: SettingsDialogOptions | null = null;
/** The open dialog's backdrop, or null. */
let openBackdrop: HTMLElement | null = null;
/** The Forget confirmation's backdrop while it is up, or null. */
let confirmBackdrop: HTMLElement | null = null;
let noticeToast: HTMLElement | null = null;

/** The page reload after Forget — replaced in tests. */
let reloadPage: () => void = () => {
    // A clean URL: in url mode the query string *is* the forgotten state.
    window.location.replace(window.location.pathname);
};

/**
 * Wire the ⚙ button (the ⋮ menu's Settings row clicks it) and show the
 * notice if it is still due. The `,` hotkey is registered by each entry
 * beside its other page keys.
 */
export function initSettingsDialog(options: SettingsDialogOptions): void {
    activeOptions = options;
    document.getElementById('settings-btn')?.addEventListener('click', () => openSettingsDialog());
    if (options.notice !== false) maybeShowNotice(options.app);
}

function maybeShowNotice(app: SettingsDialogOptions['app']): void {
    if (isOptionsSeen()) return;
    // One toast at a time: app-state's storage warning (in-memory mode) may
    // be up; this notice simply returns on the next load.
    if (document.querySelector('.ec-toast')) return;
    noticeToast = showSettingsNotice({
        observatory: app === 'observatory',
        onGotIt: () => { noticeToast = null; markOptionsSeen(); },
    });
    // Acknowledged in another tab: this tab's copy goes too.
    const off = onOptionsSeen(() => {
        noticeToast?.remove();
        noticeToast = null;
        off();
    });
}

export function isSettingsDialogOpen(): boolean {
    return openBackdrop !== null;
}

/** Close the dialog (and a Forget confirmation over it) if open; returns whether it was. */
export function closeSettingsDialog(): boolean {
    if (!openBackdrop) return false;
    closeForgetConfirm();
    const backdrop = openBackdrop;
    openBackdrop = null;
    backdrop.remove();
    document.body.classList.remove('ec-settings-open');
    return true;
}

function switchRow(label: string, hint: string, checked: boolean, onChange: (v: boolean) => void): HTMLLabelElement {
    const row = document.createElement('label');
    row.className = 'ec-settings-row';
    const text = document.createElement('span');
    text.className = 'ec-settings-text';
    const l = document.createElement('span');
    l.className = 'ec-settings-label';
    l.textContent = label;
    const h = document.createElement('span');
    h.className = 'ec-settings-hint';
    h.textContent = hint;
    text.append(l, h);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'ec-switch';
    input.setAttribute('role', 'switch');
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    row.append(text, input);
    return row;
}

/** A section title over an hrule (the `::after` line); rendered only above at least one row. */
function sectionTitle(title: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'ec-settings-section';
    el.textContent = title;
    return el;
}

function closeForgetConfirm(): boolean {
    if (!confirmBackdrop) return false;
    const backdrop = confirmBackdrop;
    confirmBackdrop = null;
    backdrop.remove();
    return true;
}

/**
 * The Forget confirmation: its own small modal over the Settings dialog
 * (Steve, 2026-09-23). Cancel, Esc and a backdrop click back out; focus
 * returns to the row's button.
 */
function openForgetConfirm(returnFocusTo: HTMLElement): void {
    if (confirmBackdrop) return;
    const backdrop = document.createElement('div');
    backdrop.className = 'ec-modal-backdrop ec-confirm-backdrop';

    const modal = document.createElement('div');
    modal.className = 'ec-modal ec-confirm';
    modal.setAttribute('role', 'alertdialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'ec-confirm-title');

    const title = document.createElement('h2');
    title.className = 'ec-modal-title';
    title.id = 'ec-confirm-title';
    title.textContent = 'Forget your settings?';

    const text = document.createElement('p');
    text.className = 'ec-modal-text';
    text.textContent = 'This clears everything saved in this browser for all three apps — ' +
        'the location and time, watch-face choices and Terra / Gaia cities, ' +
        'Observatory’s choices, and these preferences — and reloads the page.';

    const buttons = document.createElement('div');
    buttons.className = 'ec-modal-buttons';
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'ec-modal-btn ec-danger ec-settings-forget-confirm';
    yes.textContent = 'Forget';
    yes.addEventListener('click', () => {
        forgetAllSettings();
        reloadPage();
    });
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'ec-modal-btn ec-settings-forget-cancel';
    no.textContent = 'Cancel';
    const cancel = () => { closeForgetConfirm(); returnFocusTo.focus(); };
    no.addEventListener('click', cancel);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cancel(); });

    buttons.append(yes, no);
    modal.append(title, text, buttons);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    confirmBackdrop = backdrop;
    no.focus();
}

/** Open the dialog (no-op if it is already open or never initialised). */
export function openSettingsDialog(): void {
    if (!activeOptions || openBackdrop) return;
    const options = activeOptions;
    closeOverflowMenu();
    closeHelpPopover();
    ensureModalStyles();

    const backdrop = document.createElement('div');
    backdrop.className = 'ec-modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'ec-modal ec-settings';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'ec-settings-title');
    modal.tabIndex = -1;

    const title = document.createElement('h2');
    title.className = 'ec-modal-title';
    title.id = 'ec-settings-title';
    title.textContent = 'Settings';

    const rows = document.createElement('div');
    rows.className = 'ec-settings-rows';

    const prefs = getPrefs();
    let awakeInput: HTMLInputElement | null = null;
    let lowInput: HTMLInputElement | null = null;
    const awakeRow = (): HTMLElement | null => {
        if (!isWakeLockSupported()) return null;
        const row = switchRow(
            'Keep screen awake',
            'Stops the screen from dimming or locking while a page is open.',
            prefs.keepAwake,
            (v) => setPref('keepAwake', v),
        );
        awakeInput = row.querySelector('input');
        return row;
    };
    const lowPowerRow = (): HTMLElement => {
        const row = switchRow(
            'Low power',
            'Slower hand motion at 1×; saves battery. Stepping and scrubbing stay smooth.',
            prefs.lowPower,
            (v) => setPref('lowPower', v),
        );
        lowInput = row.querySelector('input');
        return row;
    };
    const noon = options.noonOnTop;
    const noonRow = (): HTMLElement | null => noon ? switchRow(
        'Noon at the top of the 24-hour dial',
        'Otherwise midnight is at the top.',
        noon.get(),
        (v) => noon.set(v),
    ) : null;

    // Sections by app (plan §2). A title renders only over at least one row,
    // so no page ever shows a bare heading. `index` is a Chronometer page:
    // it reads the chronometer namespace and shows the face set.
    const sections: Array<{ title: string; rows: Array<() => HTMLElement | null> }> = [
        { title: 'General', rows: [awakeRow, lowPowerRow] },
        { title: 'Observatory', rows: options.app === 'observatory' ? [noonRow] : [] },
        // No Chronometer-only preference yet (plan decision 1), so the
        // section is skipped; a future row belongs here, for
        // app === 'chronometer' || app === 'index'.
        { title: 'Chronometer', rows: [] },
    ];
    for (const s of sections) {
        const built = s.rows.map((build) => build()).filter((r): r is HTMLElement => r !== null);
        if (built.length === 0) continue;
        rows.append(sectionTitle(s.title), ...built);
    }

    // Forget: a centred button row after the last section; the confirmation
    // is a modal of its own. Its label states the scope — everything — so
    // sitting under an app's section cannot read as that app only.
    const forgetRow = document.createElement('div');
    forgetRow.className = 'ec-settings-row ec-settings-action';
    const forgetBtn = document.createElement('button');
    forgetBtn.type = 'button';
    forgetBtn.className = 'ec-modal-btn ec-settings-forget';
    forgetBtn.textContent = 'Forget all settings on this device…';
    forgetBtn.addEventListener('click', () => openForgetConfirm(forgetBtn));
    forgetRow.appendChild(forgetBtn);
    rows.appendChild(forgetRow);

    const buttons = document.createElement('div');
    buttons.className = 'ec-modal-buttons';
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'ec-modal-btn ec-primary ec-settings-done';
    done.textContent = 'Done';
    done.addEventListener('click', () => closeSettingsDialog());
    buttons.appendChild(done);

    modal.append(title, rows, buttons);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    document.body.classList.add('ec-settings-open');
    openBackdrop = backdrop;

    // Another tab's change while the dialog is up: keep the switches honest.
    const offPrefs = onPrefsChange((p: Prefs) => {
        if (awakeInput) awakeInput.checked = p.keepAwake;
        if (lowInput) lowInput.checked = p.lowPower;
    });

    // Esc closes the topmost of the two (the Forget confirmation first) —
    // captured on window and stopped, so the pages' own Escape ladders (which
    // close the topmost dialog) do not also fire.
    const onKey = (e: KeyboardEvent) => {
        if (e.key !== 'Escape' || openBackdrop !== backdrop) return;
        e.stopPropagation();
        e.preventDefault();
        if (closeForgetConfirm()) {
            (backdrop.querySelector('.ec-settings-forget') as HTMLElement | null)?.focus();
            return;
        }
        closeSettingsDialog();
    };
    window.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) closeSettingsDialog();
    });
    // Tear the listeners down whichever way the dialog closes.
    const observer = new MutationObserver(() => {
        if (backdrop.isConnected) return;
        observer.disconnect();
        offPrefs();
        window.removeEventListener('keydown', onKey, true);
    });
    observer.observe(document.body, { childList: true });

    modal.focus();
}

// --- Internal exports for unit tests (not part of the public API) ---
export const __test__ = {
    setReload(fn: () => void): void { reloadPage = fn; },
    isForgetConfirmOpen(): boolean { return confirmBackdrop !== null; },
    reset(): void {
        closeSettingsDialog();
        activeOptions = null;
        noticeToast?.remove();
        noticeToast = null;
    },
};
