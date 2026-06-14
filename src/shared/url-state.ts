/**
 * URL State — reads and writes application state to/from URL query parameters.
 *
 * This is the "poor-man's preference system" that works even on file:// URLs
 * where localStorage may be unavailable.
 *
 * Parameters:
 *   lat   - Observer latitude (degrees, negative = south)
 *   lon   - Observer longitude (degrees, negative = west)
 *   city  - City/location label (URL-encoded, e.g. "San Francisco")
 *   bloc  - Browser location: 1 = ask browser for location on startup
 *   tc    - Time controller popover visible (1 = shown, absent = hidden)
 *   t     - Display time as Unix ms (absent = real time)
 *   off   - Millisecond offset from real time (used for 1× forward with offset)
 *   dir   - Time direction: 1=forward, -1=reverse, 0=stopped (absent = 1)
 *   tz    - IANA timezone for the location (e.g. "America/Los_Angeles")
 *   picks - Compact face selection: concatenated 2-letter abbreviations (e.g. "bbmktr")
 *   tp    - Time panel lower tab: 'd' = date (default), 'a' = astro events
 *   embed - Embed mode: 1 = Terra-only minimal embed (no chrome, transparent bg)
 *   fps   - FPS indicator: present (any/no value) = show the fps readout (Chronometer + Observatory + Inspector)
 *   op    - Observatory selected planet for the alt/az dials (0=Sun..7=Saturn, skips 4=Earth)
 *   onoon - Observatory noon-on-top toggle: 1 = noon at top of the 24h dial (absent = midnight on top)
 */

export interface UrlState {
    lat: number | null;
    lon: number | null;
    city: string | null;
    bloc: boolean;
    tc: boolean;
    t: number | null;
    off: number | null;
    dir: 1 | -1 | 0;
    tz: string | null;
    /** Compact face selection string — concatenated 2-letter abbreviations. */
    picks: string | null;
    /** Time panel lower tab: 'd' = date (default), 'a' = astro events. */
    tp: 'd' | 'a';
    /** Embed mode: minimal UI, transparent background (Terra only). */
    embed: boolean;
    /** FPS indicator: true when the `fps` param is present (Chronometer + Observatory + Inspector). */
    fps: boolean;
    /** Kyoto hand mode: '1' = fixed hand at top, null/absent = moving hand. */
    kyhand: string | null;
    /** Kyoto rate mode: '1' = constant rate, null/absent = variable rate. */
    kmode: string | null;
    /** Observatory selected planet for the alt/az dials (0=Sun..7=Saturn, skips 4=Earth). */
    op: number | null;
    /** Observatory noon-on-top toggle: true = noon at top of the 24h dial (default midnight). */
    onoon: boolean;
}

/** Parse URL query parameters into a typed state object. */
export function readUrlState(): UrlState {
    const params = new URLSearchParams(window.location.search);

    const latStr = params.get('lat');
    const lonStr = params.get('lon') || params.get('long');
    const lat = latStr !== null ? parseFloat(latStr) : NaN;
    const lon = lonStr !== null ? parseFloat(lonStr) : NaN;
    const city = params.get('city');
    const blocStr = params.get('bloc');

    const tcStr = params.get('tc');
    const tStr = params.get('t');
    const offStr = params.get('off');
    const dirStr = params.get('dir');

    let dir: 1 | -1 | 0 = 1;
    if (dirStr === '-1') dir = -1;
    else if (dirStr === '0') dir = 0;

    return {
        lat: !isNaN(lat) ? lat : null,
        lon: !isNaN(lon) ? lon : null,
        city: city || null,
        bloc: blocStr === '1',
        tc: tcStr === '1',
        t: tStr !== null ? parseInt(tStr, 10) : null,
        off: offStr !== null ? parseInt(offStr, 10) : null,
        dir,
        tz: params.get('tz') || null,
        picks: params.get('picks') || null,
        tp: params.get('tp') === 'a' ? 'a' : 'd',
        embed: params.get('embed') === '1',
        fps: params.has('fps'),
        kyhand: params.get('kyhand'),
        kmode: params.get('kmode'),
        op: (() => { const s = params.get('op'); const n = s !== null ? parseInt(s, 10) : NaN; return Number.isFinite(n) ? n : null; })(),
        onoon: params.get('onoon') === '1',
    };
}

