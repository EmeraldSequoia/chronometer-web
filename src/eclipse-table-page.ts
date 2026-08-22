/**
 * Eclipse Table page module (eclipse-table.html).
 *
 * Renders the card list from the JSON embedded in the page's
 * <script type="application/json" id="eclipse-data"> block — inlined at build
 * time from src/help/eclipse-data.json, so the page works on file:// with no
 * fetch. See planning/2026-08-16-eclipse-table-page.md §5.
 *
 * The dataset stores each eclipse's *TT* instant (`tdMs`): NASA's published UT
 * labels bake in ΔT predictions of assorted vintages, so UT is derived here at
 * render time via the engine's own leap-second-exact ΔT (convertETtoUT). Deep
 * links therefore land on the engine's maximum eclipse, and they self-correct
 * whenever the leap-second table is updated, with no data re-scrape — the
 * bundle rebuilds on every build.
 *
 * Everything except the module's last line is exported pure logic so the
 * vitest (src/__tests__/eclipse-table-page.test.ts) exercises the real
 * shipped renderer and URL builders.
 */

import { convertETtoUT } from './astronomy/es-time.js';
import { renderGlobe } from './shared/mini-map.js';

// ---------------------------------------------------------------------------
// Data types (the shape scrape-eclipses.mjs emits)
// ---------------------------------------------------------------------------

export interface EclipseRecord {
    tdMs: number;
    nasaDeltaT: number;
    kind: string;
    region: string;
    pathRegion: string | null;
    lat: number;
    lon: number;
    coordSource: string;
    tz: string;
    url: string;
}

export interface EclipseData {
    meta: {
        generated: string;
        startYear: number;
        endYear: number;
        acknowledgment: string;
        counts: { total: number; solar: number; lunar: number };
    };
    eclipses: EclipseRecord[];
}

// ---------------------------------------------------------------------------
// Time and formatting
// ---------------------------------------------------------------------------

/** Unix seconds of the Apple epoch (2001-01-01), the engine's time origin. */
const APPLE_EPOCH_UNIX_S = 978307200;

