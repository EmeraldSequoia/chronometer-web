#!/usr/bin/env node
// Re-render the face / Observatory thumbnails and the Chronometer app icon
// from a running dist server, at 1024×1024.
//
//   node scripts/render-thumbs.mjs <port> [face ...]
//
// Prerequisites (one-time, outside the repo's package.json):
//   npm i playwright          — in any scratch directory; set PW_DIR to it
//   Google Chrome installed   — Playwright drives it via channel:'chrome'
//   ImageMagick (`magick`)    — crop / circular mask / flatten
//   A dist server for the current build: python3 -m http.server <port> --directory dist
//
// What it does, per page: seeds localStorage (`ec:shared` at the Cupertino test
// point with the sim instant frozen — `t` + `dir:0` — and `ec:meta` so no
// location dialog or toast appears), loads <page>.html at a 1200×1200 viewport
// at DPR 2, waits for the first paint cycle, and screenshots the dial canvas
// (~2000 px across). Then:
//   faces        → src/faces/masters/thumb-<face>.png : 1024, transparent outside the dial
//                  + src/faces/thumb-<face>.png : the same at 400 (the file the
//                  generated face modules inline into every bundle — keep it small)
//   observatory  → masters/thumb-observatory.png + thumb-observatory.png: main dial cropped, same mask
//   all-faces    → masters/thumb-all-faces.png + thumb-all-faces.png: 2×2 of Haleakala/Hana/Chandra/Selene
//   mauna-kea    → also src/icon-chronometer.png : the Chronometer app icon — the
//                  ChronometerHD iOS icon framing (upper-left of the Mauna Kea
//                  dial, EoT subdial right of centre, date window at the bottom),
//                  no HD badge, dial flattened onto the page background.
// build.sh copies the 400 thumbs to dist and flattens each master into
// dist/icon-<x>.png (1024 opaque, for the web-app manifest / macOS Dock).
//
// Capture instants (Steve, 2026-10-09): the "standard" 10:10 hands with the
// second hand at 30, an interesting Moon phase, all local to America/Los_Angeles.
// Faces where the time hands are not the most prominent element get their own.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PW_DIR = process.env.PW_DIR;
if (!PW_DIR) { console.error('Set PW_DIR to a directory where `npm i playwright` has been run.'); process.exit(2); }
const { chromium } = createRequire(path.join(PW_DIR, 'package.json'))('playwright');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const FACES_DIR = path.join(ROOT, 'src', 'faces');
const MASTERS_DIR = path.join(FACES_DIR, 'masters');
const THUMB_PX = 400;
// Write the 1024 master and the 400 thumb from one finished 1024 image.
function emitThumb(name, master1024) {
    execFileSync('cp', [master1024, path.join(MASTERS_DIR, name)]);
    execFileSync('magick', [master1024, '-resize', `${THUMB_PX}x${THUMB_PX}`, path.join(FACES_DIR, name)]);
}
const PAGE_BG = 'srgb(26,26,46)';   // #1a1a2e — the face page background

const DEFAULT_T = Date.parse('2026-10-16T10:09:30-07:00');
const INSTANTS = {
    selene: Date.parse('2026-10-28T10:10:00-07:00'),
    vienna: Date.parse('2026-10-09T20:10:00-07:00'),
    basel:  Date.parse('2026-10-09T21:00:30-07:00'),
    milano: Date.parse('2026-10-09T10:10:00-07:00'),
};
const ALL_FACES_QUAD = ['haleakala', 'hana', 'chandra', 'selene'];

const [port, ...only] = process.argv.slice(2);
if (!port) { console.error('usage: render-thumbs.mjs <port> [face ...]'); process.exit(2); }
const faces = only.length ? only : execFileSync('cat', [path.join(ROOT, 'faces.txt')]).toString().trim().split(/\s+/);
const pages = only.length ? only : [...faces, 'observatory'];

const work = mkdtempSync(path.join(tmpdir(), 'thumbs-'));
const magick = (...args) => execFileSync('magick', args, { stdio: 'inherit' });

// Anti-aliased circular mask: drawn at 4× and downsampled.
const MASK = path.join(work, 'mask.png');
magick('-size', '4096x4096', 'xc:black', '-fill', 'white', '-draw', 'circle 2047.5,2047.5 2047.5,24', '-resize', '1024x1024', MASK);

