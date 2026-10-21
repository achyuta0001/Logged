// @ts-nocheck -- node:test types are not part of the browser tsconfig
// My commute state: sanitising, the share link (?commute&from&to&dep&ret&days&fromName&toName), commute days, trip legs,
// and the trip checked between home, office and the saved places (its ends, its own times, what the link carries).
// Run: node --test src/ui/commute/__tests__/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLink, backWords, chooseEnd, cleanDays, cleanHHMM, dayWord, DEFAULT_STATE, endLabel, endOf, leaveWords, legs, linkHasTrip, loadState, nextDayAt, presetOf,
  sanitize, saveState, shareSearch, stateFromSearch, swapEnds, timesOf, toWords, tripKey, tripWords, withoutCommute, withoutPlace, withTimes,
} from '../state.ts';

const H = 3600e3;
const IST = 5.5 * H;
/** ms epoch of an IST wall-clock time */
const ist = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - IST;

const full = {
  home: { label: 'Indiranagar', coord: [77.6412, 12.9719] },
  office: { label: 'Bellandur & ORR', coord: [77.678, 12.926] },
  dep: '08:30',
  ret: '18:15',
  days: '12345',
  places: [],
  from: 'home',
  to: 'office',
  trips: {},
};
const gym = { id: 'p1', label: 'Gym', where: 'Near Koramangala', coord: [77.6271, 12.9352] };
const parents = { id: 'p2', label: 'Parents', where: 'Jayanagar', coord: [77.5838, 12.9299] };
/** the commute with two saved places */
const saved = { ...full, places: [gym, parents] };

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

test('commute days: cleaned, and in the link only when not Monday to Friday', () => {
  assert.equal(cleanDays('5,1,3'), '135');
  assert.equal(cleanDays([7, 6]), '67');
  assert.equal(cleanDays(''), '12345', 'no day at all falls back to Monday to Friday');
  assert.equal(cleanDays('089'), '12345');
  assert.equal(sanitize({ days: 'x' }).days, '12345');
  const q = shareSearch('', { ...full, days: '1357' });
  assert.ok(q.includes('days=1357'));
  assert.equal(stateFromSearch(q).days, '1357');
  assert.equal(new URLSearchParams(shareSearch('', full)).get('days'), null);
  assert.equal(withoutCommute('?commute=1&days=135&packs=p'), '?packs=p');
});

test('nextDayAt: the next commute day at that time, IST', () => {
  const MWF = '135';
  assert.equal(nextDayAt(ist(2026, 10, 20, 12, 0), 9, 0, MWF), ist(2026, 10, 21, 9, 0), 'Tuesday noon -> Wednesday');
  assert.equal(nextDayAt(ist(2026, 10, 19, 8, 0), 9, 0, MWF), ist(2026, 10, 19, 9, 0), 'Monday before the time -> today');
  assert.equal(nextDayAt(ist(2026, 10, 23, 19, 0), 18, 0, '12345'), ist(2026, 10, 26, 18, 0), 'Friday evening -> Monday');
  assert.equal(nextDayAt(ist(2026, 10, 23, 12, 0), 10, 30, '67'), ist(2026, 10, 24, 10, 30), 'weekends only: Friday -> Saturday');
  assert.equal(nextDayAt(ist(2026, 10, 25, 11, 0), 10, 30, '67'), ist(2026, 10, 31, 10, 30), 'Sunday after the time -> next Saturday');
  assert.equal(nextDayAt(ist(2026, 10, 20, 9, 1), 9, 0, '2'), ist(2026, 10, 27, 9, 0), 'Tuesdays only, just missed -> a week later');
  // 23:50 UTC on Monday is already 05:20 on Tuesday in Bengaluru
  assert.equal(nextDayAt(Date.UTC(2026, 9, 19, 23, 50), 9, 0, '2'), ist(2026, 10, 20, 9, 0));
});

test('legs follow the commute days', () => {
  const s = { ...full, ret: null, days: '135' };
  assert.equal(legs(s, ist(2026, 10, 20, 12, 0))[0].departure, ist(2026, 10, 21, 8, 30), 'Tuesday -> Wednesday');
  assert.equal(legs(s, ist(2026, 10, 23, 20, 0))[0].departure, ist(2026, 10, 26, 8, 30), 'Friday evening -> Monday');
  assert.equal(legs({ ...s, days: '123456' }, ist(2026, 10, 23, 20, 0))[0].departure, ist(2026, 10, 24, 8, 30), 'a Saturday commuter goes on Saturday');
  assert.equal(legs({ ...s, days: '1' }, ist(2026, 10, 19, 8, 40))[0].departure, ist(2026, 10, 19, 8, 30), 'still today 10 minutes after the time');
});

