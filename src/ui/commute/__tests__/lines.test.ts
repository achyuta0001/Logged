// @ts-nocheck -- node:test types are not part of the browser tsconfig
// Plain-language lines from the plan: the update banner.
// Run: node --test src/ui/commute/__tests__/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateLine, windowText } from '../lines.ts';

const H = 3600e3;
const IST = 5.5 * H;
/** ms epoch of an IST wall-clock time */
const ist = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - IST;
const NAMES = { silk: 'Silk Board Junction', hebbal: 'Hebbal Flyover' };
const nameOf = (id) => NAMES[id] ?? id;

test('windowText: the last half hour is included', () => {
  assert.equal(windowText([ist(2026, 10, 20, 9, 0), ist(2026, 10, 20, 9, 30)]), '09:00–10:00');
});

test('updateLine: the new advice, and the hotspot behind it with its window', () => {
  const w = { silk: [ist(2026, 10, 20, 9, 0), ist(2026, 10, 20, 9, 30)] };
  assert.equal(updateLine('Leave by 08:15', { drivers: ['silk', 'hebbal'] }, nameOf, (id) => w[id]), 'Update: now Leave by 08:15 — Silk Board Junction likely waterlogged 09:00–10:00');
  assert.equal(updateLine('Go — no waterlogging expected', { drivers: [] }, nameOf, (id) => w[id]), 'Update: now Go — no waterlogging expected');
  assert.equal(updateLine('Go, but watch for water', { drivers: ['hebbal'] }, nameOf, (id) => w[id] ?? null), 'Update: now Go, but watch for water', 'no window, no detail');
});
