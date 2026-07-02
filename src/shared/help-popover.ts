// Shared wiring for the info ("ℹ") help popover used by the Chronometer face
// pages and Observatory. The page provides the markup (#info-btn,
// #info-overlay, #info-popup, #info-slider, #info-main-view, #info-sub-view,
// #help-content, the privacy/support/disclaimer <template>s and the
// #help-template) — see face-template.html and observatory.html. This module
// wires the behavior: open/close, lazy help-template cloning, the sliding
// Privacy/Support/Disclaimer sub-view with animated popup height, and the
// lazy-loaded General Help iframe.

export interface HelpPopoverOptions {
    /** URL loaded into #general-help-iframe on first expand (default 'help.html?embed=1'). */
    generalHelpUrl?: string;
    /**
     * The running app. Its own entry is removed from the "Other Apps" section
     * (partials/other-apps.html), which ships all three entries.
     */
    app?: 'chronometer' | 'observatory' | 'inspector';
    /**
     * Called once, after the help template has been cloned into #help-content
     * and external links have been retargeted — for page-specific fixups such
     * as the face pages' thumbnail/reorder pass.
     */
    onFirstOpen?: (helpContent: HTMLElement) => void;
}

/** The URL initHelpPopover configured, for openGeneralHelpTopic's lazy load. */
let activeGeneralHelpUrl = 'help.html?embed=1';

export function initHelpPopover(options: HelpPopoverOptions = {}): void {
    const generalHelpUrl = options.generalHelpUrl ?? 'help.html?embed=1';
    activeGeneralHelpUrl = generalHelpUrl;

    if (options.app) {
        document.querySelectorAll(`#other-apps-section .other-app[data-app="${options.app}"]`)
            .forEach((el) => el.remove());
    }

    const infoBtn = document.getElementById('info-btn');
    const infoOverlay = document.getElementById('info-overlay');
    const infoClose = document.getElementById('info-close');
    const helpContent = document.getElementById('help-content');
    const helpTemplate = document.getElementById('help-template') as HTMLTemplateElement | null;
    let helpLoaded = false;
    if (infoBtn && infoOverlay && infoClose) {
        infoBtn.addEventListener('click', () => {
            const slider = document.getElementById('info-slider');
            const popup = document.getElementById('info-popup');
            if (slider) slider.style.transform = 'translateX(0)';
            if (popup) popup.style.height = 'auto';
            infoOverlay.classList.add('visible');
            // Clone help template into DOM on first open
            // (images only start loading once cloned into the live DOM)
            if (!helpLoaded && helpContent && helpTemplate?.content) {
                helpLoaded = true;
                helpContent.appendChild(helpTemplate.content.cloneNode(true));
                // Open external links in a new tab so they don't navigate away from the page
                helpContent.querySelectorAll('a[href^="http"]').forEach(a => {
                    a.setAttribute('target', '_blank');
                    a.setAttribute('rel', 'noopener');
                });
                options.onFirstOpen?.(helpContent);
            }
        });
        infoClose.addEventListener('click', () => {
            infoOverlay.classList.remove('visible');
        });
        infoOverlay.addEventListener('click', (e) => {
            if (e.target === infoOverlay) {
                infoOverlay.classList.remove('visible');
            }
        });
        // Escape closes the popup (matching the share popover and location
        // dialog). A keydown while focus is inside the General Help iframe
        // stays in that document, so help.html's embed mode forwards it as a
        // 'help-escape' message.
        document.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape' && infoOverlay.classList.contains('visible')) {
                infoOverlay.classList.remove('visible');
            }
        });
        window.addEventListener('message', (e) => {
            if (e.data?.type === 'help-escape' && infoOverlay.classList.contains('visible')) {
                infoOverlay.classList.remove('visible');
            }
        });

        // Sub-view navigation (Privacy/Support/Disclaimer)
        const mainView = document.getElementById('info-main-view');
        const subView = document.getElementById('info-sub-view');
        const subContent = document.getElementById('info-sub-content');
        const backBtn = document.getElementById('info-back-btn');
        const popup = document.getElementById('info-popup');
        const slider = document.getElementById('info-slider');

        function updatePopupHeight(targetView: HTMLElement | null) {
            if (!popup || !targetView) return;
            // Measure current
            const currentHeight = popup.offsetHeight;
            popup.style.height = currentHeight + 'px';

            // Measure target (padding is now inside targetView)
            const targetHeight = targetView.scrollHeight;
            popup.style.height = targetHeight + 'px';
        }

        document.querySelectorAll('.help-subpage-link').forEach(link => {
            const el = link as HTMLElement;
            el.addEventListener('click', (e) => {
                e.preventDefault();
                const templateId = el.dataset.template;
                const template = document.getElementById(templateId!) as HTMLTemplateElement | null;
                if (template && mainView && subView && subContent && slider) {
                    subContent.innerHTML = template.innerHTML;
                    slider.style.transform = 'translateX(-50%)';
                    updatePopupHeight(subView);
                    if (helpContent) helpContent.scrollTop = 0;
                }
            });
        });

        if (backBtn) {
            backBtn.addEventListener('click', () => {
                if (mainView && subView && slider) {
                    slider.style.transform = 'translateX(0)';
                    updatePopupHeight(mainView);
                    if (helpContent) helpContent.scrollTop = 0;
                }
            });
        }
    }

    // --- General Help iframe lazy-loading ---
    const generalHelpSection = document.getElementById('general-help-section') as HTMLDetailsElement | null;
    const generalHelpIframe = document.getElementById('general-help-iframe') as HTMLIFrameElement | null;
    if (generalHelpSection && generalHelpIframe) {
        generalHelpSection.addEventListener('toggle', () => {
            if (generalHelpSection.open && !generalHelpIframe.src) {
                generalHelpIframe.src = generalHelpUrl;
            }
        });
        // Auto-resize iframe to match content height
        window.addEventListener('message', (e) => {
            if (e.data?.type === 'help-resize' && typeof e.data.height === 'number') {
                generalHelpIframe.style.height = e.data.height + 'px';
            }
        });
    }
}

/**
 * Open the info popup with the General Help Topics section expanded and the
 * iframe routed to `hash` (e.g. '#hotkeys') — help.html opens and scrolls to
 * the section on load and on hashchange. Used by the `?` hotkey.
 */
export function openGeneralHelpTopic(hash: string): void {
    const infoBtn = document.getElementById('info-btn');
    const section = document.getElementById('general-help-section') as HTMLDetailsElement | null;
    const iframe = document.getElementById('general-help-iframe') as HTMLIFrameElement | null;
    if (!infoBtn || !section || !iframe) return;
    infoBtn.click();
    // Set the src (with hash) before opening so the toggle-driven lazy load
    // doesn't beat us to it with a hashless URL.
    if (!iframe.src) {
        iframe.src = activeGeneralHelpUrl + hash;
    } else {
        const w = iframe.contentWindow;
        if (w) w.location.hash = hash;
    }
    section.open = true;
}
