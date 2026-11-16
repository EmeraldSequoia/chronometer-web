/**
 * Host notes: the privacy text's deployment-specific passages show only on
 * the host they describe. Runs both reveal paths against the real partial —
 * shared/host-notes.ts (the help popup) and privacy.html's inline script.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
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