/**
 * Merge state changes into the current URL using history.replaceState().
 * Default values are omitted from the URL to keep it clean:
 *   - tc is omitted when false
 *   - dir is omitted when 1 (forward)
 *   - t is omitted when null (real time)
 *   - lat/lon are omitted when null
 */
export function writeUrlState(changes: Partial<UrlState>): void {
    const params = new URLSearchParams(window.location.search);

    if ('lat' in changes) {
        if (changes.lat !== null && changes.lat !== undefined) {
            params.set('lat', changes.lat.toFixed(3));
        } else {
            params.delete('lat');
        }
    }
    if ('lon' in changes) {
        if (changes.lon !== null && changes.lon !== undefined) {
            params.set('lon', changes.lon.toFixed(3));
        } else {
            params.delete('lon');
        }
    }
    if ('kyhand' in changes) {
        if (changes.kyhand) params.set('kyhand', changes.kyhand);
        else params.delete('kyhand');
    }
    if ('kmode' in changes) {
        if (changes.kmode) params.set('kmode', changes.kmode);
        else params.delete('kmode');
    }
    if ('city' in changes) {
        if (changes.city) {
            params.set('city', changes.city);
        } else {
            params.delete('city');
        }
    }
    if ('bloc' in changes) {
        if (changes.bloc) {
            params.set('bloc', '1');
        } else {
            params.delete('bloc');
        }
    }
    if ('tc' in changes) {
        if (changes.tc) {
            params.set('tc', '1');
        } else {
            params.delete('tc');
        }
    }
    if ('t' in changes) {
        if (changes.t !== null && changes.t !== undefined) {
            params.set('t', changes.t.toString());
        } else {
            params.delete('t');
        }
    }
    if ('off' in changes) {
        if (changes.off !== null && changes.off !== undefined) {
            params.set('off', changes.off.toString());
        } else {
            params.delete('off');
        }
    }
    if ('dir' in changes) {
        if (changes.dir !== undefined && changes.dir !== 1) {
            params.set('dir', changes.dir.toString());
        } else {
            params.delete('dir');
        }
    }

    if ('tz' in changes) {
        if (changes.tz) {
            params.set('tz', changes.tz);
        } else {
            params.delete('tz');
        }
    }

    if ('tp' in changes) {
        if (changes.tp === 'a') {
            params.set('tp', 'a');
        } else {
            params.delete('tp');  // 'd' is default, omit from URL
        }
    }

    if ('op' in changes) {
        // 0 (Sun) is the default — omit it from the URL to keep things clean.
        if (changes.op !== null && changes.op !== undefined && changes.op !== 0) {
            params.set('op', changes.op.toString());
        } else {
            params.delete('op');
        }
    }

    if ('onoon' in changes) {
        // Midnight-on-top is the default — omit it from the URL.
        if (changes.onoon) {
            params.set('onoon', '1');
        } else {
            params.delete('onoon');
        }
    }

    // Also clean up legacy param
    params.delete('long');
    params.delete('loc');

    const qs = params.toString();
    const newUrl = window.location.pathname + (qs ? '?' + qs : '');
    history.replaceState(null, '', newUrl);

    // Update any navigation links on the page
    updateNavigationLinks();
}

/** Return the current query string (including leading '?'), or '' if none. */
export function getQueryString(): string {
    return window.location.search;
}

/**
 * Build a shareable absolute URL encoding the given state.
 *
 * "If it's in the URL today, include it" — with these exceptions:
 *   - `fps`, `embed` (diagnostic / iframe-deployment flags) and `tc` (transient
 *     popover visibility) are never shared.
 *   - Time (`t`/`off`/`dir`) is included only when "interesting" — i.e. the
 *     clock is stopped, reversed, or running with an offset. A live real-time
 *     clock contributes nothing, so the recipient sees their own current time.
 *   - `bloc` is included (the recipient's session/save choice resolves intent).
 *
 * @param state   The state to serialize (typically app-state's getState()).
 * @param baseUrl Optional base; defaults to the current origin + pathname.
 */
