// @vitest-environment jsdom
/**
 * Tests the Eclipse Table page module — the real shipped renderer and URL
 * builders (src/eclipse-table-page.ts), run over the full committed dataset.
 * This is the coverage that moving markup generation client-side would
 * otherwise lose (planning/2026-08-16-eclipse-table-page.md §5/§10).
 *
 * The module's page bootstrap no-ops here: jsdom's document has no
 * #eclipse-data block.
 */
import { describe, test, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
    utcMsForTdMs,
    formatUtcDate,
    formatUtcTime,
    formatViewerDateTime,
    formatSiteTime,
    formatCoords,
    observatoryUrl,
    chronometerUrl,
    renderEclipseTable,
    renderMeta,
    hydrateGlobes,
    armTodayRecenter,
    type EclipseData,
    type EclipseRecord,
} from '../eclipse-table-page';

const __dirname = dirname(fileURLToPath(import.meta.url));
const data: EclipseData = JSON.parse(
    readFileSync(join(__dirname, '../help/eclipse-data.json'), 'utf-8'),
);

/** A mid-2026 "now", inside the covered range, for deterministic rendering. */
const NOW_MS = Date.UTC(2026, 7, 19, 12, 0, 0);

const params = (url: string): URLSearchParams => new URLSearchParams(url.split('?')[1]);

describe('time derivation', () => {
    test('epoch conversion pinned to a hardcoded value', () => {
        // 2020-06-21 06:41:15 TT: leap-era, so UT = TT − (32.184 + 37) s
        // exactly. Hardcoded — not derived from the code under test — so an
        // epoch-conversion regression cannot hide behind its own mirror.
        const td = Date.UTC(2020, 5, 21, 6, 41, 15);
        expect(utcMsForTdMs(td)).toBe(td - 69184);
    });

    test('leap-era rows derive UT = TD − 69.184 s exactly', () => {
        // Any 2017–2026 row: TAI−UTC = 37 there, so ΔT is exactly 69.184.
        const row = data.eclipses.find(
            (e) => e.tdMs > Date.UTC(2018, 0, 1) && e.tdMs < Date.UTC(2026, 0, 1),
        )!;
        expect(row.tdMs - utcMsForTdMs(row.tdMs)).toBeCloseTo(69184, 6);
    });

    test('2024 Apr 08 renders at the true maximum, 18:17 UTC', () => {
        // NASA's TD 18:18:29 − 69.184 s ≈ 18:17:20 UT; their own path page
        // said 18:17:18 with a stale ΔT. Whole-minute display: 18:17.
        const row = data.eclipses.find((e) => formatUtcDate(utcMsForTdMs(e.tdMs)) === '2024 Apr 08')!;
        expect(formatUtcTime(utcMsForTdMs(row.tdMs))).toBe('18:17 UTC');
    });
});

describe('viewer and site times', () => {
    // The motivating misread: 2026 Aug 28 04:07 UTC is FRIDAY in UTC but
    // Thursday evening throughout the Americas. Locale and zone pinned so the
    // assertions hold on any machine; the page passes neither (browser
    // defaults).
    const utc = Date.UTC(2026, 7, 28, 4, 7);

    test('viewer time carries weekday, date, and an explicit zone name', () => {
        expect(formatViewerDateTime(utc, 'en-US', 'America/Los_Angeles')).toBe('Thu, Aug 27, 9:07 PM PDT');
        expect(formatViewerDateTime(utc, 'en-US', 'America/Chicago')).toBe('Thu, Aug 27, 11:07 PM CDT');
        // 24-hour locales follow their own conventions.
        expect(formatViewerDateTime(utc, 'en-GB', 'Europe/Paris')).toBe('Fri 28 Aug, 06:07 CEST');
    });

    test('viewer year appears only when it differs from the UTC year', () => {
        expect(formatViewerDateTime(utc, 'en-US', 'UTC')).toBe('Fri, Aug 28, 4:07 AM UTC');
        // 2028 Jan 01 02:00 UTC is still 2027 in California.
        const straddle = Date.UTC(2028, 0, 1, 2, 0);
        expect(formatViewerDateTime(straddle, 'en-US', 'America/Los_Angeles')).toBe(
            'Fri, Dec 31, 2027, 6:00 PM PST',
        );
    });

    test('site time is a bare wall time on the UTC date, dated across the dateline', () => {
        expect(formatSiteTime(utc, 'Etc/GMT+3', 'en-US')).toBe('1:07 AM');
        // 21:00 UTC is already the NEXT calendar day in New Zealand — the
        // month and day must come along or the time reads onto the UTC date.
        expect(formatSiteTime(Date.UTC(2035, 8, 1, 21, 0), 'Pacific/Auckland', 'en-US')).toBe(
            'Sep 2, 9:00 AM',
        );
    });

    test('an invalid zone degrades to null, not a thrown render', () => {
        expect(formatSiteTime(utc, 'Etc/GMT 5', 'en-US')).toBeNull();
    });
});

