// P4-T15b checks (D-P4-11; design §2.4, §8.1, §8.3), shared by the workspace sweep and the P6-T10a sign-in surfaces: text-spacing
// overrides, 320 CSS px reflow and 200% text, per screen: no page or scrollport overflow, no clipped text, no overlapping
// controls, every Tab stop with its focus ring 4 px clear of clipping ancestors and sticky bars. Geometry is evidence, not
// certification: screenshots (XAIBO_SHOT) get a human look.
import type { ElectronApplication, Page } from '@playwright/test';
import { expect } from './fixtures.ts';

export type Theme = 'light' | 'dark';
export type Mode = 'normal' | 'reflow' | 'text200';
/** §2.4: line height 1.5× font size, paragraph spacing 2×, letter spacing 0.12em, word spacing 0.16em, together. */
export const SPACING = ['* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }', 'p { margin-bottom: 2em !important; }'];

/** Adds rules to the app's own same-origin stylesheet through the CSSOM (§2.4; the CSP allows no inline style). */
export async function addRules(page: Page, rules: string[]) {
  await page.evaluate((rs) => {
    const sheet = [...document.styleSheets].find((x) => { try { return x.cssRules.length >= 0; } catch { return false; } })!;
    for (const r of rs) sheet.insertRule(r, sheet.cssRules.length);
  }, rules);
}

