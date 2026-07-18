/**
 * Fullscreen toggle shared by the faces app and the Observatory.
 *
 * Wires #fullscreen-btn to the Fullscreen API where the browser exposes it
 * (desktop, iPad), and to a "faux" fullscreen elsewhere. iPhone is the faux
 * case that matters: WebKit has never shipped element fullscreen there (video
 * elements only — verified against WebKit release notes / MDN / caniuse
 * through iOS 26.5), so the button toggles the same chrome-free presentation
 * while Safari's own bars remain.
 *
 * Both paths converge on a `body.is-fullscreen` class that page CSS uses to
 * hide chrome and swap the button's expand/compress icon; real-API state
 * changes (including Esc and system exit gestures) land in the same class via
 * the fullscreenchange events.
 */

/**
 * Wire up #fullscreen-btn (no-op if the page doesn't have one, e.g. embed
 * mode removed it). `onChange` runs after each `is-fullscreen` flip so the
 * caller can relayout for the appearing/disappearing chrome.
 */
export function initFullscreenToggle(onChange?: () => void): void {
    const btn = document.getElementById('fullscreen-btn');
    if (!btn) return;

    const doc = document as any;
    const docEl = document.documentElement as any;

    const realAvailable = !!(
        document.fullscreenEnabled ||
        doc.webkitFullscreenEnabled ||
        doc.mozFullScreenEnabled ||
        doc.msFullscreenEnabled
    );

    const applyState = (active: boolean) => {
        document.body.classList.toggle('is-fullscreen', active);
        onChange?.();
    };

    if (realAvailable) {
        // The change events are the single source of truth for the body class:
        // they also fire on Esc and on system exit gestures.
        const onFsChange = () => {
            const fsEl = doc.fullscreenElement || doc.webkitFullscreenElement ||
                doc.mozFullScreenElement || doc.msFullscreenElement;
            applyState(!!fsEl);
        };
        document.addEventListener('fullscreenchange', onFsChange);
        document.addEventListener('webkitfullscreenchange', onFsChange);

        btn.addEventListener('click', () => {
            const fsEl = doc.fullscreenElement || doc.webkitFullscreenElement ||
                doc.mozFullScreenElement || doc.msFullscreenElement;
            if (fsEl) {
                if (doc.exitFullscreen) {
                    doc.exitFullscreen();
                } else if (doc.webkitExitFullscreen) {
                    doc.webkitExitFullscreen();
                } else if (doc.mozCancelFullScreen) {
                    doc.mozCancelFullScreen();
                } else if (doc.msExitFullscreen) {
                    doc.msExitFullscreen();
                }
            } else {
                if (docEl.requestFullscreen) {
                    docEl.requestFullscreen();
                } else if (docEl.webkitRequestFullscreen) {
                    docEl.webkitRequestFullscreen();
                } else if (docEl.mozRequestFullScreen) {
                    docEl.mozRequestFullScreen();
                } else if (docEl.msRequestFullscreen) {
                    docEl.msRequestFullscreen();
                }
            }
        });
    } else {
        btn.addEventListener('click', () => {
            applyState(!document.body.classList.contains('is-fullscreen'));
        });
        // Esc parity with the real API (hardware keyboards exist on iPhone too).
        window.addEventListener('keydown', (ev: KeyboardEvent) => {
            if (ev.key === 'Escape' && document.body.classList.contains('is-fullscreen')) {
                applyState(false);
            }
        });
    }
}
