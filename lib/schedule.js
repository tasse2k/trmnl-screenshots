// Publish-cadence logic shared by weather.js and the T4 runner (via the
// /locations endpoint, which mirrors this module's inputs).
//
// The cron tick is every 5 minutes (netlify.toml). This module decides, per
// city and per tick, whether that tick is one this city publishes on. The
// cadence is a per-city LOCAL-TIME band schedule:
//
//   08:00-11:00   every  5 min     (morning)
//   11:00-18:00   every 10 min     (working day)
//   18:00-21:00   every  5 min     (evening)
//   21:00-23:00   every 10 min     (wind-down)
//   anything else every 15 min     (night shoulder: 23:00-08:00)
//   quiet window  every 60 min     (locations.json `quiet`, overrides all)
//
// Two deliberately different clocks are in play here — do not "simplify"
// them into one:
//
//   - isQuiet() and intervalMinutes() answer "where is this city in its own
//     day right now?" using the city's LOCAL hour + minute. Quiet hours and
//     the bands are local-life concepts ("every 5 minutes between 08:00 and
//     11:00 in Barcelona"), so they must be evaluated in Barcelona's own
//     wall-clock time.
//
//   - shouldRun() answers "is this tick one of them?" using the UTC minute.
//     This is offset-independent. Every real UTC offset is a whole multiple
//     of 15 minutes, and 5/10/15 all divide 15, so a UTC-minute grid of 5,
//     10 or 15 minutes lands on exactly the same instants as the local one —
//     while a LOCAL-minute check would silently never fire in a half-hour
//     zone at the hourly (quiet) cadence. (Asia/Kolkata, UTC+5:30, never
//     sees a local :00 when UTC is at :00.) The 60-minute quiet cadence is
//     the one that genuinely cannot be local, and it sets the rule for all
//     of them.
//
//     The two grids share a phase for every offset that is a multiple of the
//     interval. The only zones where they do not are the :45 offsets
//     (Asia/Kathmandu, Pacific/Chatham) on the 10-minute bands: those still
//     publish every 10 minutes, just on local :05/:15/... instead of
//     :00/:10/... Nothing in this project runs there.
//
// Both functions extract local wall-clock time via
// Intl.DateTimeFormat(...).formatToParts() with hourCycle: 'h23'.
// hour12: false is NOT equivalent — some ICU builds return hour "24" for
// local midnight under hour12: false (see redirect.js:24 for the existing,
// uncorrected bug). h23 always returns 0-23.

'use strict';

// The cron tick in netlify.toml. Every cadence below must be a multiple of
// this (or it can never fire) AND a divisor of 60 (or it would drift across
// the hour boundary). Asserted at the bottom of this file.
const TICK_MINUTES = 5;

// Local-time bands, [start, end). Ordered, non-overlapping, non-wrapping.
const BANDS = [
  { start: '08:00', end: '11:00', everyMinutes: 5 },
  { start: '11:00', end: '18:00', everyMinutes: 10 },
  { start: '18:00', end: '21:00', everyMinutes: 5 },
  { start: '21:00', end: '23:00', everyMinutes: 10 }
];

// Outside every band — in practice the 23:00-08:00 night shoulder.
const DEFAULT_INTERVAL_MINUTES = 15;

// Inside a city's `quiet` window. Overrides the band schedule: the bands
// describe how fresh the frame should be while someone is looking at it,
// quiet hours describe the hours when nobody is. Delete a city's `quiet`
// key in locations.json to drop the override and let the 15-minute night
// shoulder apply all the way through.
const QUIET_INTERVAL_MINUTES = 60;

/**
 * Extract the local hour (0-23) and minute (0-59) for `now` in `tz`,
 * using formatToParts (never the toLocaleString parse-back pattern, which
 * re-parses a locale-formatted string with the *system* timezone and is
 * fragile across environments).
 *
 * @param {string} tz - IANA timezone, e.g. "Europe/Berlin"
 * @param {Date} now
 * @returns {{ hour: number, minute: number }}
 */
