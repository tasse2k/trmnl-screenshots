'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { plan } = require('../plan.js');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'locations.sample.json');
const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

describe('plan()', () => {
  test('agrees with shouldRun for every tick of a day, city by city', async () => {
    process.env.LOCATIONS_FIXTURE = FIXTURE;
    const schedule = require('./schedule.js');
    const registry = require(FIXTURE);
    const cities = Object.entries(registry.locations).filter(([, c]) => c.trmnl === true);
    assert.ok(cities.length > 0);
    let dueTicks = 0;
    for (let i = 0; i < 288; i++) {
      // 40s past the tick, as the runner sees it.
      const now = new Date(Date.parse('2026-11-14T00:00:40Z') + i * 5 * 60_000);
      const expected = cities.some(([, cfg]) => schedule.shouldRun(cfg, now));
      const got = await plan(now);
      assert.equal(got.due, expected, now.toISOString());
      assert.equal(got.lines.length, cities.length);
      if (got.due) dueTicks++;
    }
    assert.ok(dueTicks > 0 && dueTicks < 288, `${dueTicks} of 288 ticks due`);
  });

  test('ONLY narrows the decision to that city', async () => {
    process.env.LOCATIONS_FIXTURE = FIXTURE;
    const registry = require(FIXTURE);
    const [slug] = Object.entries(registry.locations).find(([, c]) => c.trmnl === true);
    process.env.ONLY = slug;
    const got = await plan(new Date('2026-11-14T09:00:30Z'));
    assert.equal(got.lines.length, 1);
    assert.match(got.lines[0], new RegExp(`^  ${slug}: `));
  });

  test('an unreadable registry rejects, so the caller can fail open', async () => {
    process.env.LOCATIONS_FIXTURE = path.join(__dirname, 'does-not-exist.json');
    await assert.rejects(plan(new Date()));
  });
});
