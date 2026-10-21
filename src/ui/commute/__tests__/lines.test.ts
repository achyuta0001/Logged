// @ts-nocheck -- node:test types are not part of the browser tsconfig
// Plain-language lines from the plan: the update banner, the reason under each route card and the share card's text.
// Run: node --test src/ui/commute/__tests__/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardEnd, cardFile, cardSpots, cardWhen, checkedText, fmtKm, fmtMin, placeName, routeReason, updateLine, windowText } from '../lines.ts';

const H = 3600e3;
const IST = 5.5 * H;
/** ms epoch of an IST wall-clock time */
const ist = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - IST;
const NAMES = { silk: 'Silk Board Junction', hebbal: 'Hebbal Flyover', kr: 'KR Puram Bridge', ecity: 'Electronic City Flyover' };
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

test('fmtMin and fmtKm: as the route cards show them', () => {
  assert.equal(fmtMin(32 * 60 + 20), '32 min');
  assert.equal(fmtMin(10), '1 min');
  assert.equal(fmtMin(65 * 60), '1 h 05');
  assert.equal(fmtKm(14230), '14 km');
  assert.equal(fmtKm(8460), '8.5 km');
});

/** routes A/B/C taking these many minutes */
const routes = (...min) => min.map((m, i) => ({ id: 'ABC'[i], durationS: m * 60 }));
/** a route's risk: [hotspot id, level] in travel order; the route takes the worst */
const risk = (route, ...hits) => {
  const order = ['clear', 'watch', 'likely', 'severe'];
  const level = hits.reduce((w, [, l]) => (order.indexOf(l) > order.indexOf(w) ? l : w), 'clear');
  return { route, level, hits: hits.map(([id, l], i) => ({ id, level: l, atS: 600 * (i + 1), distanceM: 3000 * (i + 1) })) };
};

test('routeReason: the fastest says what it meets', () => {
  const rs = routes(32, 36);
  assert.equal(routeReason('A', rs, [risk('A', ['silk', 'watch'], ['hebbal', 'watch']), risk('B')], nameOf), 'Fastest · passes 2 watch spots');
  assert.equal(routeReason('A', rs, [risk('A', ['silk', 'watch']), risk('B')], nameOf), 'Fastest · passes 1 watch spot');
  assert.equal(routeReason('A', rs, [risk('A', ['hebbal', 'watch'], ['silk', 'likely']), risk('B')], nameOf), 'Fastest · Silk Board Junction likely waterlogged', 'the worst spot is named, not the first');
  assert.equal(routeReason('A', rs, [risk('A', ['silk', 'likely'], ['kr', 'severe'], ['hebbal', 'watch']), risk('B')], nameOf), 'Fastest · 2 spots likely waterlogged', 'several: a count, to compare across cards');
  assert.equal(routeReason('A', rs, [risk('A', ['silk', 'clear']), risk('B')], nameOf), 'Fastest · no waterlogging expected');
  assert.equal(routeReason('A', routes(32), [risk('A', ['silk', 'watch'])], nameOf), 'Only route found · passes 1 watch spot');
});

test('routeReason: another route names what it avoids on the fastest, and what it costs', () => {
  const rs = routes(32, 36, 41);
  const risks = [risk('A', ['silk', 'likely'], ['hebbal', 'watch']), risk('B', ['hebbal', 'watch']), risk('C')];
  assert.equal(routeReason('B', rs, risks, nameOf), 'Avoids Silk Board Junction · 4 min longer');
  assert.equal(routeReason('C', rs, risks, nameOf), 'Avoids Silk Board Junction and 1 more · 9 min longer');
  // B only passes the same water later: nothing is avoided, so it says what it meets
  assert.equal(routeReason('B', rs, [risk('A', ['silk', 'likely']), risk('B', ['silk', 'watch']), risk('C')], nameOf), 'Passes 1 watch spot · 4 min longer');
});

test('routeReason: no "avoids" when the other route is no less risky, or likely waterlogged itself', () => {
  const rs = routes(32, 38);
  assert.equal(routeReason('B', rs, [risk('A', ['silk', 'likely']), risk('B', ['kr', 'likely'])], nameOf), 'KR Puram Bridge likely waterlogged · 6 min longer');
  assert.equal(routeReason('B', rs, [risk('A', ['silk', 'severe'], ['hebbal', 'likely']), risk('B', ['kr', 'likely'])], nameOf), 'KR Puram Bridge likely waterlogged · 6 min longer', 'less risky, but still likely waterlogged');
  assert.equal(routeReason('B', rs, [risk('A', ['silk', 'watch']), risk('B', ['ecity', 'watch'])], nameOf), 'Passes 1 watch spot · 6 min longer');
  assert.equal(routeReason('B', rs, [risk('A'), risk('B')], nameOf), 'No waterlogging expected · 6 min longer');
});