describe('deep links — every row', () => {
    test('observatory links carry frozen time, place, and zone, round-trip clean', () => {
        for (const e of data.eclipses) {
            const url = observatoryUrl(e);
            expect(url.startsWith('observatory.html?')).toBe(true);
            const p = params(url);
            // tz must survive URL decoding exactly: Etc/GMT+5 with a raw '+'
            // decodes to "Etc/GMT 5", which Intl rejects.
            expect(p.get('tz'), url).toBe(e.tz);
            expect(Number(p.get('lat')), url).toBe(e.lat);
            expect(Number(p.get('lon')), url).toBe(e.lon);
            expect(p.get('dir'), url).toBe('0');
            expect(Number(p.get('t')), url).toBe(Math.round(utcMsForTdMs(e.tdMs)));
        }
    });

    test('chronometer links select Basel+Venezia+Selene and the story body', () => {
        for (const e of data.eclipses) {
            const url = chronometerUrl(e);
            expect(url.startsWith('selected.html?')).toBe(true);
            const p = params(url);
            expect(p.get('picks'), url).toBe('bsvzsl');
            expect(p.get('body'), url).toBe(e.kind.endsWith('-lunar') ? 'moon' : 'sun');
            expect(p.get('t'), url).toBe(String(Math.round(utcMsForTdMs(e.tdMs))));
            expect(p.get('dir'), url).toBe('0');
        }
    });

    test('no raw "+" survives in any query string', () => {
        for (const e of data.eclipses) {
            expect(observatoryUrl(e)).not.toMatch(/\+/);
            expect(chronometerUrl(e)).not.toMatch(/\+/);
        }
    });
});