/** Layout problems on the current screen: page or scrollport overflow, clipped text, overlapping visible controls. */
export async function layoutProblems(page: Page, where: string): Promise<string[]> {
  return page.evaluate((where) => {
    const out: string[] = [];
    const desc = (e: Element) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${typeof e.className === 'string' && e.className ? `.${e.className.trim().split(/\s+/).join('.')}` : ''}`;
    const hidden = (e: Element) => !!e.closest('[inert], [hidden], .x-sr-only, svg') || getComputedStyle(e).visibility === 'hidden';
    // a labelled, keyboard-focusable scroll region (the monthly usage tables) scrolls on purpose: two-dimensional data is
    // the WCAG 1.4.10 reflow exception; its contents still count (P6-T10a closing check)
    const scrollRegion = (e: Element) => e.getAttribute('role') === 'region' && e.getAttribute('tabindex') === '0' && !!e.getAttribute('aria-label');
    const clipRect = (e: Element) => { // the part of e not clipped by its scrollports and the window
      let r = e.getBoundingClientRect();
      let { left, top, right, bottom } = r;
      for (let a = e.parentElement; a; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
        r = a.getBoundingClientRect();
        left = Math.max(left, r.left); top = Math.max(top, r.top); right = Math.min(right, r.right); bottom = Math.min(bottom, r.bottom);
      }
      return { left: Math.max(left, 0), top: Math.max(top, 0), right: Math.min(right, innerWidth), bottom: Math.min(bottom, innerHeight) };
    };
    const d = document.documentElement;
    if (d.scrollWidth > d.clientWidth + 1) out.push(`${where}: the page scrolls horizontally (${d.scrollWidth} > ${d.clientWidth})`);
    for (const e of document.querySelectorAll('body *')) {
      if (hidden(e)) continue;
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const s = getComputedStyle(e);
      if (s.overflowX !== 'visible' && !scrollRegion(e) && e.scrollWidth > e.clientWidth + 1) out.push(`${where}: horizontal overflow in ${desc(e)} (${e.scrollWidth} > ${e.clientWidth})`);
      if ((s.overflowY === 'hidden' || s.overflowY === 'clip') && e.scrollHeight > e.clientHeight + 1) out.push(`${where}: text clipped vertically in ${desc(e)}`);
    }
    const ctrls = [...document.querySelectorAll('button, a[href], input, select, summary')].filter((e) => !hidden(e)).map((e) => ({ e, c: clipRect(e) }))
      .filter((x) => x.c.right - x.c.left > 1 && x.c.bottom - x.c.top > 1)
      .filter((x) => { const h = document.elementFromPoint((x.c.left + x.c.right) / 2, (x.c.top + x.c.bottom) / 2); return !!h && (x.e === h || x.e.contains(h)); });
    for (let i = 0; i < ctrls.length; i++) {
      for (let j = i + 1; j < ctrls.length; j++) {
        const a = ctrls[i]!, b = ctrls[j]!;
        if (a.e.contains(b.e) || b.e.contains(a.e)) continue;
        // content scrolled under a sticky or fixed bar is by design, not an overlap
        const pinned = (e: Element) => { for (let x: Element | null = e; x; x = x.parentElement) if (['sticky', 'fixed'].includes(getComputedStyle(x).position)) return true; return false; };
        if (pinned(a.e) !== pinned(b.e)) continue;
        const w = Math.min(a.c.right, b.c.right) - Math.max(a.c.left, b.c.left);
        const h = Math.min(a.c.bottom, b.c.bottom) - Math.max(a.c.top, b.c.top);
        if (w > 1 && h > 1) out.push(`${where}: ${desc(a.e)} "${a.e.textContent?.trim().slice(0, 30)}" overlaps ${desc(b.e)} "${b.e.textContent?.trim().slice(0, 30)}"`);
      }
    }
    return out;
  }, where);
}

/** Walks Tab from the current focus (at most `max` stops): each stop's ring-bearing box plus 4 px must sit inside every
 *  clipping ancestor and the window, and no sticky or fixed bar outside it may cover it (§2.3). */
export async function focusProblems(page: Page, where: string, max = 60): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  let first: string | null = null;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const r = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { key: 'body', problem: null as string | null };
      const desc = (e: Element) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${typeof e.className === 'string' && e.className ? `.${e.className.trim().split(/\s+/).join('.')}` : ''}`;
      const ring = getComputedStyle(el).outlineStyle !== 'none' ? el : (el.firstElementChild ?? el);
      const rs = getComputedStyle(ring);
      const grow = Math.max(0, parseFloat(rs.outlineWidth) + parseFloat(rs.outlineOffset)); // an inset ring needs no outside room
      const b = ring.getBoundingClientRect();
      const need = { left: b.left - grow, top: b.top - grow, right: b.right + grow, bottom: b.bottom + grow };
      const key = `${desc(el)}|${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40)}`;
      // a control larger than its clipping box in one dimension cannot show its whole ring there; that dimension is skipped
      const outside = (c: { left: number; top: number; right: number; bottom: number }) =>
        (need.right - need.left <= c.right - c.left && (need.left < c.left || need.right > c.right))
        || (need.bottom - need.top <= c.bottom - c.top && (need.top < c.top || need.bottom > c.bottom));
      // XAIBO-PROD-509: the same skip for the window when a clipping ancestor is already smaller than the ring box in that
      // dimension (a record taller than its list scroller at 200 % text): the ring is cut there whatever the window shows
      const clips: DOMRect[] = [];
      for (let a = ring.parentElement; a; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.overflowX !== 'visible' || s.overflowY !== 'visible') clips.push(a.getBoundingClientRect());
      }
      // XAIBO-PROD-525: the same for a record taller than the window below the sticky top band (frame-pad scroll padding
      // and 8 px scroll margin above, 8 px below): no scroll position shows its whole ring (a 466 px row at 200 % text
      // under a wrapped navigation band). The leading rail (>= 1200 px) is not a top band.
      const band = document.querySelector('.x-frame')!.getBoundingClientRect();
      const under = band.width >= innerWidth - 1 ? innerHeight - band.bottom - 16 : innerHeight;
      const tooWide = clips.some((c) => need.right - need.left > c.width), tooTall = need.bottom - need.top > under || clips.some((c) => need.bottom - need.top > c.height);
      const win = { left: tooWide ? need.left : 0, top: tooTall ? need.top : 0, right: tooWide ? need.right : innerWidth, bottom: tooTall ? need.bottom : innerHeight };
      if (outside(win)) return { key, problem: `${key}: focus ring within 4 px of the window edge` };
      // review M1: in a skipped dimension the control must still be in view (overlap the window and every clipping box)
      const vis = clips.reduce((v, c) => ({ left: Math.max(v.left, c.left), top: Math.max(v.top, c.top), right: Math.min(v.right, c.right), bottom: Math.min(v.bottom, c.bottom) }),
        { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
      if ((tooTall && (need.bottom <= vis.top || need.top >= vis.bottom)) || (tooWide && (need.right <= vis.left || need.left >= vis.right))) {
        return { key, problem: `${key}: focused control out of view` };
      }
      for (let a = ring.parentElement; a; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
        // a skipped dimension is skipped for a clipping box only when the ring cannot fit in its part visible below the top
        // band either (re-review LOW-1: a box with room still catches a cut ring, e.g. lost scroll padding)
        const c = a.getBoundingClientRect();
        const room = Math.min(c.bottom, innerHeight) - Math.max(c.top, band.width >= innerWidth - 1 ? band.bottom + 8 : 0);
        const skipY = tooTall && need.bottom - need.top > room;
        if (outside({ left: tooWide ? need.left : c.left, right: tooWide ? need.right : c.right, top: skipY ? need.top : c.top, bottom: skipY ? need.bottom : c.bottom })) {
          return { key, problem: `${key}: focus ring clipped by ${desc(a)}` };
        }
      }
      // covered: something else is drawn over the control itself (an outline cannot be hit-tested, its box can)
      const box = el.getBoundingClientRect();
      const ix = Math.min(12, box.width / 4), iy = Math.min(12, box.height / 4); // inside rounded corners
      // centre and top-left only: the right edge of a scroller holds the macOS overlay scrollbar, which hit-tests as the scroller
      for (const [x, y] of [[(box.left + box.right) / 2, (box.top + box.bottom) / 2], [box.left + ix, box.top + iy]] as [number, number][]) {
        const h = document.elementFromPoint(x, y);
        if (h && h !== el && !el.contains(h)) return { key, problem: `${key}: covered by ${desc(h)}` };
      }
      return { key, problem: null };
    });
    if (r.key === first) break; // back at the start of the cycle (review M: not at the first repeated name)
    first ??= r.key;
    if (seen.has(r.key)) continue; // a same-named control already checked
    seen.add(r.key);
    if (r.problem) out.push(`${where}: ${r.problem}`);
  }
  return out;
}

export async function setTheme(app: ElectronApplication, page: Page, theme: Theme) {
  await page.emulateMedia({ colorScheme: null }); // no Playwright override: the OS appearance (nativeTheme) decides
  await app.evaluate(({ nativeTheme }, t) => { nativeTheme.themeSource = t; }, theme);
  await expect.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(theme === 'dark');
}