test('dayWord', () => {
  const now = ist(2026, 10, 20, 12, 0);
  assert.equal(dayWord(ist(2026, 10, 20, 18, 0), now), 'today');
  assert.equal(dayWord(ist(2026, 10, 21, 0, 30), now), 'tomorrow');
  assert.equal(dayWord(ist(2026, 10, 23, 9, 0), now), 'Friday');
});

// ---------------------------------------------------------------- saved places and the trip checked

test('sanitize: a copy saved before saved places existed is the commute, home -> office', () => {
  const old = { home: full.home, office: full.office, dep: '08:30', ret: '18:15', days: '12345' };
  assert.deepEqual(sanitize(old), full);
  assert.equal(tripKey(old), 'home>office', 'no from / to: the commute');
  assert.equal(legs(old, ist(2026, 10, 20, 12, 0)).length, 2, 'legs work on it as before');
});

test('sanitize: the trip needs two known, different ends; trips need known ends and a time', () => {
  assert.deepEqual([sanitize({ ...saved, from: 'p2', to: 'p1' }).from, sanitize({ ...saved, from: 'p2', to: 'p1' }).to], ['p2', 'p1']);
  const bad = (from, to) => {
    const s = sanitize({ ...saved, from, to });
    return `${s.from}>${s.to}`;
  };
  assert.equal(bad('p9', 'p1'), 'home>p1', 'an unknown start is home');
  assert.equal(bad('home', 'p9'), 'home>office', 'an unknown end is office');
  assert.equal(bad('office', 'p7'), 'home>office', 'office to office (the unknown end) is no trip: the commute');
  assert.equal(bad('p1', 'p1'), 'home>office');
  assert.equal(bad(3, null), 'home>office');
  const s = sanitize({
    ...saved,
    trips: {
      'home>p1': { dep: '6:30', ret: '8:00', days: '135' },
      'p1>p2': { dep: '19:00', ret: 'later' },
      'home>office': { dep: '07:00' },
      'home>p9': { dep: '07:00' },
      'p1>p1': { dep: '07:00' },
      'office>p2': { dep: 'noon' },
      'p2>office': 'x',
      oops: { dep: '07:00' },
    },
  });
  assert.deepEqual(s.trips, { 'home>p1': { dep: '06:30', ret: '08:00', days: '135' }, 'p1>p2': { dep: '19:00', ret: null, days: '12345' } });
});

test('endOf, endLabel: home and office by their places, a saved place by its own name', () => {
  assert.deepEqual(endOf(saved, 'home'), { id: 'home', label: 'Indiranagar', coord: full.home.coord });
  assert.deepEqual(endOf(saved, 'p1'), { id: 'p1', label: 'Gym', coord: gym.coord });
  assert.equal(endOf({ ...saved, home: null }, 'home'), null);
  assert.equal(endOf(saved, 'p9'), null);
  assert.deepEqual(['home', 'office', 'p2', 'p9'].map((id) => endLabel(saved, id)), ['Home', 'Office', 'Parents', '']);
});

test('chooseEnd: picking the place at the other end swaps the two; swapEnds turns the trip round', () => {
  const s = chooseEnd(saved, 'to', 'p1');
  assert.equal(tripKey(s), 'home>p1');
  assert.equal(tripKey(chooseEnd(s, 'from', 'p1')), 'p1>home', 'From: Gym while To is Gym -> To takes Home');
  assert.equal(tripKey(chooseEnd(s, 'to', 'home')), 'p1>home');
  assert.equal(tripKey(chooseEnd(s, 'from', 'p2')), 'p2>p1');
  assert.equal(chooseEnd(s, 'to', 'p1'), s, 'the same place: nothing changes');
  assert.equal(chooseEnd(s, 'to', 'p9'), s, 'an unknown place: nothing changes');
  assert.equal(tripKey(swapEnds(s)), 'p1>home');
  assert.equal(tripKey(swapEnds(swapEnds(s))), 'home>p1');
});

