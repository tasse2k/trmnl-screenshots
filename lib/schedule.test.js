'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isQuiet, shouldRun, getLocalParts } = require('./schedule.js');

// Coverage mirrors T2's "Deliverable 4 -- tests" list exactly, so that if
// wetterstation ships lib/schedule.js with different behaviour, the same
// scenarios below would diverge and be easy to spot by diffing the two
// test files.

test('inside the quiet window in Europe/Madrid (barcelona, 01:00-05:30)', () => {
  // 2026-01-15 is CET (UTC+1) in Madrid -> 03:00 local = 02:00 UTC.
  const now = new Date('2026-01-15T02:00:00Z');
  assert.equal(isQuiet('Europe/Madrid', ['01:00', '05:30'], now), true);
});

test('outside the quiet window in Europe/Madrid', () => {
  // 12:00 local (CET, UTC+1) = 11:00 UTC.
  const now = new Date('2026-01-15T11:00:00Z');
  assert.equal(isQuiet('Europe/Madrid', ['01:00', '05:30'], now), false);
});

test('inside the quiet window in America/New_York', () => {
  // 2026-01-15 is EST (UTC-5) in New York -> 02:00 local = 07:00 UTC.
  const now = new Date('2026-01-15T07:00:00Z');
  assert.equal(isQuiet('America/New_York', ['01:00', '05:30'], now), true);
});

test('outside the quiet window in America/New_York', () => {
  // 15:00 local (EST, UTC-5) = 20:00 UTC.
  const now = new Date('2026-01-15T20:00:00Z');
  assert.equal(isQuiet('America/New_York', ['01:00', '05:30'], now), false);
});

test('05:29 local is quiet, 05:30 local is not (Europe/Madrid, CET)', () => {
  const at0529 = new Date('2026-01-15T04:29:00Z'); // 05:29 CET
  const at0530 = new Date('2026-01-15T04:30:00Z'); // 05:30 CET
  assert.equal(isQuiet('Europe/Madrid', ['01:00', '05:30'], at0529), true);
  assert.equal(isQuiet('Europe/Madrid', ['01:00', '05:30'], at0530), false);
});

test('local midnight returns hour 0, never 24 (hourCycle h23)', () => {
  // 00:00 CET = 23:00 UTC the previous day.
  const now = new Date('2026-01-14T23:00:00Z');
  const { hour, minute } = getLocalParts('Europe/Madrid', now);
  assert.equal(hour, 0);
  assert.equal(minute, 0);
  assert.notEqual(hour, 24);
});

test('a wrapping window (23:00-05:30) is quiet just after 23:00 and just before 05:30', () => {
  const quiet = ['23:00', '05:30'];
  const justAfter2300 = new Date('2026-01-15T23:05:00Z'); // UTC city, simplest case
  const justBefore0530 = new Date('2026-01-16T05:29:00Z');
  const atNoon = new Date('2026-01-15T12:00:00Z');
  assert.equal(isQuiet('UTC', quiet, justAfter2300), true);
  assert.equal(isQuiet('UTC', quiet, justBefore0530), true);
  assert.equal(isQuiet('UTC', quiet, atNoon), false);
});

test('a wrapping window is not quiet exactly at its end boundary', () => {
  const at0530 = new Date('2026-01-16T05:30:00Z');
  assert.equal(isQuiet('UTC', ['23:00', '05:30'], at0530), false);
});

test('Asia/Kolkata (UTC+5:30) still runs exactly once an hour while quiet', () => {
  const quiet = ['01:00', '05:30'];
  const city = { tz: 'Asia/Kolkata', quiet };

  // Kolkata local = UTC + 5:30. Local 02:00 = UTC 20:30 (previous day).
  const localTwoAM = new Date('2026-01-14T20:30:00Z');
  assert.equal(isQuiet('Asia/Kolkata', quiet, localTwoAM), true);
  // Local :00 tick never happens on Kolkata's clock during quiet hours
  // (offset is :30) -- but the UTC :00 tick still fires once an hour.
  assert.equal(shouldRun(city, localTwoAM), false); // UTC minute is 30
  const oneUtcHourLater = new Date(localTwoAM.getTime() + 30 * 60_000);
  assert.equal(oneUtcHourLater.getUTCMinutes(), 0);
  // Still local quiet hours (local time now 02:30).
  assert.equal(isQuiet('Asia/Kolkata', quiet, oneUtcHourLater), true);
  assert.equal(shouldRun(city, oneUtcHourLater), true);
});

