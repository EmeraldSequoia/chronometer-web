/**
 * Share button wiring.
 *
 * Finds the page's #share-btn (provided by each app's markup) and, on click,
 * builds a shareable URL from the current state and shows a small dialog with
 * the link and a Copy button. This is the deliberate, on-demand way to produce
 * a URL now that the address bar is normally kept clean (state lives in
 * LocalStorage). See planning/2026-06-13-localstorage-state-and-sharing.md.
 */

import { buildShareUrl, type UrlState } from './url-state.js';
import { ensureModalStyles } from './incoming-settings-dialog.js';

export interface ShareButtonOptions {
    /** Returns the current full state to serialize (typically app-state getState). */
    getState: () => UrlState;
}

export function initShareButton(options: ShareButtonOptions): void {
    const shareBtn = document.getElementById('share-btn');
    if (!shareBtn) return;
    shareBtn.addEventListener('click', () => {
        showShareDialog(buildShareUrl(options.getState()));
    });
}

/** Show the "Share this view" dialog for a prepared URL. */
export function showShareDialog(url: string): void {
    ensureModalStyles();

    const backdrop = document.createElement('div');
    backdrop.className = 'ec-modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'ec-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const title = document.createElement('h2');
    title.className = 'ec-modal-title';
    title.textContent = 'Share this view';

    const text = document.createElement('p');
    text.className = 'ec-modal-text';
    text.textContent = 'Anyone who opens this link sees this time, location, and setup. ' +
        'They choose whether to keep it as their default.';

    const input = document.createElement('input');
    input.className = 'ec-modal-input';
    input.type = 'text';
    input.readOnly = true;
    input.value = url;

    const buttons = document.createElement('div');
    buttons.className = 'ec-modal-buttons';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'ec-modal-btn ec-primary';
    copyBtn.textContent = 'Copy link';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ec-modal-btn';
    closeBtn.textContent = 'Close';

    buttons.append(copyBtn, closeBtn);
    modal.append(title, text, input, buttons);
    backdrop.append(modal);
    document.body.appendChild(backdrop);

    let done = false;
    const close = () => {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey);
        backdrop.remove();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };

    const selectAll = () => { input.focus(); input.select(); };

    copyBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(url);
            copyBtn.textContent = 'Copied!';
            setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 1500);
        } catch {
            // Clipboard API unavailable (e.g. some file:// contexts) — fall back
            // to selecting the text so the user can copy manually.
            selectAll();
            copyBtn.textContent = 'Press ⌘C to copy';
        }
    });
    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', onKey);

    // Pre-select the URL so it's immediately copyable.
    selectAll();
}