describe('rendering', () => {
    const render = (nowMs: number, rows: EclipseData = data) => {
        const container = document.createElement('div');
        const result = renderEclipseTable(rows, container, nowMs);
        return { container, result };
    };

    test('one year group per calendar year, all rows present', () => {
        const { container } = render(NOW_MS);
        const years = [...container.querySelectorAll('details.ek-year')].map(
            (d) => (d as HTMLElement).dataset.year,
        );
        const expected = [
            ...new Set(data.eclipses.map((e) => String(new Date(utcMsForTdMs(e.tdMs)).getUTCFullYear()))),
        ];
        expect(years).toEqual(expected);
        expect(container.querySelectorAll('.ek-card').length).toBe(data.eclipses.length);
    });

    test('marker year and neighbors render open; the rest closed', () => {
        const { container, result } = render(NOW_MS);
        expect(result.openYears).toEqual([2025, 2026, 2027]);
        for (const d of container.querySelectorAll('details.ek-year')) {
            const year = Number((d as HTMLElement).dataset.year);
            expect(d.hasAttribute('open'), String(year)).toBe(Math.abs(year - 2026) <= 1);
        }
    });

    test('today marker sits between the last past and first future card', () => {
        const { container, result } = render(NOW_MS);
        const marker = container.querySelector('#today')!;
        expect(marker).not.toBeNull();
        expect(result.ranOut).toBe(false);
        // Everything before the marker (document order) is past and dimmed;
        // everything after is future and undimmed.
        const cards = [...container.querySelectorAll('.ek-card')];
        const markerPos = marker.compareDocumentPosition.bind(marker);
        for (const card of cards) {
            const isBefore = (markerPos(card) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
            expect(card.classList.contains('ek-past'), card.textContent ?? '').toBe(isBefore);
        }
        // And the split point matches the data.
        const pastCount = data.eclipses.filter((e) => utcMsForTdMs(e.tdMs) <= NOW_MS).length;
        expect(result.markerIndex).toBe(pastCount);
    });

    test('cards carry the kind icon, derived UTC text, coordinates, and three links', () => {
        const { container } = render(NOW_MS);
        const sorted = [...data.eclipses].sort((a, b) => a.tdMs - b.tdMs);
        const cards = [...container.querySelectorAll('.ek-card')];
        cards.forEach((card, i) => {
            const e = sorted[i];
            const utcMs = utcMsForTdMs(e.tdMs);
            expect(card.querySelector('use')!.getAttribute('href')).toBe(`#ek-${e.kind}`);
            const globe = card.querySelector('.ek-globe') as HTMLElement;
            expect(Number(globe.dataset.lat)).toBe(e.lat);
            expect(Number(globe.dataset.lon)).toBe(e.lon);
            expect(card.textContent).toContain(formatUtcDate(utcMs));
            expect(card.textContent).toContain(formatUtcTime(utcMs));
            // Viewer-zone rendering (environment locale/zone here, so mirror
            // the formatter; the exact format is pinned in 'viewer and site
            // times' above). All-NBSP so the span wraps as one piece: no
            // plain space may survive.
            const localText = card.querySelector('.ek-local')!.textContent!;
            expect(localText).toBe(`· ${formatViewerDateTime(utcMs)}`.replace(/ /g, ' '));
            expect(localText).not.toContain(' ');
            expect(card.textContent).toContain(formatCoords(e.lat, e.lon));
            const links = [...card.querySelectorAll('a')].map((a) => a.getAttribute('href')!);
            expect(links.length).toBe(3);
            expect(links[0]).toBe(observatoryUrl(e));
            expect(links[1]).toBe(chronometerUrl(e));
            expect(links[2]).toBe(e.url);
        });
    });

    test('coords lines name the jump target: sublunar point vs greatest point', () => {
        const { container } = render(NOW_MS);
        const sorted = [...data.eclipses].sort((a, b) => a.tdMs - b.tdMs);
        [...container.querySelectorAll('.ek-card .ek-where')].forEach((where, i) => {
            const e = sorted[i];
            if (e.kind.endsWith('-lunar')) {
                // NOT where you'd watch from — where the Moon is overhead.
                expect(where.textContent).toContain('Moon overhead at');
                expect(where.textContent).not.toContain('there');
            } else {
                // Solar cards add the path's own wall clock — the zone the
                // deep-linked apps open in. NBSP before "there" (no widow).
                expect(where.textContent).toContain('Greatest at');
                expect(where.textContent).toContain(`· ${formatSiteTime(utcMsForTdMs(e.tdMs), e.tz)} there`);
            }
        });
    });

    test('a zone Intl rejects drops the site time, not the card', () => {
        // The same '+'-decodes-to-space hazard the deep links guard against,
        // hitting the display path: the card must degrade to bare labeled
        // coords — no "null", no dangling separator, no thrown render.
        const bad = { ...data.eclipses[0], kind: 'partial-solar', tz: 'Etc/GMT 5' } as EclipseRecord;
        const { container } = render(NOW_MS, { meta: data.meta, eclipses: [bad] });
        expect(container.querySelector('.ek-where')!.textContent).toBe(
            `Greatest at ${formatCoords(bad.lat, bad.lon)}`,
        );
    });

    test('central solar cards describe the path; others the visibility region', () => {
        const { container } = render(NOW_MS);
        const sorted = [...data.eclipses].sort((a, b) => a.tdMs - b.tdMs);
        [...container.querySelectorAll('.ek-card .ek-desc')].forEach((desc, i) => {
            const e = sorted[i];
            expect(desc.textContent).toContain(e.pathRegion ?? e.region);
        });
    });

    test('region text is inert data, never markup', () => {
        const hostile: EclipseData = {
            meta: data.meta,
            eclipses: [
                {
                    ...data.eclipses[0],
                    region: '<img src=x onerror=alert(1)> & <script>evil()</script>',
                    pathRegion: null,
                } as EclipseRecord,
            ],
        };
        const { container } = render(NOW_MS, hostile);
        expect(container.querySelector('.ek-card img:not(.ek-extlink)')).toBeNull();
        expect(container.querySelector('.ek-card script')).toBeNull();
        expect(container.querySelector('.ek-desc')!.textContent).toContain('<img src=x onerror=alert(1)>');
    });

    test('external Details link opens a new tab; app links stay in-tab', () => {
        const { container } = render(NOW_MS);
        for (const a of container.querySelectorAll('.ek-links a')) {
            const external = a.classList.contains('ek-ext');
            expect(a.getAttribute('target') === '_blank').toBe(external);
        }
    });

    test('all rows past: marker and regenerate note outside the groups', () => {
        const { container, result } = render(Date.UTC(2055, 0, 1));
        expect(result.ranOut).toBe(true);
        expect(result.openYears).toEqual([data.meta.endYear]);
        const marker = container.querySelector('#today')!;
        // Must not be buried inside a collapsed <details> — it needs a layout
        // box for scrollIntoView.
        expect(marker.closest('details')).toBeNull();
        // And its copy must not promise eclipses "below" that don't exist.
        expect(marker.textContent).toContain('every eclipse listed is in the past');
        expect(marker.textContent).not.toContain('coming');
        expect(container.querySelector('.ek-ranout')).not.toBeNull();
    });

    test('all rows future: first group and its neighbor open', () => {
        const { result } = render(Date.UTC(2005, 0, 1));
        expect(result.openYears).toEqual([data.meta.startYear, data.meta.startYear + 1]);
        expect(result.markerIndex).toBe(0);
    });

    test('late-year visitor: open set follows the marker, not the calendar', () => {
        // 2026's last eclipse is Aug 28 (lunar); by December the marker sits
        // in the 2027 group, so the open trio must be 2026-2028 — NOT
        // 2025-2027, which would leave a fully-past year open and next
        // year's five eclipses collapsed (plan §8: marker-adjacent).
        const { result } = render(Date.UTC(2026, 11, 20));
        expect(result.openYears).toEqual([2026, 2027, 2028]);
    });
});

describe('year summaries and icon symbols', () => {
    test('summary shows count and one correctly sized mini icon per eclipse', () => {
        const container = document.createElement('div');
        renderEclipseTable(data, container, NOW_MS);
        for (const group of container.querySelectorAll('details.ek-year')) {
            const year = Number((group as HTMLElement).dataset.year);
            const rows = data.eclipses
                .filter((e) => new Date(utcMsForTdMs(e.tdMs)).getUTCFullYear() === year)
                .sort((a, b) => a.tdMs - b.tdMs);
            const summary = group.querySelector('summary')!;
            expect(summary.textContent).toContain(`${rows.length} eclipse`);
            const uses = [...summary.querySelectorAll('use')];
            expect(uses.length).toBe(rows.length);
            uses.forEach((u, i) => {
                expect(u.getAttribute('href')).toBe(`#ek-${rows[i].kind}`);
                // A sizeless <use> of a <symbol> blows up to the whole minis
                // viewport and xMidYMid-shifts off its slot — the instance
                // size must be explicit or the icon row renders clipped.
                expect(u.getAttribute('width')).toBe('24');
                expect(u.getAttribute('height')).toBe('24');
                expect(u.getAttribute('x')).toBe(String(i * 26));
            });
        }
    });

    test('the shell defines a <symbol> for every kind in the dataset', () => {
        const shell = readFileSync(join(__dirname, '../eclipse-table.html'), 'utf-8');
        for (const kind of new Set(data.eclipses.map((e) => e.kind))) {
            expect(shell, kind).toContain(`<symbol id="ek-${kind}"`);
        }
        // And the legend shows all six.
        for (const kind of ['partial-solar', 'annular-solar', 'total-solar', 'hybrid-solar', 'partial-lunar', 'total-lunar']) {
            expect(shell.split(`href="#ek-${kind}"`).length, kind).toBeGreaterThanOrEqual(2);
        }
    });
});

describe('globe thumbnails', () => {
    const stub = () => {
        const calls: Array<[number, number]> = [];
        const renderer = (lat: number, lon: number): Promise<string> => {
            calls.push([lat, lon]);
            return Promise.resolve('data:image/png;base64,x');
        };
        return { calls, renderer };
    };

    test('only open year groups hydrate up front; closed groups arm for toggle', async () => {
        const container = document.createElement('div');
        renderEclipseTable(data, container, NOW_MS);
        const { calls, renderer } = stub();
        hydrateGlobes(container, renderer);
        const openCards = container.querySelectorAll('details[open] .ek-card').length;
        expect(calls.length).toBe(openCards);
        expect(calls.length).toBeLessThan(data.eclipses.length);

        // Opening a closed group hydrates exactly its cards, once.
        const closed = container.querySelector('details.ek-year:not([open])') as HTMLDetailsElement;
        const closedCards = closed.querySelectorAll('.ek-card').length;
        closed.open = true;
        closed.dispatchEvent(new Event('toggle'));
        expect(calls.length).toBe(openCards + closedCards);
        closed.dispatchEvent(new Event('toggle'));
        expect(calls.length).toBe(openCards + closedCards);

        // The hydrated globes got their background image.
        await Promise.resolve();
        const done = [...container.querySelectorAll<HTMLElement>('details[open] .ek-globe')]
            .filter((g) => g.style.backgroundImage.includes('data:image/png'));
        expect(done.length).toBe(openCards + closedCards);
    });

    test('hydration consumes the data attributes (idempotence flag)', () => {
        const container = document.createElement('div');
        renderEclipseTable(data, container, NOW_MS);
        const { calls, renderer } = stub();
        hydrateGlobes(container, renderer);
        const first = calls.length;
        hydrateGlobes(container, renderer);   // e.g. after "Show all years"
        expect(calls.length).toBe(first);     // already-hydrated cards untouched
    });
});

describe('today recenter wiring', () => {
    // A fresh EventTarget per test stands in for window, so listeners can't
    // leak between tests; the marker lives in the shared jsdom document.
    const arm = () => {
        const win = new EventTarget() as unknown as Pick<Window, 'addEventListener'> & EventTarget;
        document.body.innerHTML = '<div id="today"></div>';
        const scroll = vi.fn();
        (document.getElementById('today') as HTMLElement).scrollIntoView = scroll;
        armTodayRecenter(win, document);
        return { win, scroll };
    };

    test('centers immediately, again at load, and on every resize', () => {
        const { win, scroll } = arm();
        expect(scroll).toHaveBeenCalledTimes(1);
        win.dispatchEvent(new Event('load'));
        expect(scroll).toHaveBeenCalledTimes(2);
        // Post-load resizes (rotation, responsive-mode/device-emulator size
        // switches) reflow every card height and strand the kept pixel
        // offset far above the marker — each one must re-center.
        win.dispatchEvent(new Event('resize'));
        win.dispatchEvent(new Event('resize'));
        expect(scroll).toHaveBeenCalledTimes(4);
        expect(scroll).toHaveBeenLastCalledWith({ block: 'center' });
    });

    test('first user interaction ends all re-centering — the page is theirs', () => {
        for (const interaction of ['wheel', 'pointerdown', 'keydown']) {
            const { win, scroll } = arm();
            win.dispatchEvent(new Event(interaction));
            win.dispatchEvent(new Event('resize'));
            win.dispatchEvent(new Event('load'));
            expect(scroll, interaction).toHaveBeenCalledTimes(1);   // initial only
        }
    });

    test('a missing marker is a no-op, not a throw', () => {
        const win = new EventTarget() as unknown as Pick<Window, 'addEventListener'> & EventTarget;
        document.body.innerHTML = '';
        armTodayRecenter(win, document);
        win.dispatchEvent(new Event('resize'));
    });
});

describe('meta rendering', () => {
    const host = () => {
        document.body.innerHTML =
            '<span id="ek-span"></span><span id="ek-counts"></span>' +
            '<span id="ek-generated"></span><div id="ek-stale" hidden></div>';
        return document;
    };

    test('coverage placeholders come from meta, not hand-written text', () => {
        renderMeta(data, host(), NOW_MS);
        expect(document.getElementById('ek-span')!.textContent).toBe(
            `${data.meta.startYear} through ${data.meta.endYear}`,
        );
        expect(document.getElementById('ek-counts')!.textContent).toContain(
            `${data.meta.counts.solar} solar`,
        );
        expect(document.getElementById('ek-generated')!.textContent).toBe(data.meta.generated);
    });

    test('staleness nudge appears only near the coverage end', () => {
        renderMeta(data, host(), NOW_MS);
        expect(document.getElementById('ek-stale')!.hidden).toBe(true);
        renderMeta(data, host(), Date.UTC(data.meta.endYear, 6, 1));
        expect(document.getElementById('ek-stale')!.hidden).toBe(false);
    });
});
