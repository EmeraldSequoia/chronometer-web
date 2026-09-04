/**
 * Pick Page — face selection and reordering logic.
 *
 * Handles:
 *  - Rendering face thumbnails in a selectable grid
 *  - Toggle selection with numbered badges
 *  - All / None / Reorder / Done header buttons
 *  - Bottom sheet for drag-to-reorder
 *  - URL state: reads/writes `picks` param, preserves other params
 */

// ============================================================================
// Face registry
// ============================================================================

import { FACES } from './faces/generated/faces-list.js';
import { updateDynamicCompositeIcon } from './shared/composite-icon.js';
import { initAppState, getState, setState } from './shared/app-state.js';
import { markChronometerPage, registerAppNavHotkeys } from './shared/app-nav.js';

initAppState({ app: 'pick' });

// Cross-app navigation hotkeys (i/o/c/a) only — the pick page has no header
// app icons, time controller, or help popup. Key table: help.html#hotkeys.
markChronometerPage();
registerAppNavHotkeys();

const faceByAbbrev = new Map(FACES.map(f => [f.abbrev, f]));

// ============================================================================
// State
// ============================================================================

/** Ordered list of selected face abbreviations. */
let selectedOrder: string[] = [];

// ============================================================================
// DOM elements
// ============================================================================

const pickGrid = document.getElementById('pick-grid')!;
const btnAll = document.getElementById('btn-all') as HTMLButtonElement;
const btnNone = document.getElementById('btn-none') as HTMLButtonElement;
const btnReorder = document.getElementById('btn-reorder') as HTMLButtonElement;
const btnDone = document.getElementById('btn-done') as HTMLButtonElement;
const sheetBackdrop = document.getElementById('sheet-backdrop')!;
const sheetPanel = document.getElementById('sheet-panel')!;
const sheetList = document.getElementById('sheet-list')!;
const sheetDone = document.getElementById('sheet-done')!;
const homeLink = document.getElementById('pick-home-link') as HTMLAnchorElement;

// ============================================================================
// URL helpers
// ============================================================================

/** Parse the current picks (concatenated 2-letter codes) from app state. */
function readPicks(): string[] {
    const param = getState().picks;
    if (!param || param.length < 2) return [];
    const result: string[] = [];
    for (let i = 0; i + 1 < param.length; i += 2) {
        const abbrev = param.substring(i, i + 2);
        if (faceByAbbrev.has(abbrev)) {
            result.push(abbrev);
        }
    }
    return result;
}

/** Update the home link to preserve query params. */
function updateHomeLink(): void {
    const url = new URL('index.html', window.location.href);
    url.search = window.location.search;
    homeLink.href = url.toString();
}

// ============================================================================
// Grid rendering
// ============================================================================

/** Map of abbrev → card element for quick updates. */
const cardElements = new Map<string, HTMLElement>();

function buildGrid(): void {
    pickGrid.innerHTML = '';
    for (const face of FACES) {
        const card = document.createElement('div');
        card.className = 'pick-card';
        card.dataset.abbrev = face.abbrev;

        const img = document.createElement('img');
        img.className = 'pick-thumb';
        img.src = face.thumb;
        img.alt = face.name;
        img.loading = 'lazy';

        const badge = document.createElement('span');
        badge.className = 'pick-badge';

        const name = document.createElement('p');
        name.className = 'pick-name';
        name.textContent = face.name;

        card.appendChild(img);
        card.appendChild(badge);
        card.appendChild(name);

        card.addEventListener('click', () => toggleFace(face.abbrev));

        pickGrid.appendChild(card);
        cardElements.set(face.abbrev, card);
    }
}

// ============================================================================
// Selection logic
// ============================================================================

function toggleFace(abbrev: string): void {
    const idx = selectedOrder.indexOf(abbrev);
    if (idx >= 0) {
        selectedOrder.splice(idx, 1);
    } else {
        selectedOrder.push(abbrev);
    }
    updateUI();
}