const browser = await chromium.launch({ channel: 'chrome' });
async function shoot(page_, t) {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 1200 }, deviceScaleFactor: 2 });
    await ctx.addInitScript((t) => {
        localStorage.setItem('ec:shared', JSON.stringify({ lat: 37.33182, lon: -122.03118, city: 'Cupertino', tz: 'America/Los_Angeles', lsrc: 'manual', t, dir: 0, v: 1 }));
        localStorage.setItem('ec:meta', JSON.stringify({ optionsSeen: true, v: 1 }));
    }, t);
    const page = await ctx.newPage();
    const logs = [];
    page.on('console', m => logs.push(m.text()));
    page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
    await page.goto(`http://localhost:${port}/${page_}.html`, { waitUntil: 'load' });
    await page.waitForTimeout(8000);
    const shot = path.join(work, `${page_}.png`);
    const canvas = page.locator('.face-cell canvas');
    if (await canvas.count() === 1) await canvas.screenshot({ path: shot });
    else await page.screenshot({ path: shot });
    await ctx.close();
    const errors = logs.filter(l => /error|failed/i.test(l));
    if (errors.length) throw new Error(`${page_}: ${errors.join(' | ')}`);
    return shot;
}

for (const p of pages) {
    const t = INSTANTS[p] ?? DEFAULT_T;
    const shot = await shoot(p, t);
    if (p === 'observatory') {
        // 1200×1200 viewport → main dial centre (600, 720) CSS px, R 404 ("[Observatory] … mainR=404.0").
        // At DPR 2: centre (1200, 1440), crop 1660 square (R 808 + margin).
        const out = path.join(work, 'thumb-observatory-1024.png');
        magick(shot, '-crop', '1660x1660+370+610', '+repage', '-resize', '1024x1024', MASK, '-alpha', 'off', '-compose', 'CopyOpacity', '-composite', out);
        emitThumb('thumb-observatory.png', out);
    } else {
        const out = path.join(work, `thumb-${p}-1024.png`);
        magick(shot, '-resize', '1024x1024', MASK, '-alpha', 'off', '-compose', 'CopyOpacity', '-composite', out);
        emitThumb(`thumb-${p}.png`, out);
    }
    if (p === 'mauna-kea') {
        // Chronometer icon: mask the full-res dial, then take the HD-icon framing —
        // a window 0.76 of the dial square whose origin sits at (-0.10, -0.14) of
        // it — on the page background.
        const W = Number(execFileSync('magick', ['identify', '-format', '%w', shot]).toString());
        const fullMask = path.join(work, 'mask-full.png');
        magick('-size', `${W * 4}x${W * 4}`, 'xc:black', '-fill', 'white', '-draw', `circle ${W * 2 - 0.5},${W * 2 - 0.5} ${W * 2 - 0.5},2`, '-resize', `${W}x${W}`, fullMask);
        const masked = path.join(work, 'mk-masked.png');
        magick(shot, fullMask, '-alpha', 'off', '-compose', 'CopyOpacity', '-composite', masked);
        const side = Math.round(0.76 * W), ox = Math.round(-0.10 * W), oy = Math.round(-0.14 * W);
        magick(masked, '-background', PAGE_BG, '-gravity', 'northwest', '-extent', `${side}x${side}${ox}${oy}`, '-alpha', 'off', '-resize', '1024x1024', path.join(ROOT, 'src', 'icon-chronometer.png'));
    }
    console.log(`  → ${p} @ ${new Date(t).toISOString()}`);
}
await browser.close();

if (ALL_FACES_QUAD.every(f => pages.includes(f))) {
    const q = ALL_FACES_QUAD.map(f => path.join(MASTERS_DIR, `thumb-${f}.png`));
    const args = ['-size', '1024x1024', 'xc:none'];
    const at = ['+0+0', '+524+0', '+0+524', '+524+524'];
    q.forEach((f, i) => args.push('(', f, '-resize', '500x500', ')', '-geometry', at[i], '-composite'));
    const out = path.join(work, 'thumb-all-faces-1024.png');
    magick(...args, out);
    emitThumb('thumb-all-faces.png', out);
    console.log('  → all-faces');
}
console.log(`scratch: ${work}`);
