/**
 * Host notes: the privacy text's deployment-specific passages show only on
 * the host they describe. Runs both reveal paths against the real partial —
 * shared/host-notes.ts (the help popup) and privacy.html's inline script.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';
import { applyHostNotes, hostMatches } from '../shared/host-notes';

const __dirname = dirname(fileURLToPath(import.meta.url));
const partial = readFileSync(join(__dirname, '../partials/privacy-content.html'), 'utf-8');
const page = readFileSync(join(__dirname, '../privacy.html'), 'utf-8')
    .replace('{{PRIVACY_CONTENT}}', partial);

const HOSTS: Array<[url: string, shown: boolean]> = [
    ['https://spucci.us/ecweb/privacy.html', true],
    ['https://www.spucci.us/ecweb/privacy.html', true],
    ['https://mirror.example.org/ec/privacy.html', false],
    ['https://notspucci.us/privacy.html', false],
    ['http://localhost:8080/privacy.html', false],
    ['file:///Users/me/dist/privacy.html', false],
];

function visibleText(doc: Document): string {
    const clone = doc.body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[hidden], script').forEach(el => el.remove());
    return clone.textContent ?? '';
}

describe('host notes', () => {
    test('hostMatches: the host itself and its subdomains only', () => {
        expect(hostMatches('spucci.us', 'spucci.us')).toBe(true);
        expect(hostMatches('WWW.Spucci.US', 'spucci.us')).toBe(true);
        expect(hostMatches('notspucci.us', 'spucci.us')).toBe(false);
        expect(hostMatches('spucci.us.example.org', 'spucci.us')).toBe(false);
        expect(hostMatches('', 'spucci.us')).toBe(false);
        expect(hostMatches('anything', '')).toBe(false);
    });

    test('the partial ships its host notes hidden, and names no provider outside them', () => {
        const doc = new JSDOM(partial).window.document;
        const notes = doc.querySelectorAll<HTMLElement>('[data-host]');
        expect(notes.length).toBeGreaterThan(0);
        notes.forEach(el => expect(el.hidden, el.dataset.host).toBe(true));
        expect(visibleText(doc)).not.toMatch(/siteground/i);
        expect(visibleText(doc)).toMatch(/Web Server Logs/);
    });

    // index.html carries an inline copy of the popup wiring (it loads no
    // engine bundle), which the first cut of this feature missed: the note
    // showed on privacy.html and every other page's popup, but not there.
    test('every place that fills the popup sub-view applies the host notes', () => {
        const src = join(__dirname, '..');
        const files = (readdirSync(src, { recursive: true }) as string[])
            .filter(f => /\.(ts|html)$/.test(f) && !f.includes('__tests__'))
            .filter(f => /subContent\.innerHTML\s*=/.test(readFileSync(join(src, f), 'utf-8')));
        expect(files.sort()).toEqual(['index.html', join('shared', 'help-popover.ts')]);
        for (const f of files) {
            const text = readFileSync(join(src, f), 'utf-8');
            const after = text.slice(text.search(/subContent\.innerHTML\s*=/)).split('\n').slice(1, 9).join('\n');
            expect(after, f).toMatch(/applyHostNotes\(subContent\)|querySelectorAll\("\[data-host\]"\)/);
        }
    });

    test.each(HOSTS)('index.html inline popup rule on %s → shown=%s', (url, shown) => {
        const html = readFileSync(join(__dirname, '../index.html'), 'utf-8');
        const start = html.indexOf('const host = location.hostname.toLowerCase();');
        const end = html.indexOf('slider.style.transform', start);
        expect(start).toBeGreaterThan(0);
        const rule = html.slice(start, end);
        const dom = new JSDOM(`<div id="info-sub-content">${partial}</div>`, { url, runScripts: 'outside-only' });
        dom.window.eval(`{ const subContent = document.getElementById('info-sub-content'); ${rule} }`);
        expect(/SiteGround/.test(visibleText(dom.window.document))).toBe(shown);
    });

    test.each(HOSTS)('popup path (applyHostNotes) on %s → shown=%s', (url, shown) => {
        const dom = new JSDOM(`<div id="info-sub-content">${partial}</div>`, { url });
        const root = dom.window.document.getElementById('info-sub-content')!;
        applyHostNotes(root, dom.window.location.hostname);
        expect(/SiteGround/.test(visibleText(dom.window.document))).toBe(shown);
    });

    test.each(HOSTS)('privacy.html inline script on %s → shown=%s', (url, shown) => {
        const dom = new JSDOM(page, { url, runScripts: 'dangerously' });
        expect(/SiteGround/.test(visibleText(dom.window.document))).toBe(shown);
    });
});
