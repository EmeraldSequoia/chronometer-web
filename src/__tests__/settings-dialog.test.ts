// @vitest-environment jsdom
/**
 * The Settings dialog (src/shared/settings-dialog.ts), its notice, and the ⋮
 * menu's Settings row (docs/preferences.md).
 *
 * Pinned: the sections per app and what each row writes (the wake-lock row
 * only where the API exists; the noon row only on Observatory, through its
 * live setter; never a title without a row); Esc closing without reaching
 * the pages' own Escape ladders; the Forget confirmation (a modal of its
 * own, closed first by Esc) and what it clears; the notice's text and its
 * button miniatures, its show / Got-it / skip-when-another-toast rules, and
 * that it is the only first-load toast.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { initSettingsDialog, openSettingsDialog, closeSettingsDialog, isSettingsDialogOpen, __test__ } from '../shared/settings-dialog.js';
import { getPrefs, isOptionsSeen, __test__ as prefsTest } from '../shared/prefs.js';
import { initAppState } from '../shared/app-state.js';
import { initOverflowMenu, ROW_SPECS } from '../shared/overflow-menu.js';
import { __test__ as wakeTest } from '../shared/wake-lock.js';

const PAGE = `
  <div id="app">
    <button id="settings-btn" style="background: rgb(1, 2, 3); color: rgb(4, 5, 6)"><svg viewBox="0 0 24 24"><path class="gear" d="M1 1h2"/></svg></button>
    <button id="info-btn">i</button>
    <button id="more-btn" style="background: rgb(7, 8, 9); color: rgb(10, 11, 12)"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2"/></svg></button>
    <div id="more-menu" role="menu" hidden></div>
    <div id="info-overlay"><button id="info-close">x</button></div>
  </div>`;

function modal(): HTMLElement | null { return document.querySelector('.ec-modal.ec-settings'); }
function rowLabels(): string[] {
    return [...document.querySelectorAll('.ec-settings-rows .ec-settings-label')].map((e) => e.textContent ?? '');
}
function sectionTitles(): string[] {
    return [...document.querySelectorAll('.ec-settings-rows .ec-settings-section')].map((e) => e.textContent ?? '');
}
function switchFor(label: string): HTMLInputElement {
    const l = [...document.querySelectorAll('.ec-settings-row')].find((r) => r.querySelector('.ec-settings-label')?.textContent === label);
    if (!l) throw new Error(`no row ${label}`);
    return l.querySelector('input.ec-switch') as HTMLInputElement;
}
function flip(input: HTMLInputElement, on: boolean): void {
    input.checked = on;
    input.dispatchEvent(new Event('change'));
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
    prefsTest.reset();
    wakeTest.reset();
    __test__.reset();
    document.body.innerHTML = PAGE;
    document.body.className = '';
    initAppState({ app: 'chronometer' });
});

afterEach(() => {
    __test__.reset();
    delete (navigator as unknown as Record<string, unknown>).wakeLock;
    vi.restoreAllMocks();
});

describe('opening and closing', () => {
    test('the ⚙ button opens it (blur class on, focus inside); Done closes it', () => {
        initSettingsDialog({ app: 'chronometer', notice: false });
        document.getElementById('settings-btn')!.click();
        expect(modal()).not.toBeNull();
        expect(isSettingsDialogOpen()).toBe(true);
        expect(document.body.classList.contains('ec-settings-open')).toBe(true);
        expect(modal()!.contains(document.activeElement)).toBe(true);
        (document.querySelector('.ec-settings-done') as HTMLElement).click();
        expect(modal()).toBeNull();
        expect(document.body.classList.contains('ec-settings-open')).toBe(false);
    });

    test('Esc closes it and does not reach the page\'s document-level Escape handlers', () => {
        initSettingsDialog({ app: 'chronometer', notice: false });
        const ladder = vi.fn();
        document.addEventListener('keydown', ladder);
        openSettingsDialog();
        // Dispatched where a real key lands (the focused element), so the
        // capture phase runs window → document → target.
        (document.activeElement ?? document.body).dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(modal()).toBeNull();
        expect(ladder).not.toHaveBeenCalled();
        // Gone with the dialog: a later Escape reaches the page again.
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(ladder).toHaveBeenCalledTimes(1);
        document.removeEventListener('keydown', ladder);
    });

    test('a backdrop click closes it; opening twice is a no-op', () => {
        initSettingsDialog({ app: 'chronometer', notice: false });
        openSettingsDialog();
        openSettingsDialog();
        expect(document.querySelectorAll('.ec-modal.ec-settings').length).toBe(1);
        (document.querySelector('.ec-modal-backdrop') as HTMLElement).click();
        expect(modal()).toBeNull();
        expect(closeSettingsDialog()).toBe(false);
    });

    test('opening closes the help popover first', () => {
        initSettingsDialog({ app: 'chronometer', notice: false });
        const overlay = document.getElementById('info-overlay')!;
        overlay.classList.add('visible');
        const closeBtn = document.getElementById('info-close')!;
        const clicked = vi.fn();
        closeBtn.addEventListener('click', clicked);
        openSettingsDialog();
        expect(clicked).toHaveBeenCalledTimes(1);
    });
});

describe('rows', () => {
    test('without the Wake Lock API the row is not offered', () => {
        initSettingsDialog({ app: 'chronometer', notice: false });
        openSettingsDialog();
        expect(rowLabels()).toEqual(['Low power']);
        expect(document.querySelector('.ec-settings-forget')).not.toBeNull();
    });

    test('with the API, Keep screen awake comes first and writes the preference', () => {
        Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: vi.fn() } });
        initSettingsDialog({ app: 'chronometer', notice: false });
        openSettingsDialog();
        expect(rowLabels()[0]).toBe('Keep screen awake');
        flip(switchFor('Keep screen awake'), true);
        expect(getPrefs().keepAwake).toBe(true);
    });

    test('Low power writes the preference and reopens checked', () => {
        initSettingsDialog({ app: 'chronometer', notice: false });
        openSettingsDialog();
        flip(switchFor('Low power'), true);
        expect(getPrefs().lowPower).toBe(true);
        closeSettingsDialog();
        openSettingsDialog();
        expect(switchFor('Low power').checked).toBe(true);
    });

    test('another tab\'s change updates an open dialog\'s switch', () => {
        initSettingsDialog({ app: 'chronometer', notice: false });
        openSettingsDialog();
        localStorage.setItem('ec:prefs', JSON.stringify({ lowpower: true, v: 1 }));
        window.dispatchEvent(new StorageEvent('storage', { key: 'ec:prefs', newValue: localStorage.getItem('ec:prefs') }));
        expect(switchFor('Low power').checked).toBe(true);
    });

    test('sections: Observatory pages get General and Observatory, the noon row without its old prefix', () => {
        initSettingsDialog({ app: 'observatory', notice: false, noonOnTop: { get: () => false, set: () => {} } });
        openSettingsDialog();
        expect(sectionTitles()).toEqual(['General', 'Observatory']);
        expect(rowLabels()).toEqual(['Low power', 'Noon at the top of the 24-hour dial']);
        // Each title sits directly over a switch row of its own section.
        for (const title of document.querySelectorAll('.ec-settings-section')) {
            const next = title.nextElementSibling!;
            expect(next.classList.contains('ec-settings-row')).toBe(true);
            expect(next.classList.contains('ec-settings-action')).toBe(false);
        }
        // The Forget row comes after the last section, not inside one.
        const forget = document.querySelector('.ec-settings-action')!;
        expect(forget.previousElementSibling!.classList.contains('ec-settings-row')).toBe(true);
        expect(forget.nextElementSibling).toBeNull();
    });

    test('sections: Chronometer, index and Inspector pages show General only — no noon row, no Chronometer title', () => {
        for (const app of ['chronometer', 'index', 'inspector'] as const) {
            __test__.reset();
            initSettingsDialog({ app, notice: false });
            openSettingsDialog();
            expect(sectionTitles(), app).toEqual(['General']);
            expect(rowLabels(), app).toEqual(['Low power']);
        }
    });

    test('sections: a title is never rendered without a row', () => {
        // Observatory without its live setter: the noon row cannot be built, so
        // the Observatory title is skipped rather than shown bare.
        initSettingsDialog({ app: 'observatory', notice: false });
        openSettingsDialog();
        expect(sectionTitles()).toEqual(['General']);
        __test__.reset();
        // With the Wake Lock API General has two rows and still one title.
        Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: vi.fn() } });
        initSettingsDialog({ app: 'chronometer', notice: false });
        openSettingsDialog();
        expect(sectionTitles()).toEqual(['General']);
        expect(rowLabels()).toEqual(['Keep screen awake', 'Low power']);
    });

    test('on Observatory the noon row goes through the live setter', () => {
        let live = true;
        const set = vi.fn((v: boolean) => { live = v; });
        initSettingsDialog({ app: 'observatory', notice: false, noonOnTop: { get: () => live, set } });
        openSettingsDialog();
        const sw = switchFor('Noon at the top of the 24-hour dial');
        expect(sw.checked).toBe(true);
        flip(sw, false);
        expect(set).toHaveBeenCalledWith(false);
        expect(localStorage.getItem('ec:observatory')).toBeNull();
    });

    test('Forget asks in a modal of its own; Cancel and Esc back out (Esc leaves Settings up); Forget clears ec:* and reloads', () => {
        const reload = vi.fn();
        __test__.setReload(reload);
        localStorage.setItem('ec:shared', '{"lat":1,"v":1}');
        localStorage.setItem('keep', '1');
        initSettingsDialog({ app: 'chronometer', notice: false });
        openSettingsDialog();
        const forget = document.querySelector('.ec-settings-forget') as HTMLElement;
        expect(forget.textContent).toBe('Forget all settings on this device…');
        forget.click();
        const confirm = document.querySelector('.ec-modal.ec-confirm');
        expect(confirm).not.toBeNull();
        expect(__test__.isForgetConfirmOpen()).toBe(true);
        // Its own backdrop, after the dialog's in the DOM (so on top); the dialog stays.
        const backdrops = document.querySelectorAll('.ec-modal-backdrop');
        expect(backdrops.length).toBe(2);
        expect(backdrops[1].contains(confirm)).toBe(true);
        expect(modal()).not.toBeNull();
        expect(confirm!.contains(document.activeElement)).toBe(true);
        (document.querySelector('.ec-settings-forget-cancel') as HTMLElement).click();
        expect(__test__.isForgetConfirmOpen()).toBe(false);
        expect(modal()).not.toBeNull();
        expect(document.activeElement).toBe(forget);
        forget.click();
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(__test__.isForgetConfirmOpen()).toBe(false);
        expect(modal()).not.toBeNull();
        expect(reload).not.toHaveBeenCalled();
        forget.click();
        (document.querySelector('.ec-settings-forget-confirm') as HTMLElement).click();
        expect(Object.keys(localStorage)).toEqual(['keep']);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    test('closing Settings takes an open Forget confirmation with it', () => {
        initSettingsDialog({ app: 'chronometer', notice: false });
        openSettingsDialog();
        (document.querySelector('.ec-settings-forget') as HTMLElement).click();
        expect(closeSettingsDialog()).toBe(true);
        expect(__test__.isForgetConfirmOpen()).toBe(false);
        expect(document.querySelectorAll('.ec-modal-backdrop').length).toBe(0);
    });
});

describe('the notice', () => {
    function notice(): HTMLElement | null { return document.querySelector('.ec-toast.ec-notice'); }

    test('shows until Got it is clicked, which records the acknowledgement', () => {
        initSettingsDialog({ app: 'chronometer' });
        expect(notice()).not.toBeNull();
        expect(notice()!.textContent).not.toContain('Midnight / Noon');
        expect(notice()!.querySelector('.ec-toast-close')).toBeNull();
        (notice()!.querySelector('.ec-toast-btn') as HTMLElement).click();
        expect(notice()).toBeNull();
        expect(isOptionsSeen()).toBe(true);
        __test__.reset();
        initSettingsDialog({ app: 'chronometer' });
        expect(notice()).toBeNull();
    });

    test('Observatory pages add the noon sentence', () => {
        initSettingsDialog({ app: 'observatory' });
        expect(notice()!.textContent).toContain('Midnight / Noon control now lives there too');
    });

    test('is the only first-load toast: a clean load shows none until initSettingsDialog, then one', () => {
        // beforeEach ran initAppState on empty storage (no ec:meta): nothing showed.
        expect(document.querySelectorAll('.ec-toast').length).toBe(0);
        initSettingsDialog({ app: 'chronometer' });
        expect(document.querySelectorAll('.ec-toast').length).toBe(1);
        expect(notice()).not.toBeNull();
    });

    test('names all three apps and carries miniatures of the real ⚙ and ⋮ buttons', () => {
        initSettingsDialog({ app: 'chronometer' });
        const text = notice()!.textContent!;
        expect(text).toContain('Chronometer, Observatory and the Inspector');
        expect(text).toContain('Settings button');
        const minis = [...notice()!.querySelectorAll('.ec-mini-btn')] as HTMLElement[];
        expect(minis.length).toBe(2);
        expect(minis[0].querySelector('svg')!.outerHTML).toBe(document.querySelector('#settings-btn svg')!.outerHTML);
        expect(minis[1].querySelector('svg')!.outerHTML).toBe(document.querySelector('#more-btn svg')!.outerHTML);
        for (const m of minis) expect(m.getAttribute('aria-hidden')).toBe('true');
        // Each wears its button's own colours, read from the live button.
        expect(minis[0].style.backgroundColor).toBe('rgb(1, 2, 3)');
        expect(minis[0].style.color).toBe('rgb(4, 5, 6)');
        expect(minis[1].style.backgroundColor).toBe('rgb(7, 8, 9)');
        expect(minis[1].style.color).toBe('rgb(10, 11, 12)');
        // The words carry the meaning: the sentence reads without the miniatures.
        expect(text).toMatch(/behind the\s+Settings button at the top right \(on a phone, the first row of the\s+menu\)\./);
    });

    test('without the buttons the miniatures fall back to the characters', () => {
        document.getElementById('settings-btn')!.remove();
        document.getElementById('more-btn')!.remove();
        initSettingsDialog({ app: 'chronometer' });
        const minis = [...notice()!.querySelectorAll('.ec-mini-btn')].map((m) => m.textContent);
        expect(minis).toEqual(['⚙', '⋮']);
    });

    test('yields to a toast already on screen, and goes when another tab acknowledges', () => {
        const other = document.createElement('div');
        other.className = 'ec-toast';
        document.body.appendChild(other);
        initSettingsDialog({ app: 'chronometer' });
        expect(notice()).toBeNull();
        other.remove();
        __test__.reset();
        initSettingsDialog({ app: 'chronometer' });
        expect(notice()).not.toBeNull();
        localStorage.setItem('ec:meta', JSON.stringify({ optionsSeen: true, v: 1 }));
        window.dispatchEvent(new StorageEvent('storage', { key: 'ec:meta', newValue: localStorage.getItem('ec:meta') }));
        expect(notice()).toBeNull();
    });
});

describe('⋮ menu', () => {
    test('Settings is the first row spec and the first built row, and it opens the dialog', () => {
        expect(ROW_SPECS[0]).toMatchObject({ label: 'Settings…', kind: 'click', id: 'settings-btn' });
        initSettingsDialog({ app: 'chronometer', notice: false });
        initOverflowMenu({ app: 'chronometer' });
        document.getElementById('more-btn')!.click();
        const rows = [...document.querySelectorAll('#more-menu .more-row')];
        const labels = rows.map((r) => r.querySelector('.more-label')?.textContent);
        expect(labels).toEqual(['Settings…', 'About & help']);
        expect(document.querySelectorAll('#more-menu .more-sep').length).toBe(1);
        (rows[0] as HTMLElement).click();
        expect(document.getElementById('more-menu')!.hidden).toBe(true);
        expect(modal()).not.toBeNull();
    });

    test('a page without the ⚙ button has no Settings row', () => {
        document.getElementById('settings-btn')!.remove();
        initOverflowMenu({ app: 'chronometer' });
        document.getElementById('more-btn')!.click();
        const rows = [...document.querySelectorAll('#more-menu .more-row')].map((r) => r.querySelector('.more-label')?.textContent);
        expect(rows).toEqual(['About & help']);
    });
});
