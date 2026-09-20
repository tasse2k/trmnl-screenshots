# METEOframe TRMNL Integration

> **This file describes the pipeline as of the T4 rebuild (see
> wetterstation's `docs/REBUILD.md` and `docs/tickets/T4-runner-rewrite.md`).
> The previous `redirect.js` / Redirect-plugin / commit-to-git design below
> this note is what it replaces; `redirect.js` is deleted in a later ticket
> (T6) once the new path has been human-verified.**

## How It Works (current, since T4)

TRMNL devices use the **Alias plugin**, pointed directly at
`https://wetterdirect.netlify.app/img/{slug}` (no intermediate redirect
JSON). TRMNL's own refresh scheduling handles cadence; there is nothing to
coordinate on our side any more (see wetterstation's `docs/REBUILD.md`,
"What TRMNL changed").

```
Netlify Scheduled Function (*/15 * * * *, wetterstation, T5)
  → workflow_dispatch → this repo's Actions workflow (screenshot.yml)
      → reads city list + quiet hours from https://wetterdirect.netlify.app/locations
      → per due city: Playwright screenshot (screenshot.js, UNCHANGED)
                       → ImageMagick convert (depth=1 default, depth=2 opt-in)
                       → identify: assert 800x480 + expected depth
                       → POST https://wetterdirect.netlify.app/upload/{slug}-next
                       → GET  https://wetterdirect.netlify.app/img/{slug}-next
                         and assert the bytes read back are identical
TRMNL device → GET https://wetterdirect.netlify.app/img/{slug}
```

Notes:

- The runner writes only to the **`-next`** blob key. The live `/img/{slug}`
  key is switched over by a human, separately (T6) -- this repo's workflow
  never touches it.
- Quiet hours (01:00-05:30 local, hourly) are applied **per city, in its
  own timezone**, inside `run.js` (`lib/schedule.js`) -- not as a single
  UTC-wide gate, and not by GitHub's `schedule:` trigger (removed; it was
  the thing that was silently dropping/delaying most runs -- see
  wetterstation's `docs/REBUILD.md`).
- The workflow no longer commits anything (`permissions: contents: read`).
  `barcelona.png`, `blankenfelde.png`, `screenshot-2.png`,
  `trmnl-screenshot.png` and `log.json` in this repo are leftovers from the
  old commit-to-git pipeline; they are kept as-is until T6, but nothing
  writes to them any more.

## Endpoints (current, since T4)

| Location | Alias URL (device points here) |
|---|---|
| Barcelona | `https://wetterdirect.netlify.app/img/barcelona` |
| Blankenfelde | `https://wetterdirect.netlify.app/img/blankenfelde` |

The candidate image produced by this repo's workflow, before cutover, is
inspectable at the `-next` key: `https://wetterdirect.netlify.app/img/{slug}-next`.

## Running the pipeline

- **Automatically**: wetterstation's Netlify Scheduled Function (T5) calls
  this repo's `workflow_dispatch` every 15 minutes. The runner (`run.js`)
  decides per city whether this is a due tick (quiet hours applied).
- **Manually**: Actions → "Automated Screenshots" → "Run workflow". Leave
  `only` empty to run every TRMNL-enabled city, or set it to one slug.
  `depth` forces the conversion depth for this run only (leave empty to use
  the registry's per-city value, defaulting to 1).
- **Locally**: `LOCATIONS_FIXTURE=fixtures/locations.sample.json UPLOAD_TOKEN=... node run.js`
  (requires Playwright's chromium installed and ImageMagick on PATH). Add
  `DRY_RUN=1` to skip the upload/read-back network calls.

## Adding a New Location

Nothing in this repo needs to change. Add the city to wetterstation's
`locations.json` (`"trmnl": true`, its timezone, its quiet window) and its
`locations/<slug>/config.json`, push wetterstation, and create a TRMNL Alias
plugin pointed at `https://wetterdirect.netlify.app/img/<slug>`. The next
dispatch of this workflow picks it up from `/locations` automatically.

## Files

| File | Repo | Purpose |
|---|---|---|
| `netlify/functions/upload.js` | wetterstation | Authenticated PNG upload to Netlify Blobs (`-next` key) |
| `netlify/functions/img.js` | wetterstation | Serves `/img/{slug}` and `/img/{slug}-next` from Blobs |
| `netlify/functions/schedule.js` | wetterstation | Dispatches this repo's workflow every 15 min |
| `netlify.toml` | wetterstation | Routing, incl. `/img/*` and `/upload/*` |
| `locations.json` + `locations/{slug}/config.json` | wetterstation | Single source of truth for the city list, timezones, quiet hours (T2) |
| `run.js`, `lib/schedule.js` | trmnl-screenshots | Batched runner + quiet-hours logic (this repo) |
| `screenshot.js` | trmnl-screenshots | Playwright rendering -- pixel-perfect, not touched by T4 |
| `.github/workflows/screenshot.yml` | trmnl-screenshots | `workflow_dispatch`-only Actions job |

## Troubleshooting

- **Device not updating**: check `https://wetterdirect.netlify.app/img/{slug}` directly in a browser; check the Actions run log for the city.
- **Screenshot stale**: check GitHub Actions -- is `workflow_dispatch` being called on schedule (wetterstation's `schedule.js`, T5)? Is a city being skipped for quiet hours when it shouldn't be?
- **Wrong-depth or wrong-size image**: the workflow's `identify` validation step fails the job before it ever uploads -- check that job's log, not the device.
- **Upload rejected**: check `UPLOAD_TOKEN` is set as a repo secret and matches wetterstation's `UPLOAD_TOKEN` env var exactly.
- **Read-back mismatch**: this is the loud failure the pipeline is designed to produce instead of silently rotting -- it means what got uploaded is not what `/img/{slug}-next` serves back. Treat it as a wetterstation-side bug (T3), not a runner bug.

---

## Historical: pre-T4 Redirect-plugin design

Everything below this line describes the pipeline **before** the T4
rebuild (dynamic `refresh_rate` via `redirect.js`, screenshots committed to
git). It is kept for archaeology until `redirect.js` is deleted in T6; do
not use it to configure a new device.

### How it worked

A Netlify function at `https://wetterdirect.netlify.app/trmnl/{location}` served JSON for TRMNL's **Redirect plugin**:

```json
{"filename": "barcelona", "url": "https://raw.githubusercontent.com/.../trmnl-screenshot.png", "refresh_rate": 480}
```

The `refresh_rate` (in seconds) adjusted dynamically based on the **local time** in the location's timezone and snapped to **round clock times** (9:00, 9:15, 9:30, etc.).

### Refresh Schedule

| Local time | Interval | Example wakes |
|---|---|---|
| 1:00–6:00 AM | every 60 min | 1:00, 2:00, 3:00... |
| 6:00–7:30 AM | every 30 min | 6:00, 6:30, 7:00, 7:30 |
| 7:30–10:30 AM | every 15 min | 7:30, 7:45, 8:00... |
| 10:30 AM–10:00 PM | every 30 min | 10:30, 11:00, 11:30... |
| 10:00 PM–1:00 AM | every 60 min | 22:00, 23:00, 0:00 |

GitHub Actions generated screenshots on a coordinated cron schedule, offset by -3 minutes so fresh images were committed before the device woke. The cron windows were widened to cover both CET (UTC+1) and CEST (UTC+2), so no manual DST adjustments were needed. This is the `schedule:` trigger T4 removed -- it was heavily delayed/dropped by GitHub Actions in practice (see wetterstation's `docs/REBUILD.md`).