test('normal (non-quiet) city runs on every tick regardless of UTC minute', () => {
  const city = { tz: 'Europe/London', quiet: undefined };
  assert.equal(shouldRun(city, new Date('2026-06-15T13:07:00Z')), true);
  assert.equal(shouldRun(city, new Date('2026-06-15T13:22:00Z')), true);
});

test('trmnl:false / no-quiet city (e.g. bilbao) is never quiet', () => {
  assert.equal(isQuiet('Europe/Madrid', undefined, new Date('2026-01-15T02:00:00Z')), false);
});

test('quiet city only runs on the UTC :00 tick, not other ticks, while quiet', () => {
  const city = { tz: 'Europe/Madrid', quiet: ['01:00', '05:30'] };
  const atUtc00 = new Date('2026-01-15T02:00:00Z'); // 03:00 CET, quiet
  const atUtc15 = new Date('2026-01-15T02:15:00Z');
  const atUtc30 = new Date('2026-01-15T02:30:00Z');
  const atUtc45 = new Date('2026-01-15T02:45:00Z');
  assert.equal(shouldRun(city, atUtc00), true);
  assert.equal(shouldRun(city, atUtc15), false);
  assert.equal(shouldRun(city, atUtc30), false);
  assert.equal(shouldRun(city, atUtc45), false);
});

// --- Europe/Berlin DST transitions ---
// Spring forward 2026-03-29: 02:00 CET -> 03:00 CEST (01:00 UTC skips
// straight from local 01:59:59 to 03:00:00; the wall-clock hour 02:xx
// does not exist that day).
test('Europe/Berlin spring-forward: no missed and no doubled quiet hour', () => {
  const quiet = ['01:00', '05:30'];
  // 00:30 UTC = 01:30 CET, still before the gap -> quiet.
  assert.equal(isQuiet('Europe/Berlin', quiet, new Date('2026-03-29T00:30:00Z')), true);
  // 01:00 UTC = 03:00 CEST (clock jumped), well inside 01:00-05:30 -> quiet.
  assert.equal(isQuiet('Europe/Berlin', quiet, new Date('2026-03-29T01:00:00Z')), true);
  // 03:30 UTC = 05:30 CEST -> boundary, not quiet.
  assert.equal(isQuiet('Europe/Berlin', quiet, new Date('2026-03-29T03:30:00Z')), false);
  // 03:29 UTC = 05:29 CEST -> still quiet.
  assert.equal(isQuiet('Europe/Berlin', quiet, new Date('2026-03-29T03:29:00Z')), true);
});

// Fall back 2026-10-25: 03:00 CEST -> 02:00 CET (local hour 02:xx happens
// twice). Both occurrences must read as quiet -- neither missed nor
// double-counted as "not quiet" due to ambiguity.
test('Europe/Berlin fall-back: both occurrences of the doubled hour are quiet', () => {
  const quiet = ['01:00', '05:30'];
  // 00:30 UTC = 02:30 CEST (first pass through 02:xx, before the fold).
  assert.equal(isQuiet('Europe/Berlin', quiet, new Date('2026-10-25T00:30:00Z')), true);
  // 01:30 UTC = 02:30 CET (second pass through 02:xx, after the fold).
  assert.equal(isQuiet('Europe/Berlin', quiet, new Date('2026-10-25T01:30:00Z')), true);
  // 03:30 UTC = 04:30 CET -> still quiet.
  assert.equal(isQuiet('Europe/Berlin', quiet, new Date('2026-10-25T03:30:00Z')), true);
  // 04:30 UTC = 05:30 CET -> boundary, not quiet.
  assert.equal(isQuiet('Europe/Berlin', quiet, new Date('2026-10-25T04:30:00Z')), false);
});
