// @ts-nocheck -- node:test types are not part of the browser tsconfig
// Saved places in My commute: cleaning the saved copy, adding, renaming, moving and deleting, unique names and ids.
// Run: node --test src/ui/commute/__tests__/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PLACES, addPlace, cleanCoord, cleanLabel, cleanPlaces, defaultLabel, movePlace, nextId, removePlace, renamePlace, uniqueLabel } from '../places.ts';

const KORA = [77.6271, 12.9352];
const HSR = [77.6387, 12.9116];
const gym = { id: 'p1', label: 'Gym', where: 'Near Koramangala', coord: KORA };
const school = { id: 'p2', label: 'School', where: 'HSR Layout', coord: HSR };

test('cleanLabel and cleanCoord: one line of text, a point in Bengaluru', () => {
  assert.equal(cleanLabel('  <b>Gym</b>\n  near\tlake ', 'x'), 'bGym/b near lake');
  assert.equal(cleanLabel('', 'Place'), 'Place');
  assert.equal(cleanLabel(42, 'Place'), 'Place');
  assert.equal(cleanLabel('a'.repeat(80), 'x').length, 60);
  assert.deepEqual(cleanCoord(['77.6', '12.9']), [77.6, 12.9]);
  assert.equal(cleanCoord([0, 0]), null, 'far outside the city');
  assert.equal(cleanCoord([77.6]), null);
  assert.equal(cleanCoord('77.6,12.9'), null);
});

test('uniqueLabel: a number is added to a name already taken, case aside', () => {
  assert.equal(uniqueLabel('Gym', ['Home', 'Office']), 'Gym');
  assert.equal(uniqueLabel('gym', ['Home', 'Gym']), 'gym 2');
  assert.equal(uniqueLabel('Gym', ['Gym', 'Gym 2']), 'Gym 3');
  assert.equal(uniqueLabel('home', ['Home', 'Office']), 'home 2', 'home and office keep their names');
  const long = 'x'.repeat(60);
  assert.equal(uniqueLabel(long, [long]), `${'x'.repeat(58)} 2`, 'still at most 60 characters');
});

test('defaultLabel: a new place is named after its area, never its coordinates', () => {
  assert.equal(defaultLabel('Near Koramangala'), 'Koramangala');
  assert.equal(defaultLabel('My location · HSR Layout'), 'HSR Layout');
  assert.equal(defaultLabel('Indiranagar'), 'Indiranagar');
  assert.equal(defaultLabel('12.9352, 77.6271'), 'Place');
});

test('nextId: the first free p-number', () => {
  assert.equal(nextId([]), 'p1');
  assert.equal(nextId([{ id: 'p1' }, { id: 'p3' }]), 'p2');
  assert.equal(nextId([{ id: 'p2' }, { id: 'p1' }]), 'p3');
});

test('cleanPlaces: the saved copy, checked', () => {
  assert.deepEqual(cleanPlaces(null), []);
  assert.deepEqual(cleanPlaces({ p1: gym }), [], 'not a list');
  assert.deepEqual(cleanPlaces([gym, school]), [gym, school]);
  assert.deepEqual(cleanPlaces([null, 'x', { label: 'Far', coord: [0, 0] }, gym]), [gym], 'no point in the city: dropped');
  // a missing or repeated id gets a free one; a repeated name a number
  const two = cleanPlaces([gym, { ...school, id: 'p1', label: 'gym' }]);
  assert.deepEqual(two.map((p) => [p.id, p.label]), [['p1', 'Gym'], ['p2', 'gym 2']]);
  assert.deepEqual(cleanPlaces([{ coord: KORA, where: 'Near Koramangala' }])[0], { id: 'p1', label: 'Koramangala', where: 'Near Koramangala', coord: KORA }, 'no name: its area');
  assert.equal(cleanPlaces([{ coord: KORA }])[0].where, '12.9352, 77.6271', 'no place text: the point');
  assert.equal(cleanPlaces([{ ...gym, label: 'Home' }])[0].label, 'Home 2');
  assert.equal(cleanPlaces([{ ...gym, id: '__proto__' }])[0].id, 'p1');
  const many = Array.from({ length: 8 }, (_, i) => ({ label: `P${i}`, where: 'x', coord: KORA }));
  assert.equal(cleanPlaces(many).length, MAX_PLACES, `at most ${MAX_PLACES}`);
});

test('addPlace: named or after its area, unique, up to five', () => {
  const one = addPlace([], 'Near Koramangala', KORA);
  assert.deepEqual(one, [{ id: 'p1', label: 'Koramangala', where: 'Near Koramangala', coord: KORA }]);
  const two = addPlace(one, 'HSR Layout', HSR, '  Kids’ school ');
  assert.deepEqual(two[1], { id: 'p2', label: 'Kids’ school', where: 'HSR Layout', coord: HSR });
  assert.equal(addPlace(two, 'Koramangala', KORA)[2].label, 'Koramangala 2');
  assert.equal(addPlace(two, 'Near Koramangala', KORA, 'office')[2].label, 'office 2', "a saved place cannot take the office's name");
  assert.equal(addPlace([], '12.9352, 77.6271', KORA)[0].label, 'Place');
  // full, or a point outside the city: the same list back
  let full = [];
  for (let i = 0; i < MAX_PLACES; i++) full = addPlace(full, `Area ${i}`, KORA);
  assert.equal(full.length, MAX_PLACES);
  assert.equal(addPlace(full, 'One more', HSR), full);
  assert.equal(addPlace(one, 'Mysuru', [76.64, 12.3]), one);
  // ids are reused once free
  assert.equal(addPlace(removePlace(full, 'p2'), 'Again', HSR).at(-1).id, 'p2');
});

test('renamePlace: cleaned and unique; an empty name keeps the old one', () => {
  const ps = [gym, school];
  assert.deepEqual(renamePlace(ps, 'p1', ' Swimming\npool ')[0], { ...gym, label: 'Swimming pool' });
  assert.equal(renamePlace(ps, 'p1', 'school')[0].label, 'school 2');
  assert.equal(renamePlace(ps, 'p1', 'GYM')[0].label, 'GYM', 'its own name in another case is fine');
  assert.equal(renamePlace(ps, 'p1', '   '), ps);
  assert.equal(renamePlace(ps, 'p1', 'Gym'), ps, 'no change, same list');
  assert.equal(renamePlace(ps, 'p9', 'X'), ps, 'unknown place');
  assert.equal(renamePlace(ps, 'p2', 'Office')[1].label, 'Office 2');
});

test('movePlace and removePlace', () => {
  const ps = [gym, school];
  assert.deepEqual(movePlace(ps, 'p1', 'Near HSR Layout', HSR)[0], { ...gym, where: 'Near HSR Layout', coord: HSR }, 'a new point, the same name');
  assert.equal(movePlace(ps, 'p1', 'Far', [0, 0]), ps);
  assert.equal(movePlace(ps, 'p7', 'x', HSR), ps);
  assert.deepEqual(removePlace(ps, 'p1'), [school]);
  assert.equal(removePlace(ps, 'p7'), ps);
});