test('routeReason: time in the whole minutes the cards show', () => {
  assert.equal(routeReason('B', routes(32.2, 32.4), [risk('A'), risk('B')], nameOf), 'No waterlogging expected · about as fast');
  assert.equal(routeReason('B', routes(50, 115), [risk('A', ['silk', 'severe']), risk('B')], nameOf), 'Avoids Silk Board Junction · 1 h 05 longer');
  assert.equal(routeReason('A', routes(40, 32), [risk('A'), risk('B')], nameOf), 'No waterlogging expected · 8 min longer', 'the fastest need not be A');
  assert.equal(routeReason('B', routes(40, 32), [risk('A'), risk('B')], nameOf), 'Fastest · no waterlogging expected');
});

test('routeReason: no forecast for the trip yet leaves the water out', () => {
  const rs = routes(32, 36);
  const risks = [risk('A', ['silk', 'clear']), risk('B')];
  assert.equal(routeReason('A', rs, risks, nameOf, false), 'Fastest');
  assert.equal(routeReason('B', rs, risks, nameOf, false), '4 min longer');
  assert.equal(routeReason('B', routes(32, 32), risks, nameOf, false), 'About as fast');
  assert.equal(routeReason('A', routes(32), risks, nameOf, false), 'Only route found');
  assert.equal(routeReason('C', rs, risks, nameOf), '', 'an unknown route has no line');
});

test('placeName: the card names places, never coordinates', () => {
  assert.equal(placeName('Near Indiranagar', 'Home'), 'Indiranagar');
  assert.equal(placeName('My location · Koramangala', 'Home'), 'Koramangala');
  assert.equal(placeName('Bellandur & ORR', 'Office'), 'Bellandur & ORR');
  assert.equal(placeName('12.9719, 77.6412', 'Home'), 'Home', 'a picked point stays private');
  assert.equal(placeName('', 'Office'), 'Office');
});

test('cardEnd: home and office by their places, a saved place by its own name, never coordinates', () => {
  assert.equal(cardEnd({ id: 'home', label: 'Near Indiranagar' }), 'Indiranagar');
  assert.equal(cardEnd({ id: 'office', label: '12.926, 77.678' }), 'Office');
  assert.equal(cardEnd({ id: 'home', label: '12.9719, 77.6412' }), 'Home');
  assert.equal(cardEnd({ id: 'p1', label: 'Gym' }), 'Gym', 'its name, not where it is');
  assert.equal(cardEnd({ id: 'p2', label: 'Near the lake' }), 'Near the lake', 'a name is kept as written');
  assert.equal(cardEnd({ id: 'p3', label: '12.9352, 77.6271' }), 'Place');
  assert.equal(cardEnd({ id: 'p4', label: ' ' }), 'Place');
});

test('card dates: the IST day, written out, as the picture is read later', () => {
  assert.equal(cardWhen(ist(2026, 10, 22, 8, 30)), 'Thursday 22 Oct · leaving 08:30');
  assert.equal(cardWhen(ist(2026, 10, 23, 2, 0)), 'Friday 23 Oct · leaving 02:00', 'still the 22nd in UTC');
  assert.equal(checkedText(ist(2026, 10, 21, 18, 5)), 'Checked 18:05, Wed 21 Oct');
  assert.equal(cardFile(ist(2026, 10, 22, 8, 30)), 'commute-2026-10-22-0830.png');
  assert.equal(cardFile(ist(2026, 10, 23, 2, 0)), 'commute-2026-10-23-0200.png');
});

test('cardSpots: the hotspots behind the advice first, then the rest on the best route', () => {
  const dep = ist(2026, 10, 22, 8, 30);
  const plan = {
    departure: dep,
    drivers: ['silk'],
    routes: [risk('A', ['silk', 'likely'], ['hebbal', 'watch']), risk('B', ['ecity', 'watch'], ['kr', 'severe'])],
  };
  const w = { silk: [ist(2026, 10, 22, 9, 0), ist(2026, 10, 22, 9, 30)], kr: [ist(2026, 10, 22, 8, 30), ist(2026, 10, 22, 9, 0)], ecity: [ist(2026, 10, 22, 11, 0), ist(2026, 10, 22, 11, 0)] };
  assert.deepEqual(cardSpots(plan, 'B', nameOf, (id) => w[id]), [
    { name: 'Silk Board Junction', level: 'likely', when: '09:00–10:00' },
    { name: 'KR Puram Bridge', level: 'severe', when: '08:30–09:30' },
    // a watch spot gives when it is reached (B's first hit, 600 s after leaving), not its later window
    { name: 'Electronic City Flyover', level: 'watch', when: 'around 08:40' },
  ]);
  assert.deepEqual(cardSpots(plan, 'B', nameOf, (id) => w[id], 1).map((s) => s.name), ['Silk Board Junction']);
  assert.deepEqual(cardSpots(plan, 'A', nameOf, () => null).map((s) => [s.name, s.when]), [
    ['Silk Board Junction', 'around 08:40'],
    ['Hebbal Flyover', 'around 08:50'],
  ], 'no window: when it is reached');
  assert.deepEqual(cardSpots({ departure: dep, drivers: [], routes: [risk('A', ['silk', 'clear']), risk('B')] }, 'A', nameOf, () => null), [], 'nothing with water expected');
});
