// Host notes: passages that are true only for one known deployment of the
// app — e.g. the access-log retention of the provider behind spucci.us
// (partials/privacy-content.html). The markup ships them hidden, tagged with
// `data-host="<hostname>"`; this reveals the ones matching the host the page
// was actually loaded from, so a mirror (or a file:// copy) never shows
// another site's claims.
//
// privacy.html has no bundle, so it carries the same rule as an inline
// script; host-notes.test.ts runs both against the real partial.

/** True when `hostname` is `host` itself or a subdomain of it (www.…). */
export function hostMatches(hostname: string, host: string): boolean {
    const h = hostname.toLowerCase();
    const want = host.toLowerCase();
    return want !== '' && (h === want || h.endsWith('.' + want));
}

/** Show the `[data-host]` notes under `root` that apply to `hostname`; hide the rest. */
export function applyHostNotes(root: ParentNode, hostname: string = location.hostname): void {
    root.querySelectorAll<HTMLElement>('[data-host]').forEach(el => {
        el.hidden = !hostMatches(hostname, el.dataset.host ?? '');
    });
}