function selectAll(): void {
    selectedOrder = FACES.map(f => f.abbrev);
    updateUI();
}

function selectNone(): void {
    selectedOrder = [];
    updateUI();
}

// ============================================================================
// UI updates
// ============================================================================

function updateUI(): void {
    // Update grid cards
    for (const [abbrev, card] of cardElements) {
        const idx = selectedOrder.indexOf(abbrev);
        if (idx >= 0) {
            card.classList.add('selected');
            const badge = card.querySelector('.pick-badge') as HTMLElement;
            badge.textContent = String(idx + 1);
        } else {
            card.classList.remove('selected');
        }
    }

    // Update header buttons
    const count = selectedOrder.length;
    btnReorder.disabled = count < 2;
    btnDone.disabled = count === 0;

    // Update dynamic apple-touch-icon and favicon
    const thumbs = selectedOrder
        .map(abbrev => faceByAbbrev.get(abbrev)?.thumbDataUrl)
        .filter((thumb): thumb is string => thumb !== undefined);
    const bezelColors = selectedOrder
        .map(abbrev => faceByAbbrev.get(abbrev)?.bezelColor)
        .filter((color): color is string => !!color);
    updateDynamicCompositeIcon(thumbs, bezelColors);
}

/** Reorder grid DOM: selected faces first (in selectedOrder), then unselected (in original order). */
function reorderGrid(): void {
    // Selected faces in their current order
    for (const abbrev of selectedOrder) {
        const card = cardElements.get(abbrev);
        if (card) pickGrid.appendChild(card);
    }
    // Unselected faces in original FACES order
    for (const face of FACES) {
        if (!selectedOrder.includes(face.abbrev)) {
            const card = cardElements.get(face.abbrev);
            if (card) pickGrid.appendChild(card);
        }
    }
}

// ============================================================================
// Bottom sheet
// ============================================================================

let sheetOpenTime = 0;  // Timestamp when sheet was opened, to debounce backdrop clicks

function openSheet(): void {
    if (selectedOrder.length < 2) return;
    renderSheet();
    sheetBackdrop.classList.add('visible');
    sheetOpenTime = Date.now();
    // Double-rAF ensures the browser has committed the backdrop layout
    // before starting the slide-up transition on the panel.
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            sheetPanel.classList.add('visible');
        });
    });
}

function closeSheet(): void {
    sheetPanel.classList.remove('visible');
    setTimeout(() => {
        sheetBackdrop.classList.remove('visible');
    }, 300);
}

function renderSheet(): void {
    sheetList.innerHTML = '';
    for (const abbrev of selectedOrder) {
        const face = faceByAbbrev.get(abbrev);
        if (!face) continue;

        const item = document.createElement('div');
        item.className = 'sheet-item';
        item.dataset.abbrev = abbrev;

        const img = document.createElement('img');
        img.src = face.thumb;
        img.alt = face.name;

        const name = document.createElement('span');
        name.className = 'sheet-name';
        name.textContent = face.name;

        const handle = document.createElement('span');
        handle.className = 'sheet-handle';
        handle.textContent = '≡';
        handle.title = 'Drag to reorder';

        item.appendChild(img);
        item.appendChild(name);
        item.appendChild(handle);

        sheetList.appendChild(item);
    }

    setupDragReorder();
}

// ============================================================================
// Drag-to-reorder
// ============================================================================

function setupDragReorder(): void {
    const handles = sheetList.querySelectorAll('.sheet-handle');
    handles.forEach(handle => {
        handle.addEventListener('touchstart', onDragStart as EventListener, { passive: false });
        handle.addEventListener('mousedown', onDragStart as EventListener);
    });
}

let dragItem: HTMLElement | null = null;
let dragStartY = 0;
let dragOffsetY = 0;
let dragInitialIndex = -1;

function getItemIndex(item: HTMLElement): number {
    const items = Array.from(sheetList.querySelectorAll('.sheet-item'));
    return items.indexOf(item);
}