export function buildShareUrl(state: UrlState, baseUrl?: string): string {
    const url = new URL(baseUrl ?? (window.location.origin + window.location.pathname));
    const p = url.searchParams;

    // --- Location ---
    if (state.lat !== null && state.lat !== undefined) p.set('lat', state.lat.toFixed(3));
    if (state.lon !== null && state.lon !== undefined) p.set('lon', state.lon.toFixed(3));
    if (state.city) p.set('city', state.city);
    if (state.tz) p.set('tz', state.tz);
    if (state.bloc) p.set('bloc', '1');

    // --- Time (only when not a plain live real-time clock) ---
    if (state.off !== null && state.off !== undefined) p.set('off', state.off.toString());
    if (state.t !== null && state.t !== undefined) p.set('t', state.t.toString());
    if (state.dir !== 1) p.set('dir', state.dir.toString());

    // --- App configuration ---
    if (state.picks) p.set('picks', state.picks);
    if (state.kyhand) p.set('kyhand', state.kyhand);
    if (state.kmode) p.set('kmode', state.kmode);
    if (state.op !== null && state.op !== undefined && state.op !== 0) p.set('op', state.op.toString());
    if (state.onoon) p.set('onoon', '1');
    if (state.tp === 'a') p.set('tp', 'a');

    return url.toString();
}

/**
 * Update all navigation links on the page to carry the current query params.
 * This ensures lat/lon/tc/t/dir are preserved across page transitions.
 */
export function updateNavigationLinks(): void {
    const search = window.location.search;
    // Update back-link (← Home)
    const backLink = document.getElementById('back-link') as HTMLAnchorElement | null;
    if (backLink) {
        const url = new URL(backLink.getAttribute('data-base-href') || 'index.html', window.location.href);
        url.search = search;
        backLink.href = url.toString();
    }
    // Update all-faces-link (grid icon → all.html)
    const allFacesLink = document.getElementById('all-faces-link') as HTMLAnchorElement | null;
    if (allFacesLink) {
        const url = new URL(allFacesLink.getAttribute('data-base-href') || 'all.html', window.location.href);
        url.search = search;
        allFacesLink.href = url.toString();
    }
    // Update selected-faces-link (2×2 icon → selected.html or pick.html)
    const selectedLink = document.getElementById('selected-faces-link') as HTMLAnchorElement | null;
    if (selectedLink) {
        const params = new URLSearchParams(search);
        const hasPicks = !!params.get('picks');
        const baseHref = hasPicks ? 'selected.html' : 'pick.html';
        const url = new URL(baseHref, window.location.href);
        url.search = search;
        selectedLink.href = url.toString();
        selectedLink.title = hasPicks ? 'Selected Faces' : 'Pick Faces';
    }
    // Update edit-picks-link (shown on selected.html → pick.html)
    const editPicksLink = document.getElementById('edit-picks-link') as HTMLAnchorElement | null;
    if (editPicksLink) {
        const url = new URL('pick.html', window.location.href);
        url.search = search;
        editPicksLink.href = url.toString();
    }
    // Update face-card links (index page)
    document.querySelectorAll('a.face-card').forEach((a) => {
        const anchor = a as HTMLAnchorElement;
        const url = new URL(anchor.getAttribute('data-base-href') || anchor.getAttribute('href')!, window.location.href);
        url.search = search;
        anchor.href = url.toString();
    });
}

/**
 * Initialize link preservation. Call once on page load.
 * Saves original hrefs as data-base-href so they can be re-computed
 * each time query params change.
 */
export function initNavigationLinks(): void {
    const backLink = document.getElementById('back-link') as HTMLAnchorElement | null;
    if (backLink && !backLink.hasAttribute('data-base-href')) {
        backLink.setAttribute('data-base-href', backLink.getAttribute('href') || 'index.html');
    }
    const allFacesLink = document.getElementById('all-faces-link') as HTMLAnchorElement | null;
    if (allFacesLink && !allFacesLink.hasAttribute('data-base-href')) {
        allFacesLink.setAttribute('data-base-href', allFacesLink.getAttribute('href') || 'all.html');
    }
    // selected-faces-link destination is computed dynamically based on picks param,
    // so no data-base-href is needed — it's set in updateNavigationLinks().
    document.querySelectorAll('a.face-card').forEach((a) => {
        const anchor = a as HTMLAnchorElement;
        if (!anchor.hasAttribute('data-base-href')) {
            anchor.setAttribute('data-base-href', anchor.getAttribute('href')!);
        }
    });
    updateNavigationLinks();
}
