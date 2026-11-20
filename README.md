# trmnl-screenshots

Screenshot runner for the **METEOframe** TRMNL e-ink weather frames.

This repo is deliberately small: a workflow, a browser script, and the
scheduling logic. It exists separately from the backend because public repos
get unlimited GitHub Actions minutes. It is dispatched 288 times a day (about
half of those find no city due and finish in seconds) plus 24 watchdog runs,
and each run bills at least a minute, which a private repo's free tier does
not cover.

Rendering, storage, serving and all configuration live in the private
`tasse2k/wetterstation` repo. **Nothing about the dashboards is configured
here** — no city list, no timezones, no URLs beyond the one base address.

## What a run does

```
workflow_dispatch  (fired by a Netlify scheduled function every 5 min)
  └─ run.js
       ├─ GET /locations                     cities, timezones, quiet hours
       ├─ skip cities not due on this tick        (local-time band schedule:
       │                                          5/10/15 min by hour, hourly
       │                                          inside the quiet window)
       └─ per remaining city:
            ├─ screenshot.js -> Playwright -> {slug}-raw.png
            ├─ ImageMagick   -> 800x480 PNG, depth 2 (1-bit is the rollback)
            ├─ identify      -> assert geometry + bit depth
            ├─ POST /upload/{slug}           authenticated, Netlify Blobs
            └─ GET  /img/{slug}              assert byte-identical
```

A per-city failure does not abort the others, and it does not fail the job
either: it is reported as a warning on the run (see "The publisher does not
email" below). The job only goes red if something outside `run.js` breaks.

There is **no `schedule:` trigger**, and there must not be one. GitHub's
scheduled-workflow queue is best-effort: measured over 28 days it delivered
5.6 runs/day against ~49 intended, with a 120-minute median gap and a
14.5-hour worst case. `workflow_dispatch` is API-driven and picked up
near-instantly, so the schedule lives outside GitHub.

## Files

| | |
|---|---|
| `.github/workflows/screenshot.yml` | One batched job, `workflow_dispatch` only, `contents: read` |
| `run.js` | Orchestrator: registry, publish schedule, convert, validate, upload, verify |
| `screenshot.js` | Playwright capture. **Do not modify** — see below |
| `lib/schedule.js` | Publish schedule (bands + quiet hours). Byte-identical copy of wetterstation `lib/schedule.js` — `diff` them after touching either |
| `lib/*.test.js` | `npm test` — publish schedule, filename contract, read-back |
| `fixtures/` | Sample `/locations` payload for offline runs |
| `*.png`, `log.json` | Historical artefacts of the pre-2026-09 pipeline. Frozen — the job is `contents: read` and can no longer write them |

## Running it

```bash
npm ci
npx playwright install --with-deps chromium
UPLOAD_TOKEN=... node run.js          # all due cities
ONLY=barcelona node run.js            # one city
DEPTH_OVERRIDE=1 node run.js          # force a depth for this run -- publishes LIVE
npm test
```

`UPLOAD_TOKEN` is a shared secret with the upload endpoint, stored as a
repository secret and as a Netlify environment variable. Without it the
upload endpoint fails closed with 503.

## Things that look wrong and are not

- **`plan.js` runs before anything is installed.** About half of all ticks
  have no city due. It makes that decision first, with the same
  `lib/schedule.js` and registry as `run.js`, so those runs skip the installs
  (the step that hangs when the Ubuntu mirror is slow) and finish in seconds.
  It fails open: if it cannot decide, the full pipeline runs.
- **The publisher does not email.** A city that fails, a run that cannot
  read the registry, and an Ubuntu mirror that will not serve packages are
  all reported as warnings on the run, which still succeeds. Almost every
  such failure is gone by the next tick, so an email about it was noise: in
  the week of 2026-11-14 that was 3 failed and 25 cancelled runs, every one
  transient (the mirror, and once a Netlify 503). Every install attempt is
  bounded (3 x 70s for Chromium's packages, 2 x 60s for ImageMagick), so a
  run finishes before the next dispatch would cancel it, and a tick the
  mirror cannot serve is simply skipped. Whether a frame has actually
  stopped updating is decided in one place: `/health`, polled by the
  watchdog. To see what the publisher has been warning about, open a run in
  the Actions tab; the warnings are listed at the top of its summary.
- **`watchdog.yml` is the alarm.** Hourly, it asks the site's `/health`
  whether each frame was published on schedule and has current weather, and
  fails if not -- a failed run is what emails. It is the only `schedule:`
  workflow here, deliberately separate from the publisher. GitHub disables
  scheduled workflows in a repository with no commits for 60 days and emails
  first; re-enable it from the Actions tab when that happens.
- **`screenshot.js` refuses any page the dashboard did not answer 200 for.**
  Playwright's `goto()` resolves on a 500, and an error page is 800x480 like
  any other, so it used to pass every check and be published as the frame.
  Failing instead leaves the last good image on the panel.
- **The font-readiness wait in `screenshot.js`** — `document.fonts.ready`,
  per-font `loaded`, explicit `fonts.load()`, a 15 s cap, then a further 3 s.
  It looks redundant. It is what makes the screenshot pixel-perfect on a
  1-bit panel. It has not been modified once across the whole rebuild, and
  should stay that way.
- **`OUTPUT_FILE` is a base name, not an output path.** `screenshot.js`
  derives `{X}-raw.png` and `{X}-meta.json` from it and never writes
  `OUTPUT_FILE` itself. Passing `{slug}-raw.png` double-suffixes to
  `{slug}-raw-raw.png`; `lib/filenames.test.js` guards this by parsing
  `screenshot.js`'s own `replace()` calls.
- **The read-back requests `Accept-Encoding: identity`** to mimic the device,
  which does not negotiate compression. Without it, undici decompresses
  transparently and drops `content-length`.
- **A missing `Content-Length` on read-back is a warning, not a failure.**
  Netlify serves functions `Transfer-Encoding: chunked`, which forbids it.
  Byte-identity is the real check and stays a hard failure.
- **Ordered dither, not Floyd–Steinberg.** Error diffusion propagates across
  the image, causing ghosting under the device's fast-refresh partial update.