function onDragStart(e: MouseEvent | TouchEvent): void {
    e.preventDefault();
    const handle = (e.target as HTMLElement).closest('.sheet-handle');
    if (!handle) return;

    dragItem = handle.closest('.sheet-item') as HTMLElement;
    if (!dragItem) return;

    dragItem.classList.add('dragging');
    dragInitialIndex = getItemIndex(dragItem);

    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const rect = dragItem.getBoundingClientRect();
    dragStartY = clientY;
    dragOffsetY = clientY - rect.top;

    document.addEventListener('touchmove', onDragMove as EventListener, { passive: false });
    document.addEventListener('mousemove', onDragMove as EventListener);
    document.addEventListener('touchend', onDragEnd as EventListener);
    document.addEventListener('mouseup', onDragEnd as EventListener);
}

function onDragMove(e: MouseEvent | TouchEvent): void {
    if (!dragItem) return;
    e.preventDefault();

    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const items = Array.from(sheetList.querySelectorAll('.sheet-item')) as HTMLElement[];
    const currentIndex = items.indexOf(dragItem);

    // Check if we need to swap with neighboring items
    for (let i = 0; i < items.length; i++) {
        if (i === currentIndex) continue;
        const rect = items[i].getBoundingClientRect();
        const midY = rect.top + rect.height / 2;

        if (i < currentIndex && clientY < midY) {
            // Move up
            sheetList.insertBefore(dragItem, items[i]);
            syncOrderFromSheet();
            break;
        } else if (i > currentIndex && clientY > midY) {
            // Move down
            if (items[i].nextSibling) {
                sheetList.insertBefore(dragItem, items[i].nextSibling);
            } else {
                sheetList.appendChild(dragItem);
            }
            syncOrderFromSheet();
            break;
        }
    }
}

function onDragEnd(): void {
    if (dragItem) {
        dragItem.classList.remove('dragging');
        dragItem = null;
    }

    document.removeEventListener('touchmove', onDragMove as EventListener);
    document.removeEventListener('mousemove', onDragMove as EventListener);
    document.removeEventListener('touchend', onDragEnd as EventListener);
    document.removeEventListener('mouseup', onDragEnd as EventListener);

    syncOrderFromSheet();
    updateUI();
}

/** Sync selectedOrder from the current DOM order of sheet items. */
function syncOrderFromSheet(): void {
    const items = sheetList.querySelectorAll('.sheet-item');
    selectedOrder = Array.from(items)
        .map(item => (item as HTMLElement).dataset.abbrev!)
        .filter(abbrev => abbrev != null);
}

// ============================================================================
// Event handlers
// ============================================================================

btnAll.addEventListener('click', selectAll);
btnNone.addEventListener('click', selectNone);
btnReorder.addEventListener('click', openSheet);
btnDone.addEventListener('click', navigateDone);


sheetBackdrop.addEventListener('click', () => {
    // Ignore clicks within 300ms of opening — prevents the same click from closing
    if (Date.now() - sheetOpenTime < 300) return;
    closeSheet();
});

sheetDone.addEventListener('click', () => {
    closeSheet();
    reorderGrid();
    updateUI();
});

function navigateDone(): void {
    if (selectedOrder.length === 0) return;
    // Persist picks via app-state. In storage mode this writes to localStorage
    // and leaves the URL clean; in URL-fallback mode it writes the `picks` param
    // onto the current URL. Either way, carrying window.location.search to
    // selected.html does the right thing.
    setState({ picks: selectedOrder.join('') });
    window.location.href = 'selected.html' + window.location.search;
}

// Escape key: close sheet if open, otherwise trigger Done
document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
        if (sheetPanel.classList.contains('visible')) {
            closeSheet();
        } else {
            navigateDone();
        }
    }
});

// ============================================================================
// Init
// ============================================================================

(function init() {
    // Restore the current selection from app state (storage or URL).
    selectedOrder = readPicks();

    // Build grid and update UI
    buildGrid();
    if (selectedOrder.length > 0) {
        reorderGrid();
    }
    updateUI();
    updateHomeLink();
})();
