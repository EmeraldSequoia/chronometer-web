// @vitest-environment jsdom
import { describe, test, expect, beforeEach } from 'vitest';
import { appNavHref, markChronometerPage, __test__ } from '../shared/app-nav.js';

const { LAST_CHRONO_KEY, resetOnChronometerPage } = __test__;

function setPage(path: string) {
    window.history.replaceState(null, '', path);
}

beforeEach(() => {
    sessionStorage.clear();
    // Each real page load starts with a fresh module; simulate that here.
    resetOnChronometerPage();
    setPage('/');
});

describe('markChronometerPage', () => {
    test('records the page filename, not the query string', () => {
        setPage('/selected.html?lat=1&lon=2');
        markChronometerPage();
        expect(sessionStorage.getItem(LAST_CHRONO_KEY)).toBe('selected.html');
    });

    test('embedded frames do not clobber the record', () => {
        setPage('/selected.html');
        markChronometerPage();
        resetOnChronometerPage();
        setPage('/terra.html?embed=1');
        markChronometerPage();
        expect(sessionStorage.getItem(LAST_CHRONO_KEY)).toBe('selected.html');
    });
});

describe('appNavHref last-Chronometer-page substitution', () => {
    test('index.html becomes the recorded page on non-Chronometer pages', () => {
        sessionStorage.setItem(LAST_CHRONO_KEY, 'babylon.html');
        setPage('/observatory.html');
        expect(appNavHref('index.html')).toBe('babylon.html');
    });

    test('no substitution on Chronometer pages (c hotkey still goes home)', () => {
        setPage('/babylon.html');
        markChronometerPage();
        expect(appNavHref('index.html')).toBe('index.html');
    });

    test('non-index targets are never substituted', () => {
        sessionStorage.setItem(LAST_CHRONO_KEY, 'babylon.html');
        setPage('/inspector.html');
        expect(appNavHref('observatory.html')).toBe('observatory.html');
        expect(appNavHref('all.html')).toBe('all.html');
    });

    test('missing or implausible recorded value falls back to index.html', () => {
        setPage('/observatory.html');
        expect(appNavHref('index.html')).toBe('index.html');
        for (const bad of ['../evil.html', 'javascript:alert(1)', 'selected.html?picks=b', '']) {
            sessionStorage.setItem(LAST_CHRONO_KEY, bad);
            expect(appNavHref('index.html')).toBe('index.html');
        }
    });

    test('URL-mode query carrying applies to the substituted page', () => {
        // Tests run without initAppState, i.e. in the URL-backend fallback,
        // where appNavHref copies the full query string.
        sessionStorage.setItem(LAST_CHRONO_KEY, 'selected.html');
        setPage('/observatory.html?lat=1&lon=2');
        expect(appNavHref('index.html')).toBe('selected.html?lat=1&lon=2');
    });
});