/** UT instant (Unix ms) of a stored TT instant, via the engine's ΔT. */
export function utcMsForTdMs(tdMs: number): number {
    const etSeconds = tdMs / 1000 - APPLE_EPOCH_UNIX_S;
    return (convertETtoUT(etSeconds) + APPLE_EPOCH_UNIX_S) * 1000;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2028 Jul 22" — date leads each card so a scanning eye falls down dates. */
export function formatUtcDate(utcMs: number): string {
    const d = new Date(roundToMinute(utcMs));
    return `${d.getUTCFullYear()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** "02:56 UTC" — rounded to the nearest minute (not truncated: rounding is
 *  what reproduces the times NASA and everyone else publish). */
export function formatUtcTime(utcMs: number): string {
    const d = new Date(roundToMinute(utcMs));
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

function roundToMinute(ms: number): number {
    return Math.round(ms / 60000) * 60000;
}

/** Gregorian calendar year of the instant in `timeZone` (browser's if omitted). */
function yearIn(d: Date, timeZone?: string): number {
    return Number(new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone }).format(d));
}

/**
 * "Thu, Aug 27, 9:07 PM PDT" — the same instant on the viewer's own clock.
 * The zone is always named explicitly (never the word "local", which a
 * solar-eclipse reader could take to mean the path's zone — the zone the app
 * links actually open in). The weekday appears only on this side, where
 * weekday reasoning is valid; the UTC lead stays weekday-less so nobody
 * anchors to "Friday" for an eclipse that is Thursday evening where they
 * live. The year is added only when it differs from the UTC year (a card
 * near the Dec 31/Jan 1 boundary), so "Dec 31" can't read as the group's
 * year. `locale`/`timeZone` are test seams; the page passes neither.
 */
export function formatViewerDateTime(utcMs: number, locale?: string, timeZone?: string): string {
    const d = new Date(roundToMinute(utcMs));
    const opts: Intl.DateTimeFormatOptions = {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    };
    if (timeZone) opts.timeZone = timeZone;
    if (yearIn(d, timeZone) !== d.getUTCFullYear()) opts.year = 'numeric';
    return d.toLocaleString(locale, opts);
}

/**
 * "5:20 PM" — the wall clock at the greatest-eclipse point, in the zone the
 * deep links open the apps in (`e.tz`). When the site's calendar date
 * differs from the UTC date (a path near the dateline), the site's month and
 * day are included so the time can't be misread onto the card's UTC date.
 * Null if Intl rejects the zone: the card then omits the site time rather
 * than losing the whole render.
 */
export function formatSiteTime(utcMs: number, tz: string, locale?: string): string | null {
    const d = new Date(roundToMinute(utcMs));
    try {
        const dateIn = (zone: string): string =>
            new Intl.DateTimeFormat('en-US', {
                year: 'numeric', month: 'numeric', day: 'numeric', timeZone: zone,
            }).format(d);
        const sameDate = dateIn(tz) === dateIn('UTC');
        return d.toLocaleString(locale, {
            ...(sameDate ? {} : { month: 'short', day: 'numeric' }),
            hour: 'numeric', minute: '2-digit', timeZone: tz,
        });
    } catch {
        return null;
    }
}

export function formatCoords(lat: number, lon: number): string {
    const latStr = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}`;
    const lonStr = `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
    return `${latStr} ${lonStr}`;
}

const KIND_LABELS: Record<string, string> = {
    'partial-solar': 'Partial solar',
    'annular-solar': 'Annular solar',
    'total-solar': 'Total solar',
    'hybrid-solar': 'Hybrid solar',
    'partial-lunar': 'Partial lunar',
    'total-lunar': 'Total lunar',
};

export function kindLabel(kind: string): string {
    return KIND_LABELS[kind] ?? kind;
}

// ---------------------------------------------------------------------------
// Deep links
// ---------------------------------------------------------------------------

/**
 * Every value goes through URLSearchParams: an unencoded `+` in a query
 * string decodes to a space, which turns the nautical zones (Etc/GMT+5, 26 of
 * the rows) into invalid timezones that Intl rejects with a RangeError.
 */
function queryFor(e: EclipseRecord, extra: [string, string][]): string {
    const params = new URLSearchParams(extra);
    params.set('lat', String(e.lat));
    params.set('lon', String(e.lon));
    params.set('tz', e.tz);
    // Frozen at maximum (dir=0): ?t= alone resumes running at 1×. Integer ms —
    // the apps parse it with parseInt.
    params.set('t', String(Math.round(utcMsForTdMs(e.tdMs))));
    params.set('dir', '0');
    return params.toString();
}

export function observatoryUrl(e: EclipseRecord): string {
    return `observatory.html?${queryFor(e, [])}`;
}

export function chronometerUrl(e: EclipseRecord): string {
    // Basel (eclipse indicator), Venezia (showing the story's body), Selene
    // (moon data), in display order. body reaches Venezia even on the
    // selected-faces page (watch-env applies it after XML init).
    const body = e.kind.endsWith('-lunar') ? 'moon' : 'sun';
    return `selected.html?${queryFor(e, [['picks', 'bsvzsl'], ['body', body]])}`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface RenderResult {
    /** Calendar years (UTC) that rendered open. */
    openYears: number[];
    /** Where the today marker landed: index into the sorted rows of the first
     *  future eclipse (rows.length if all are past). */
    markerIndex: number;
    /** True when the marker fell past the last row (table has run out). */
    ranOut: boolean;
}

function buildCard(doc: Document, e: EclipseRecord, utcMs: number, past: boolean): HTMLElement {
    const card = doc.createElement('div');
    card.className = past ? 'ek-card ek-past' : 'ek-card';

    const iconNS = 'http://www.w3.org/2000/svg';
    const icon = doc.createElementNS(iconNS, 'svg');
    icon.setAttribute('class', 'ek-icon');
    // Decorative for screen readers: the description line names the kind.
    icon.setAttribute('aria-hidden', 'true');
    const use = doc.createElementNS(iconNS, 'use');
    use.setAttribute('href', `#ek-${e.kind}`);
    icon.appendChild(use);
    card.appendChild(icon);

    // Orthographic Blue Marble thumbnail centered on the maximum-eclipse
    // point — hydrated lazily when the card's year group is first opened
    // (hydrateGlobes), so 115 globes never render up front.
    const globe = doc.createElement('span');
    globe.className = 'ek-globe';
    globe.setAttribute('aria-hidden', 'true');
    globe.dataset.lat = String(e.lat);
    globe.dataset.lon = String(e.lon);
    card.appendChild(globe);

    const main = doc.createElement('div');
    main.className = 'ek-main';

    const when = doc.createElement('div');
    when.className = 'ek-when';
    const date = doc.createElement('b');
    date.textContent = formatUtcDate(utcMs);
    const time = doc.createElement('span');
    time.className = 'ek-time';
    time.textContent = formatUtcTime(utcMs);
    const local = doc.createElement('span');
    local.className = 'ek-local';
    // NBSP throughout: the viewer time is one unbreakable piece, so it sits
    // on its own line unless it fits beside the UTC lead — never "9:07 / PM
    // PDT" — and the leading dot travels with it.
    local.textContent = `· ${formatViewerDateTime(utcMs)}`.replace(/ /g, ' ');
    when.append(date, ' ', time, ' ', local);

    const desc = doc.createElement('div');
    desc.className = 'ek-desc';
    // Region strings are third-party text (NASA's own prose) — textContent,
    // never markup.
    desc.textContent = `${kindLabel(e.kind)} — ${e.pathRegion ?? e.region}`;

    // Name the point the links jump to, right where the confusion strikes:
    // for a lunar eclipse it is NOT where you'd watch from, it's where the
    // Moon is overhead. Solar cards add the site's own wall time — the number
    // that matters on the path, and the clock the deep-linked apps show.
    const where = doc.createElement('div');
    where.className = 'ek-where';
    if (e.kind.endsWith('-lunar')) {
        where.textContent = `Moon overhead at ${formatCoords(e.lat, e.lon)}`;
    } else {
        const siteTime = formatSiteTime(utcMs, e.tz);
        // NBSP so "there" can't widow onto its own line on narrow screens.
        where.textContent =
            `Greatest at ${formatCoords(e.lat, e.lon)}` + (siteTime ? ` · ${siteTime} there` : '');
    }

    main.append(when, desc, where);
    card.appendChild(main);

    const links = doc.createElement('div');
    links.className = 'ek-links';
    const obs = doc.createElement('a');
    obs.href = observatoryUrl(e);
    obs.textContent = 'Observatory';
    const chrono = doc.createElement('a');
    chrono.href = chronometerUrl(e);
    chrono.textContent = 'Chronometer';
    const details = doc.createElement('a');
    details.href = e.url;
    details.target = '_blank';
    details.rel = 'noopener';
    details.className = 'ek-ext';
    details.textContent = 'Details';
    const ext = doc.createElement('img');
    ext.src = 'help/images/extlink.png';
    ext.alt = '(external link)';
    ext.className = 'ek-extlink';
    details.appendChild(ext);
    links.append(obs, chrono, details);
    card.appendChild(links);

    return card;
}

function buildTodayMarker(doc: Document, nowMs: number, ranOut: boolean): HTMLElement {
    const marker = doc.createElement('div');
    marker.className = 'ek-today';
    marker.id = 'today';
    const d = new Date(nowMs);
    const date = `${d.getUTCFullYear()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}`;
    marker.textContent = ranOut
        ? `— Today · ${date} — every eclipse listed is in the past —`
        : `— Today · ${date} — eclipses above have happened; those below are coming —`;
    return marker;
}

/**
 * Build the year-grouped card list into `container` (which is emptied first).
 * `nowMs` is a parameter so tests pin it; the page passes Date.now().
 */
export function renderEclipseTable(data: EclipseData, container: HTMLElement, nowMs: number): RenderResult {
    const doc = container.ownerDocument;
    container.textContent = '';

    const rows = data.eclipses
        .map((e) => ({ e, utcMs: utcMsForTdMs(e.tdMs) }))
        .sort((a, b) => a.utcMs - b.utcMs);

    const markerIndex = rows.findIndex((r) => r.utcMs > nowMs);
    const ranOut = markerIndex === -1;

    // Open the group containing the marker and its neighbors — derived from
    // the marker position, not the calendar, so late-year visitors see next
    // year's eclipses open rather than a fully-past year (plan §8). UTC
    // throughout, so the choice is deterministic worldwide.
    const allYears = [...new Set(rows.map((r) => new Date(r.utcMs).getUTCFullYear()))];
    let openYears: number[] = [];
    if (ranOut) {
        // All past: force the last group open (the marker and regenerate note
        // land after it).
        if (allYears.length > 0) openYears = [allYears[allYears.length - 1]];
    } else {
        const containing = new Date(rows[markerIndex].utcMs).getUTCFullYear();
        const ci = allYears.indexOf(containing);
        openYears = allYears.slice(Math.max(0, ci - 1), ci + 2);
    }

    let group: HTMLElement | null = null;
    let groupBody: HTMLElement | null = null;
    let groupYear = NaN;

    rows.forEach((row, i) => {
        const year = new Date(row.utcMs).getUTCFullYear();
        if (year !== groupYear) {
            groupYear = year;
            group = doc.createElement('details');
            group.className = 'ek-year';
            group.dataset.year = String(year);
            if (openYears.includes(year)) group.setAttribute('open', '');

            const yearRows = rows.filter((r) => new Date(r.utcMs).getUTCFullYear() === year);
            const summary = doc.createElement('summary');
            const label = doc.createElement('span');
            const yearB = doc.createElement('b');
            yearB.textContent = String(year);
            label.append(yearB, ` · ${yearRows.length} eclipse${yearRows.length === 1 ? '' : 's'} `);
            const minis = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
            minis.setAttribute('class', 'ek-minis');
            minis.setAttribute('viewBox', `0 0 ${yearRows.length * 26} 24`);
            minis.setAttribute('width', String(yearRows.length * 17));
            minis.setAttribute('height', '16');
            minis.setAttribute('aria-hidden', 'true');
            yearRows.forEach((r, j) => {
                const use = doc.createElementNS('http://www.w3.org/2000/svg', 'use');
                use.setAttribute('href', `#ek-${r.e.kind}`);
                use.setAttribute('x', String(j * 26));
                // A sizeless <use> of a <symbol> instantiates at 100%×100% of
                // the nearest viewport and xMidYMid-shifts off its x slot —
                // the instance must carry the symbol's own size.
                use.setAttribute('width', '24');
                use.setAttribute('height', '24');
                minis.appendChild(use);
            });
            label.appendChild(minis);
            summary.appendChild(label);
            group.appendChild(summary);

            groupBody = doc.createElement('div');
            groupBody.className = 'ek-cards';
            group.appendChild(groupBody);
            container.appendChild(group);
        }
        if (i === markerIndex) {
            groupBody!.appendChild(buildTodayMarker(doc, nowMs, false));
        }
        groupBody!.appendChild(buildCard(doc, row.e, row.utcMs, row.utcMs <= nowMs));
    });

    if (ranOut && rows.length > 0) {
        // All rows are past: the marker (and the regenerate nudge) must live
        // OUTSIDE the collapsed groups or it has no layout box to scroll to.
        container.appendChild(buildTodayMarker(doc, nowMs, true));
        const note = doc.createElement('div');
        note.className = 'ek-ranout';
        note.textContent =
            'This table has run out — every eclipse listed is in the past. ' +
            'Re-run scripts/scrape-eclipses.mjs to extend it (see the source note above).';
        container.appendChild(note);
    }

    return { openYears, markerIndex: ranOut ? rows.length : markerIndex, ranOut };
}

export type GlobeRenderer = (lat: number, lon: number, sizePx: number) => Promise<string>;

/**
 * Default globe renderer: the location dialog's orthographic Blue Marble
 * globe (shared/mini-map.ts), drawn into a shared scratch canvas and handed
 * back as a small PNG data URL — the canvas is reused, so no per-card canvas
 * backing store survives (the [mem] concern for 115 cards).
 */
let scratchCanvas: HTMLCanvasElement | null = null;
/**
 * Renders are strictly serialized: mini-map's one-time texture load resolves
 * only its most recent caller when raced (its onload is reassigned per call),
 * and concurrent renders into the shared scratch canvas would capture each
 * other's pixels. One at a time, both hazards vanish — and 115 globes at a
 * few ms each still fill progressively fast.
 */
let globeQueue: Promise<unknown> = Promise.resolve();
function renderGlobeDataUrl(lat: number, lon: number, sizePx: number): Promise<string> {
    const run = globeQueue.then(async () => {
        scratchCanvas ??= document.createElement('canvas');
        if (scratchCanvas.width !== sizePx) {
            scratchCanvas.width = sizePx;
            scratchCanvas.height = sizePx;
        }
        if (!scratchCanvas.getContext('2d')) return '';   // no canvas (jsdom): skip
        await renderGlobe(scratchCanvas, lat, lon);
        return scratchCanvas.toDataURL('image/png');
    });
    globeQueue = run.catch(() => undefined);
    return run;
}

/**
 * Render globe thumbnails for every card in an OPEN year group, and arm each
 * closed group to hydrate on its first open. Idempotent per card (the
 * data-lat attribute is consumed as the "not yet hydrated" flag).
 */
export function hydrateGlobes(container: HTMLElement, renderer: GlobeRenderer = renderGlobeDataUrl): void {
    const sizePx = 96;   // 48 CSS px at 2× — crisp on typical displays
    const hydrateGroup = (group: Element): void => {
        for (const globe of group.querySelectorAll<HTMLElement>('.ek-globe[data-lat]')) {
            const lat = Number(globe.dataset.lat);
            const lon = Number(globe.dataset.lon);
            delete globe.dataset.lat;
            delete globe.dataset.lon;
            void renderer(lat, lon, sizePx).then(
                (url) => { if (url) globe.style.backgroundImage = `url(${url})`; },
                () => {},   // a failed globe render leaves the plain disc
            );
        }
    };
    for (const group of container.querySelectorAll('details.ek-year')) {
        if ((group as HTMLDetailsElement).open) hydrateGroup(group);
        else group.addEventListener('toggle', () => hydrateGroup(group), { once: true });
    }
}

/**
 * Fill the intro's coverage placeholders from meta, so a re-scrape can never
 * leave stale hand-written years behind, and surface the staleness nudge when
 * the table nears its end.
 */
export function renderMeta(data: EclipseData, doc: Document, nowMs: number): void {
    const span = doc.getElementById('ek-span');
    if (span) span.textContent = `${data.meta.startYear} through ${data.meta.endYear}`;
    const counts = doc.getElementById('ek-counts');
    if (counts) {
        counts.textContent = `${data.meta.counts.solar} solar and ${data.meta.counts.lunar} lunar eclipses`;
    }
    const generated = doc.getElementById('ek-generated');
    if (generated) generated.textContent = data.meta.generated;

    const stale = doc.getElementById('ek-stale');
    if (stale) {
        const coverageEndMs = Date.UTC(data.meta.endYear, 11, 31);
        const oneYearMs = 365 * 24 * 3600 * 1000;
        if (nowMs > coverageEndMs - oneYearMs) {
            stale.textContent =
                `This table's coverage ends in ${data.meta.endYear} — time to re-run ` +
                'scripts/scrape-eclipses.mjs to extend it.';
            stale.hidden = false;
        }
    }
}

/**
 * Center the today marker, and keep it centered while the page is still
 * untouched. The initial synchronous scroll can be silently undone with no
 * further script running: the browser clamps it if the viewport resizes
 * before full load (mobile browser chrome settling, embedded panes), and a
 * resize AFTER load — rotation, split view, a responsive-mode or
 * device-emulator size switch — reflows every card height while keeping the
 * old pixel offset, stranding the view several hundred pixels above the
 * marker. So re-center at load and on every resize, until the visitor first
 * interacts: after a wheel, pointer, or key the page is theirs and is never
 * yanked. Exported for tests; the page passes window/document.
 */
export function armTodayRecenter(win: Pick<Window, 'addEventListener'>, doc: Document): void {
    const recenter = () => doc.getElementById('today')?.scrollIntoView({ block: 'center' });
    recenter();
    let userScrolled = false;
    for (const evt of ['wheel', 'pointerdown', 'keydown']) {
        win.addEventListener(evt, () => { userScrolled = true; }, { once: true, passive: true });
    }
    win.addEventListener('load', () => { if (!userScrolled) recenter(); }, { once: true });
    win.addEventListener('resize', () => { if (!userScrolled) recenter(); });
}

// ---------------------------------------------------------------------------
// Page bootstrap (no-op under tests: the block only exists on the real page)
// ---------------------------------------------------------------------------

function initPage(): void {
    const block = document.getElementById('eclipse-data');
    const container = document.getElementById('eclipse-list');
    if (!block || !container) return;

    let data: EclipseData;
    try {
        data = JSON.parse(block.textContent ?? '') as EclipseData;
        if (!Array.isArray(data.eclipses) || data.eclipses.length === 0) throw new Error('no eclipse rows');
    } catch (err) {
        container.textContent =
            `Could not load the eclipse data baked into this page (${(err as Error).message}). ` +
            'This is a build problem — the {{ECLIPSE_DATA}} injection failed.';
        container.className = 'ek-error';
        return;
    }

    const now = Date.now();
    renderMeta(data, document, now);
    renderEclipseTable(data, container, now);
    hydrateGlobes(container);

    document.getElementById('ek-expand')?.addEventListener('click', (ev) => {
        ev.preventDefault();
        for (const d of document.querySelectorAll('details.ek-year')) d.setAttribute('open', '');
        hydrateGlobes(container);
    });

    // Land on the marker (it always exists), unless the visitor asked for a
    // specific anchor or the browser is restoring a scroll position. Plain
    // synchronous scrollIntoView — no rAF, which some embedded panes never
    // fire; the cards have no images or webfonts, so layout is already stable.
    const nav = performance.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined;
    const isReload = nav?.type === 'reload' || nav?.type === 'back_forward';
    if (!location.hash && !isReload) armTodayRecenter(window, document);
}

if (typeof document !== 'undefined') initPage();
