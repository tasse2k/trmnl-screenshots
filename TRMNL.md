# METEOframe TRMNL Integration

## How It Works

A Netlify function at `https://wetterdirect.netlify.app/trmnl/{location}` serves JSON for TRMNL's **Redirect plugin**:

```json
{"filename": "barcelona", "url": "https://raw.githubusercontent.com/.../trmnl-screenshot.png", "refresh_rate": 480}
```

The `refresh_rate` (in seconds) adjusts dynamically based on the **local time** in the location's timezone and snaps to **round clock times** (9:00, 9:15, 9:30, etc.).

## Refresh Schedule

| Local time | Interval | Example wakes |
|---|---|---|
| 1:00–6:00 AM | every 60 min | 1:00, 2:00, 3:00... |
| 6:00–7:30 AM | every 30 min | 6:00, 6:30, 7:00, 7:30 |
| 7:30–10:30 AM | every 15 min | 7:30, 7:45, 8:00... |
| 10:30 AM–10:00 PM | every 30 min | 10:30, 11:00, 11:30... |
| 10:00 PM–1:00 AM | every 60 min | 22:00, 23:00, 0:00 |

**~20 device refreshes/day** — preserves battery while keeping weather fresh when it matters.

## Architecture

```
TRMNL device wakes
  → TRMNL server fetches https://wetterdirect.netlify.app/trmnl/{location}
  → Netlify returns JSON: {filename, url, refresh_rate}
  → Device fetches screenshot PNG directly from GitHub
  → Device displays image, sleeps until next round time
```

GitHub Actions generates screenshots on a coordinated cron schedule, offset by -3 minutes so fresh images are committed before the device wakes. The cron windows are widened to cover both CET (UTC+1) and CEST (UTC+2), so no manual DST adjustments are needed.

## Endpoints

| Location | Redirect URL |
|---|---|
| Barcelona | `https://wetterdirect.netlify.app/trmnl/barcelona` |
| Blankenfelde | `https://wetterdirect.netlify.app/trmnl/blankenfelde` |

## Setup Guide

### Step 1: Verify the endpoint

```bash
curl -s https://wetterdirect.netlify.app/trmnl/barcelona | python3 -m json.tool
```

### Step 2: Configure TRMNL device

1. Go to **TRMNL dashboard** → Plugins → **Redirect** → "Add to my plugins"
2. Name it (e.g. "METEOframe Barcelona")
3. Set the **URL** to `https://wetterdirect.netlify.app/trmnl/barcelona`
4. Set Refresh rate to any value — it will be overridden by the dynamic `refresh_rate` in the response
5. Save and add to your playlist

### Step 3: Verify

1. Click **Force Refresh** in plugin settings
2. Check Netlify function logs for `📺 Redirect for barcelona: ...`
3. Device should display the weather screenshot on next wake

## Adding a New Location

1. Ensure location exists in `wetterstation/locations.json` with a `config.json` containing a `timezone` field
2. Add a screenshot job in `.github/workflows/screenshot.yml`
3. Add the screenshot mapping in `wetterstation/netlify/functions/redirect.js` → `SCREENSHOT_MAP`
4. Push both repos
5. Configure a new Redirect plugin on the TRMNL device

## Files

| File | Repo | Purpose |
|---|---|---|
| `netlify/functions/redirect.js` | wetterstation | Redirect endpoint with dynamic refresh |
| `netlify.toml` | wetterstation | Route `/trmnl/*` to redirect function |
| `.github/workflows/screenshot.yml` | trmnl-screenshots | Screenshot generation on coordinated cron |
| `locations/{slug}/config.json` | wetterstation | Location timezone for refresh calculation |

## Troubleshooting

- **Device not updating**: Check Netlify logs for the redirect request. Verify the Redirect plugin URL is correct.
- **Wrong refresh rate**: Check the timezone in the location's `config.json`. The log shows local time and calculated interval.
- **Screenshot stale**: Check GitHub Actions — is the workflow running? Look at commit timestamps on the PNG files.
- **Image inverted/garbled**: Screenshots must be 1-bit monochrome PNG (800x480). The workflow uses ImageMagick with Floyd-Steinberg dithering per the [TRMNL spec](https://docs.trmnl.com/go/diy/imagemagick-guide).
