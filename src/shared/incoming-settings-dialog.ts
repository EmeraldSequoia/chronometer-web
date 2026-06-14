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
    position: relative;
    background: rgba(26, 26, 46, 0.98);
    backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
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

.ec-modal-input {
    width: 100%; box-sizing: border-box;
    background: #1d1d30; border: 1px solid #3a3a5e; border-radius: 6px;
    color: #cdd; font-size: 12px; font-family: monospace;
    padding: 8px 10px; margin: 0 0 14px;
    text-align: left;
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