function getLocalHourMinute(tz, now) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit'
  });

  const parts = fmt.formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour').value);
  const minute = Number(parts.find((p) => p.type === 'minute').value);
  return { hour, minute };
}

function toMinutesSinceMidnight(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Is this city inside its quiet window right now, in its own timezone?
 *
 * The window is [start, end) — the start boundary is inclusive, the end
 * boundary is exclusive (05:29 is quiet, 05:30 is not). A window whose end
 * is numerically before its start (e.g. ["23:00", "05:30"]) is treated as
 * wrapping past local midnight.
 *
 * @param {string} tz - IANA timezone
 * @param {[string, string]|undefined|null} quiet - ["HH:MM", "HH:MM"], or
 *   falsy if this city has no quiet window at all (always non-quiet)
 * @param {Date} [now]
 * @returns {boolean}
 */
function isQuiet(tz, quiet, now = new Date()) {
  if (!quiet) return false;

  const [startStr, endStr] = quiet;
  const startMinutes = toMinutesSinceMidnight(startStr);
  const endMinutes = toMinutesSinceMidnight(endStr);

  const { hour, minute } = getLocalHourMinute(tz, now);
  const nowMinutes = hour * 60 + minute;

  if (startMinutes <= endMinutes) {
    // Ordinary same-day window, e.g. 01:00-05:30.
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }

  // Wraps midnight, e.g. 23:00-05:30.
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

/**
 * How often should this city publish right now, in minutes?
 *
 * Quiet window wins; otherwise the local-time band; otherwise the default.
 *
 * @param {{ tz: string, quiet?: [string, string] }} city
 * @param {Date} [now]
 * @returns {number} 5, 10, 15 or 60
 */
function intervalMinutes(city, now = new Date()) {
  const { tz, quiet } = city || {};

  if (isQuiet(tz, quiet, now)) return QUIET_INTERVAL_MINUTES;

  const { hour, minute } = getLocalHourMinute(tz, now);
  const nowMinutes = hour * 60 + minute;

  for (const band of BANDS) {
    if (nowMinutes >= toMinutesSinceMidnight(band.start) &&
        nowMinutes < toMinutesSinceMidnight(band.end)) {
      return band.everyMinutes;
    }
  }

  return DEFAULT_INTERVAL_MINUTES;
}

/**
 * Should this city be screenshotted on this cron tick (every 5 minutes)?
 *
 * The tick grid is UTC — see the header. At 60 minutes that means the UTC
 * :00 tick (exactly hourly in every timezone, whatever its offset); below
 * an hour it means every Nth minute of the UTC hour.
 *
 * @param {{ tz: string, quiet?: [string, string] }} city - a
 *   `registry.locations[slug]` entry (or anything with the same shape)
 * @param {Date} [now]
 * @returns {boolean}
 */
function shouldRun(city, now = new Date()) {
  const every = intervalMinutes(city, now);
  return now.getUTCMinutes() % every === 0;
}

// Fail loudly at require() time rather than silently never firing — the
// previous version of this module gated quiet hours on `getUTCMinutes() === 0`
// while the cron fired at :15/:29/:44/:59, so the hourly overnight run fired
// zero times for as long as the runner was fast enough not to spill into the
// next minute. A cadence that is not on the tick grid is that same bug.
for (const every of [...BANDS.map((b) => b.everyMinutes),
                     DEFAULT_INTERVAL_MINUTES, QUIET_INTERVAL_MINUTES]) {
  if (every % TICK_MINUTES !== 0 || 60 % every !== 0) {
    throw new Error(
      `lib/schedule.js: ${every}-minute cadence is unreachable — it must be a ` +
      `multiple of the ${TICK_MINUTES}-minute cron tick and a divisor of 60.`
    );
  }
}

module.exports = {
  isQuiet,
  shouldRun,
  intervalMinutes,
  getLocalHourMinute,
  BANDS,
  TICK_MINUTES,
  DEFAULT_INTERVAL_MINUTES,
  QUIET_INTERVAL_MINUTES
};
