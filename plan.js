'use strict';

// Decide, before anything is installed, whether this tick has work to do.
//
// The dispatch arrives every 5 minutes, but each city publishes every 5, 10,
// 15 or 60 minutes, so on roughly half of all ticks no city is due. Those
// runs used to install Chromium's system packages and ImageMagick from the
// Ubuntu mirror (about 27 seconds, and the step that hangs when the mirror
// is slow) and then exit without publishing. This step runs first, needs
// nothing but Node, and lets the workflow skip the installs.
//
// It decides with the same lib/schedule.js and the same registry as run.js,
// and hands run.js the instant it decided for (PLAN_NOW), so the two can
// never disagree about which tick this is.
//
// It fails OPEN. If the registry cannot be read, the answer is "due": the
// full pipeline runs and reports the problem the way it always has. This
// step can save work, never lose a publish.

const fs = require('fs');
const schedule = require('./lib/schedule.js');
const { loadRegistry, selectCities } = require('./run.js');

async function plan(now = new Date()) {
  const only = process.env.ONLY || undefined;
  const registry = await loadRegistry();
  const cities = selectCities(registry, only);
  const tick = schedule.tickOf(now).toISOString().slice(11, 16);
  const lines = [];
  let due = false;
  for (const [slug, cfg] of cities) {
    const every = schedule.intervalMinutes(cfg, now);
    if (schedule.shouldRun(cfg, now)) {
      due = true;
      lines.push(`  ${slug}: DUE (every ${every} min, tick ${tick}Z)`);
    } else {
      // Same wording as run.js's summary, so a skipped tick still names the
      // cadence and the tick it decided about.
      lines.push(`  ${slug}: SKIPPED (not due (every ${every} min, tick ${tick}Z))`);
    }
  }
  return { due, lines };
}

async function main() {
  const now = new Date();
  let due = true;
  try {
    const result = await plan(now);
    due = result.due;
    console.log('=== Plan ===');
    for (const line of result.lines) console.log(line);
    if (!due) console.log('No city is due on this tick -- skipping the installs and the pipeline.');
  } catch (err) {
    console.warn(`Plan could not be made (${err.message}); running the full pipeline.`);
  }
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `due=${due}\nnow=${now.toISOString()}\n`);
  }
}

module.exports = { plan };

if (require.main === module) {
  main();
}
