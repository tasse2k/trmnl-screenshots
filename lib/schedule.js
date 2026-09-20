'use strict';

// Quiet-hours module for the screenshot runner.
//
// This is a PORT of `lib/schedule.js` as specified by T2
// (wetterstation `docs/tickets/T2-registry-and-schedule.md`,
// "Deliverable 2 -- lib/schedule.js"). At the time this file was written,
// T2 had not shipped yet in the wetterstation repo -- there was no upstream
// file to copy byte-for-byte. This is an independent implementation of the
// SAME documented spec, not a copy-paste.
//
// How the two copies are kept honest (see the T4 report for the full
// explanation, since the two modules live in separate repos with separate
// CI and cannot literally share a file):
//
//   1. The rules below are transcribed verbatim from T2's own written spec
//      (hourCycle: 'h23', not hour12; local time decides quiet-window
//      membership; UTC minute === 0 decides the hourly tick; wrapping
//      windows supported).
//   2. schedule.test.js below implements every case T2 Deliverable 4 lists
//      as required test coverage (Madrid/New York, the 05:30 boundary,
//      local-midnight-never-24, a wrapping window, Asia/Kolkata, both
//      Berlin DST transitions). Once T2 ships its own lib/schedule.js and
//      test file, diffing the two test files is the fast way to catch any
//      behavioural drift -- if a case here would fail against T2's
//      implementation (or vice versa), that is the signal to fix one of
//      them.
//   3. When T2 ships, replace this file's body with the real upstream
//      module (keeping this file's path so run.js does not need to
//      change) and delete this header.

// Extract local hour/minute using Intl.DateTimeFormat.formatToParts.
// Deliberately NOT `new Date(d.toLocaleString(...))` parse-back (fragile,
// locale/engine dependent) and NOT `hour12: false` (some ICU builds return
// hour "24" at local midnight instead of "0").
function getLocalParts(tz, now) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = {};
  for (const { type, value } of fmt.formatToParts(now)) {
    if (type === 'hour' || type === 'minute') {
      parts[type] = parseInt(value, 10);
    }
  }
  return parts; // { hour: 0-23, minute: 0-59 }
}

function toMinutesOfDay(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Is this city inside its quiet window, in its own timezone?
//
// `quiet` is a ["HH:MM", "HH:MM"] pair, start inclusive, end exclusive.
// Supports a window that wraps midnight (e.g. ["23:00", "05:30"]).
// A city with no `quiet` window (or a malformed one) is never quiet.
function isQuiet(tz, quiet, now = new Date()) {
  if (!Array.isArray(quiet) || quiet.length !== 2) return false;

  const { hour, minute } = getLocalParts(tz, now);
  const nowMin = hour * 60 + minute;
  const start = toMinutesOfDay(quiet[0]);
  const end = toMinutesOfDay(quiet[1]);

  if (start === end) return false; // degenerate/empty window

  if (start < end) {
    // Ordinary same-day window, e.g. 01:00-05:30.
    return nowMin >= start && nowMin < end;
  }

  // Wraps midnight, e.g. 23:00-05:30.
  return nowMin >= start || nowMin < end;
}

// Should this city be screenshotted on this */15 tick?
//
// Normal -> every tick (true).
// Quiet  -> only on the UTC :00 tick -- exactly hourly, offset-independent.
//           This is deliberate: a half-hour-offset timezone (e.g.
//           Asia/Kolkata, UTC+5:30) would never land on a LOCAL :00 tick,
//           so gating on local minute would silently never run during
//           quiet hours. Gating on UTC minute instead still yields exactly
//           one run per hour, just not aligned to the city's local clock.
//
// `city` is a registry entry shaped like `{ tz, quiet }` (extra fields,
// e.g. `trmnl`/`depth`, are ignored).
function shouldRun(city, now = new Date()) {
  const { tz, quiet } = city || {};
  if (!isQuiet(tz, quiet, now)) return true;
  return now.getUTCMinutes() === 0;
}

module.exports = { isQuiet, shouldRun, getLocalParts };