test('timesOf / withTimes: the commute keeps its own times; any other trip gets its own', () => {
  assert.deepEqual(timesOf(saved), { dep: '08:30', ret: '18:15', days: '12345' });
  // home -> gym: not set yet, so the commute's departure and days, one way
  const g = chooseEnd(saved, 'to', 'p1');
  assert.deepEqual(timesOf(g), { dep: '08:30', ret: null, days: '12345' });
  const g2 = withTimes(g, { dep: '06:30', days: '135' });
  assert.deepEqual(g2.trips, { 'home>p1': { dep: '06:30', ret: null, days: '135' } });
  assert.deepEqual([g2.dep, g2.ret, g2.days], ['08:30', '18:15', '12345'], 'the commute is untouched');
  // back to the commute: its own times; to the gym again: the gym's
  const c = chooseEnd(g2, 'to', 'office');
  assert.deepEqual(timesOf(c), { dep: '08:30', ret: '18:15', days: '12345' });
  assert.deepEqual(timesOf(chooseEnd(c, 'to', 'p1')), { dep: '06:30', ret: null, days: '135' });
  // the commute's own times still go in dep / ret / days
  const c2 = withTimes(c, { ret: null });
  assert.equal(c2.ret, null);
  assert.deepEqual(c2.trips, g2.trips);
});

test('timesOf: a reversed round trip starts as the same trip seen from the other end', () => {
  // office -> home with the commute 08:30 there and 18:15 back: leaves the office at 18:15, back at 08:30
  assert.deepEqual(timesOf(swapEnds(saved)), { dep: '18:15', ret: '08:30', days: '12345' });
  // without a way back there is nothing to mirror
  assert.deepEqual(timesOf(swapEnds({ ...saved, ret: null })), { dep: '08:30', ret: null, days: '12345' });
  // once set, the reverse trip keeps its own
  const r = withTimes(swapEnds(saved), { dep: '17:45' });
  assert.deepEqual(r.trips['office>home'], { dep: '17:45', ret: '08:30', days: '12345' });
  assert.deepEqual(timesOf(swapEnds(r)), { dep: '08:30', ret: '18:15', days: '12345' }, 'and the commute its own');
});

test('withoutPlace: an end that goes takes home (office when the other end is home); its trips go', () => {
  const s = withTimes(chooseEnd(saved, 'to', 'p1'), { dep: '06:30' });
  const t = withTimes(chooseEnd(chooseEnd(s, 'from', 'p2'), 'to', 'office'), { dep: '10:00' });
  assert.deepEqual(Object.keys(t.trips), ['home>p1', 'p2>office']);
  const a = withoutPlace(s, 'p1');
  assert.equal(tripKey(a), 'home>office');
  assert.deepEqual(a.places, [parents]);
  assert.deepEqual(a.trips, {});
  assert.equal(tripKey(withoutPlace(swapEnds(s), 'p1')), 'office>home');
  assert.equal(tripKey(withoutPlace(t, 'p2')), 'home>office');
  assert.deepEqual(withoutPlace(t, 'p1').trips, { 'p2>office': t.trips['p2>office'] }, 'the other trips stay');
  assert.equal(tripKey(withoutPlace(chooseEnd(chooseEnd(saved, 'from', 'p1'), 'to', 'p2'), 'p1')), 'home>p2');
  assert.equal(withoutPlace(s, 'p9'), s);
});

test('legs: a trip to a saved place, there and back, at its own times', () => {
  const s = withTimes(chooseEnd(saved, 'to', 'p1'), { dep: '06:30', ret: '08:00' });
  const ls = legs(s, ist(2026, 10, 20, 7, 0)); // Tuesday 07:00
  assert.deepEqual(ls.map((l) => [l.id, l.from.label, l.to.label, l.hhmm]), [
    ['back', 'Gym', 'Indiranagar', '08:00'],
    ['out', 'Indiranagar', 'Gym', '06:30'],
  ]);
  assert.equal(ls[1].departure, ist(2026, 10, 21, 6, 30), 'missed today: tomorrow');
  assert.deepEqual(legs({ ...s, home: null }, ist(2026, 10, 20, 7, 0)), [], 'home not set: no legs');
});

test('tripWords and the leg words name the trip', () => {
  assert.deepEqual(tripWords(saved), { out: 'To office', outAt: 'leave home at', back: 'Back home', backAt: 'leave the office at', days: 'you commute' });
  assert.deepEqual(tripWords(swapEnds(saved)), { out: 'To home', outAt: 'leave the office at', back: 'Back to office', backAt: 'leave home at', days: 'you go' });
  assert.deepEqual(tripWords(chooseEnd(chooseEnd(saved, 'from', 'p2'), 'to', 'p1')), { out: 'To Gym', outAt: 'leave Parents at', back: 'Back to Parents', backAt: 'leave Gym at', days: 'you go' });
  assert.equal(toWords({ id: 'office', label: 'Bellandur' }), 'To office');
  assert.equal(backWords({ id: 'home', label: 'Indiranagar' }), 'Back home');
  assert.equal(leaveWords({ id: 'p1', label: 'Gym' }), 'leave Gym at');
});

