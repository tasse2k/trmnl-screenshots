# METEOframe TRMNL Integration

## Problem

TRMNL's standard Image Display plugin fetches at random hourly intervals, completely out of sync with when GitHub Actions generates fresh screenshots. Max staleness can be 60+ minutes.

## Solution: TRMNL Redirect Plugin + Dynamic Refresh Rate

A Netlify function at `/trmnl/{location}` serves JSON for TRMNL's **Redirect plugin**:

```json
{"filename": "barcelona", "url": "https://raw.githubusercontent.com/.../trmnl-screenshot.png", "refresh_rate": 480}
```

The `refresh_rate` (in seconds) adjusts dynamically based on the **local time** in the location's timezone, and snaps to **round clock times** (9:00, 9:15, 9:30, etc.):

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
  → Netlify returns JSON: {url, refresh_rate}
  → Device fetches screenshot PNG directly from GitHub
  → Device displays image, sleeps for refresh_rate seconds
  → Repeat at next round time
```

GitHub Actions generates screenshots independently on its own cron schedule. The Redirect endpoint just points to the latest PNG in the repo.

## Endpoints

| Location | Redirect URL |
|---|---|
| Barcelona | `https://wetterdirect.netlify.app/trmnl/barcelona` |
| Blankenfelde | `https://wetterdirect.netlify.app/trmnl/blankenfelde` |

## Setup Guide

### Step 1: Verify the endpoint is working

```bash
curl -s https://wetterdirect.netlify.app/trmnl/barcelona | python3 -m json.tool
```

Expected response:
```json
{
    "filename": "barcelona",
    "url": "https://raw.githubusercontent.com/tasse2k/trmnl-screenshots/main/trmnl-screenshot.png",
    "refresh_rate": 480
}
```

The `refresh_rate` will vary based on the current local time in Barcelona.

### Step 2: Verify the screenshot URL is accessible

```bash
curl -sI https://raw.githubusercontent.com/tasse2k/trmnl-screenshots/main/trmnl-screenshot.png | head -5
```

Should return `200 OK` with `Content-Type: image/png`.

### Step 3: Configure TRMNL device

1. Go to **TRMNL dashboard** → Plugins
2. Search for **Redirect** plugin → "Add to my plugins"
3. Give it a name (e.g. "METEOframe Barcelona")
4. Set the **URL** to: `https://wetterdirect.netlify.app/trmnl/barcelona`
5. Set **Refresh rate** in the plugin to any value — it will be overridden by the dynamic `refresh_rate` in the JSON response
6. Save

### Step 4: Add to playlist

1. Go to **Playlists** on TRMNL dashboard
2. Add the Redirect plugin to your active playlist
3. If you want it as the primary display, set it as the only plugin or mark it as "Important"

### Step 5: Verify it's working

1. Click **Force Refresh** in the plugin settings to trigger an immediate update
2. Check **Netlify function logs** for: `📺 Redirect for barcelona: 8:00 (Europe/Madrid), interval=15min, next_refresh=900s`
3. Watch the TRMNL device — it should display the weather screenshot
4. After the refresh_rate expires, the device should wake and fetch again at the next round time

### Step 6: Remove old Image Display plugin (optional)

Once confirmed working, remove the old Image Display plugin that was polling the GitHub raw URL on a fixed hourly schedule.

## Adding a New Location

1. Ensure the location exists in `wetterstation/locations.json` and has a `config.json` with a `timezone` field
2. Add a screenshot job in `trmnl-screenshots/.github/workflows/screenshot.yml`
3. Add the screenshot mapping in `wetterstation/netlify/functions/redirect.js` → `SCREENSHOT_MAP`
4. Deploy to Netlify (auto on push)
5. Configure a new Redirect plugin on the TRMNL device pointing to `https://wetterdirect.netlify.app/trmnl/{location}`

## Files

| File | Repo | Purpose |
|---|---|---|
| `netlify/functions/redirect.js` | wetterstation | Redirect endpoint with dynamic refresh |
| `netlify.toml` | wetterstation | Route `/trmnl/*` to redirect function |
| `.github/workflows/screenshot.yml` | trmnl-screenshots | Generates screenshots on timezone-aware cron |
| `locations/{slug}/config.json` | wetterstation | Location timezone for refresh calculation |

## Troubleshooting

- **Device not updating**: Check Netlify logs for the redirect request. Verify the Redirect plugin URL is correct.
- **Wrong refresh rate**: Check the timezone in the location's `config.json`. The log line shows the local hour and calculated interval.
- **Screenshot stale**: Check GitHub Actions — is the screenshot workflow running? Look at the commit timestamps on the PNG files.
- **404 from GitHub raw URL**: The screenshot file might not exist yet for that location. Check `SCREENSHOT_MAP` in `redirect.js`.
