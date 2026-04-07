# METEOframe TRMNL Webhook Integration

## Problem

TRMNL's standard Image Display plugin fetches at random hourly intervals, completely out of sync with when GitHub Actions generates fresh screenshots. Max staleness can be 60+ minutes.

## Solution

Use TRMNL's **Webhook Image** plugin. GitHub Actions pushes PNGs directly to TRMNL's server after generation. The image is ready and waiting when the device wakes. Combined with TRMNL's **Playlist Scheduler** for timezone-aware wake cycles, this gives fresh data when it matters (morning/evening) and preserves battery overnight.

## Architecture

```
GitHub Actions (timezone-aware cron)
  → Playwright generates 800x480 1-bit PNG (unchanged)
  → Commits PNG to repo (unchanged, serves as fallback/debug)
  → curl POST PNG to TRMNL Webhook Image URL(s)
        ↓
TRMNL server stores image immediately (seconds)
        ↓
Device wakes on Playlist Scheduler → picks up fresh image
```

## Backwards Compatibility

Screenshot filenames and repo structure are unchanged:
- `trmnl-screenshot.png` (Barcelona/dashboard)
- `screenshot-2.png` (Blankenfelde)

The raw GitHub URLs still work. Old Image Display plugins can run as fallback.

## Coordinated Schedule (Barcelona + Blankenfelde, both UTC+2)

| Local time | Purpose | GitHub Action | TRMNL device wake | Daily runs |
|---|---|---|---|---|
| 6:00–9:00 AM | Morning peak | every 15 min | every 15 min | ~12 |
| 9:00 AM–6:00 PM | Daytime | every 30 min | every 60 min | ~18 |
| 6:00–10:00 PM | Evening peak | every 30 min | every 30 min | ~8 |
| 10:00 PM–6:00 AM | Night | every 60 min | off / every 2h | ~4 |

**Total: ~35-40 GitHub Action runs/day** (well within free tier: 2000 min/month, ~2 min/run)

**Total TRMNL device refreshes: ~20/day** (good battery life)

## Setup Instructions

### Step 1: Create Webhook Image plugins on TRMNL

For each device (Barcelona + Blankenfelde):

1. Go to **TRMNL dashboard** → Plugins → **Webhook Image** → "Add to my plugins"
2. Give it a name (e.g. "METEOframe Barcelona")
3. After saving, copy the **Webhook URL** shown in plugin settings
4. Keep the old Image Display plugin running as fallback while testing

### Step 2: Add webhook URLs as GitHub secrets

1. Go to GitHub → `tasse2k/trmnl-screenshots` → Settings → Secrets and variables → Actions
2. Add two repository secrets:
   - `TRMNL_WEBHOOK_PRIMARY` → paste the Barcelona webhook URL
   - `TRMNL_WEBHOOK_SECONDARY` → paste the Blankenfelde webhook URL

### Step 3: Configure Playlist Scheduler on each TRMNL device

Set timezone-aware refresh rates:

| Time window | Refresh interval |
|---|---|
| 6:00–9:00 AM | every 15 min |
| 9:00 AM–6:00 PM | every 60 min |
| 6:00–10:00 PM | every 30 min |
| 10:00 PM–6:00 AM | off or every 2h |

### Step 4: Test

1. Trigger a manual workflow run: Actions → "Automated Screenshots" → Run workflow
2. Check the workflow logs for "TRMNL webhook response: 200"
3. Verify the image appears in the TRMNL Webhook Image plugin preview
4. Wait for the device's next wake cycle to confirm it displays

### Step 5: Remove old Image Display plugin (optional)

Once the webhook approach is confirmed working, you can remove the old Image Display plugin from each device.

## Future

- UUID-based location management for anonymous customer onboarding
- Per-timezone schedule configs when adding locations outside UTC+2
- Published TRMNL Recipe for self-service installation
- Automated webhook URL registration via meteoframe.com