test('share link: only the two ends of the trip checked, by name', () => {
  // the commute with saved places: the same link as without them
  assert.equal(shareSearch('', saved), shareSearch('', full));
  // home -> gym at its own time: the gym is in, as "Gym"; the parents are not
  const s = withTimes(chooseEnd(saved, 'to', 'p1'), { dep: '06:30', days: '135' });
  const q = shareSearch('?packs=p', s);
  const u = new URLSearchParams(q);
  assert.deepEqual([u.get('from'), u.get('to'), u.get('dep'), u.get('ret'), u.get('days')], ['77.64120,12.97190', '77.62710,12.93520', '06:30', null, '135']);
  assert.deepEqual([u.get('fromName'), u.get('toName')], ['Indiranagar', 'Gym']);
  assert.ok(!q.includes('Parents') && !q.includes('77.5838') && !q.includes('Koramangala'), 'nothing about the other place, nor where the gym is said to be');
  // whoever opens it gets home -> office: the trip, as their commute
  const r = stateFromSearch(q);
  assert.deepEqual([r.home.label, r.office.label, r.office.coord, r.dep, r.days, r.from, r.to, r.places], ['Indiranagar', 'Gym', [77.6271, 12.9352], '06:30', '135', 'home', 'office', []]);
  // office -> home: the office's name goes as the start, so it is not taken for home's
  const v = new URLSearchParams(shareSearch('', { ...swapEnds(saved), office: { ...full.office, label: 'Office' } }));
  assert.deepEqual([v.get('fromName'), v.get('toName'), v.get('dep'), v.get('ret')], ['Office', 'Indiranagar', '18:15', '08:30']);
  // a trip with an end not set: its times only, no names
  const w = new URLSearchParams(shareSearch('', { ...chooseEnd(saved, 'to', 'p1'), home: null }));
  assert.deepEqual([w.get('from'), w.get('fromName'), w.get('toName'), w.get('dep')], [null, null, null, '08:30']);
});

test('applyLink: a shared trip becomes home -> office; saved places and their trips stay', () => {
  const mine = withTimes(chooseEnd(saved, 'to', 'p1'), { dep: '06:30' });
  const link = '?commute=1&from=77.5838,12.9299&to=77.6208,13.0475&dep=09:15&fromName=Jayanagar&toName=Manyata';
  const s = applyLink(mine, link);
  assert.deepEqual([s.home.label, s.office.label, s.dep, s.ret, s.from, s.to], ['Jayanagar', 'Manyata', '09:15', null, 'home', 'office']);
  assert.deepEqual(s.places, mine.places);
  assert.deepEqual(s.trips, mine.trips);
  assert.equal(applyLink(mine, '?commute=1&dep=10:00'), mine, 'no trip in the link: nothing changes');
  assert.equal(applyLink(mine, ''), mine);
});

test('saveState / loadState: without storage (node) nothing throws and the defaults come back', () => {
  assert.doesNotThrow(() => saveState(saved));
  assert.deepEqual(loadState(), DEFAULT_STATE);
});

test('saveState / loadState: the commute and the saved places under their own keys', () => {
  const store = new Map();
  const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  globalThis.window = { localStorage: ls };
  try {
    const s = withTimes(chooseEnd(saved, 'from', 'p2'), { dep: '10:00' });
    saveState(s);
    assert.equal(store.size, 2);
    const ck = [...store.keys()].find((k) => k.endsWith(':commute.v1'));
    const pk = [...store.keys()].find((k) => k.endsWith(':commute.places.v1'));
    const commute = JSON.parse(store.get(ck));
    assert.deepEqual(Object.keys(commute).sort(), ['days', 'dep', 'home', 'office', 'ret'], 'the commute key, as older versions know it');
    assert.deepEqual(Object.keys(JSON.parse(store.get(pk))).sort(), ['from', 'places', 'to', 'trips']);
    assert.deepEqual(loadState(), s);
    // an older version saving only the commute key leaves the saved places be
    store.set(ck, JSON.stringify({ ...commute, dep: '07:45' }));
    const back = loadState();
    assert.equal(back.dep, '07:45');
    assert.deepEqual(back.places, s.places);
    // a broken saved copy: the defaults
    store.set(pk, '{oops');
    assert.deepEqual(loadState().places, []);
  } finally {
    delete globalThis.window;
  }
});
