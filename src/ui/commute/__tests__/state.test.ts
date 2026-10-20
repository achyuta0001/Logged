// @ts-nocheck -- node:test types are not part of the browser tsconfig
// My commute state: sanitising, the share link (?commute&from&to&dep&ret&fromName&toName) and trip legs.
// Run: node --test src/ui/commute/__tests__/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanHHMM, dayWord, DEFAULT_STATE, legs, linkHasTrip, loadState, presetOf, sanitize, shareSearch, stateFromSearch, withoutCommute } from '../state.ts';

const H = 3600e3;
const IST = 5.5 * H;
/** ms epoch of an IST wall-clock time */
const ist = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - IST;

const full = {
  home: { label: 'Indiranagar', coord: [77.6412, 12.9719] },
  office: { label: 'Bellandur & ORR', coord: [77.678, 12.926] },
  dep: '08:30',
  ret: '18:15',
};

test('cleanHHMM pads and rejects', () => {
  assert.equal(cleanHHMM('9:05'), '09:05');
  assert.equal(cleanHHMM(' 18:00 '), '18:00');
  assert.equal(cleanHHMM('24:00'), null);
  assert.equal(cleanHHMM('nine'), null);
  assert.equal(cleanHHMM(null), null);
});

test('presetOf: only the exact Morning / Evening times', () => {
  assert.equal(presetOf('09:00'), 'am');
  assert.equal(presetOf('18:00'), 'pm');
  assert.equal(presetOf('08:30'), null);
});

test('sanitize: garbage falls back to the defaults', () => {
  assert.deepEqual(sanitize(null), DEFAULT_STATE);
  assert.deepEqual(sanitize('x'), DEFAULT_STATE);
  const s = sanitize({ home: { label: '<b>Home</b>\n', coord: [77.6, 12.9] }, office: { coord: [0, 0] }, dep: '7:05', ret: 'later' });
  assert.equal(s.home.label, 'bHome/b');
  assert.deepEqual(s.home.coord, [77.6, 12.9]);
  assert.equal(s.office, null, 'a point far outside Bengaluru is dropped');
  assert.equal(s.dep, '07:05');
  assert.equal(s.ret, null);
  assert.equal(sanitize({ home: { label: '', coord: [77.6, 12.9] } }).home.label, 'Home', 'an empty label gets the default');
  assert.equal(sanitize({ home: { label: 'x'.repeat(200), coord: [77.6, 12.9] } }).home.label.length, 60);
});

test('share link round-trips the whole commute', () => {
  const q = shareSearch('?pin=560034&packs=https://x.org/pins', full);
  const u = new URLSearchParams(q);
  assert.equal(u.get('commute'), '1');
  assert.equal(u.get('pin'), null, 'the commute is its own view');
  assert.equal(u.get('packs'), 'https://x.org/pins', 'other parameters stay');
  assert.equal(u.get('from'), '77.64120,12.97190');
  assert.equal(u.get('to'), '77.67800,12.92600');
  assert.equal(u.get('dep'), '08:30');
  assert.equal(u.get('ret'), '18:15');
  assert.ok(q.includes('from=77.64120,12.97190'), 'coordinates stay readable');
  assert.deepEqual(stateFromSearch(q), full);
  assert.ok(linkHasTrip(q));
});

test('share link: default labels and no return trip are left out', () => {
  const s = { ...full, home: { ...full.home, label: 'Home' }, office: { ...full.office, label: 'Office' }, ret: null };
  const q = shareSearch('', s);
  assert.ok(!q.includes('fromName') && !q.includes('toName') && !q.includes('ret='));
  assert.deepEqual(stateFromSearch(q), s);
});

test('a link with only ?commute opens an empty card; without ?commute there is no commute', () => {
  assert.deepEqual(stateFromSearch('?commute=1'), DEFAULT_STATE);
  assert.equal(linkHasTrip('?commute=1'), false);
  assert.equal(stateFromSearch('?from=77.6,12.9&to=77.7,12.95&dep=08:00'), null, 'the pincode view link alone is not the Commute tab');
  assert.equal(stateFromSearch('?commute=1&dep=19:30&ret=bad').dep, '19:30');
  // half a trip in the link: from without to is ignored rather than guessed
  assert.equal(stateFromSearch('?commute=1&from=77.6,12.9').home, null);
});

test('a partial commute still shares its times', () => {
  const q = shareSearch('', { ...DEFAULT_STATE, home: full.home, dep: '07:45', ret: '17:00' });
  const u = new URLSearchParams(q);
  assert.equal(u.get('from'), null);
  assert.equal(u.get('dep'), '07:45');
  assert.equal(u.get('ret'), '17:00');
});

test('withoutCommute drops every commute parameter and keeps the rest', () => {
  assert.equal(withoutCommute('?commute=1&from=1,2&to=3,4&dep=09:00&ret=18:00&fromName=a&toName=b&packs=p'), '?packs=p');
  assert.equal(withoutCommute('?commute=1'), '');
});

test('loadState without storage (node) gives the defaults', () => {
  assert.deepEqual(loadState(), DEFAULT_STATE);
});

test('legs: the next weekday departures, soonest first', () => {
  const now = ist(2026, 10, 20, 12, 0); // Tuesday noon
  const ls = legs(full, now);
  assert.equal(ls.length, 2);
  assert.equal(ls[0].id, 'back', 'the evening trip home leaves first after noon');
  assert.equal(ls[0].departure, ist(2026, 10, 20, 18, 15));
  assert.equal(ls[0].from.label, 'Bellandur & ORR');
  assert.equal(ls[1].departure, ist(2026, 10, 21, 8, 30));
  assert.deepEqual(legs({ ...full, office: null }, now), []);
  // ten minutes after the usual time it is still today's trip; an hour after, tomorrow's
  assert.equal(legs({ ...full, ret: null }, ist(2026, 10, 20, 8, 40))[0].departure, ist(2026, 10, 20, 8, 30));
  assert.equal(legs({ ...full, ret: null }, ist(2026, 10, 20, 9, 30))[0].departure, ist(2026, 10, 21, 8, 30));
  // Friday evening -> Monday morning
  assert.equal(legs({ ...full, ret: null }, ist(2026, 10, 23, 20, 0))[0].departure, ist(2026, 10, 26, 8, 30));
});

test('dayWord', () => {
  const now = ist(2026, 10, 20, 12, 0);
  assert.equal(dayWord(ist(2026, 10, 20, 18, 0), now), 'today');
  assert.equal(dayWord(ist(2026, 10, 21, 0, 30), now), 'tomorrow');
  assert.equal(dayWord(ist(2026, 10, 23, 9, 0), now), 'Friday');
});
