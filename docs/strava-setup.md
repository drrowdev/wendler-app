# Strava integration setup

The app reads activities from Strava via OAuth. To enable it for your
deployment, you must register a Strava API application (free) and put four
values into your Static Web App settings.

## 1. Register a Strava app

1. Go to <https://www.strava.com/settings/api> while signed into Strava.
2. Click **Create & Manage Your App**.
3. Fill in:
   - **Application name**: `Wendler 5/3/1` (or whatever you like)
   - **Category**: `Training`
   - **Website**: your SWA hostname, e.g. `https://wendler-app-xyz.azurestaticapps.net`
   - **Authorization Callback Domain**: the bare hostname of your SWA, e.g.
     `wendler-app-xyz.azurestaticapps.net` *(no `https://`, no path)*
4. Save. Copy the **Client ID** and **Client Secret** that Strava generates.

## 2. Configure the SWA

In Azure Portal → your Static Web App → **Configuration** → **Application
settings**, add (alongside the auth + Cosmos settings — see
[`docs/architecture.md`](architecture.md) for the full env-var matrix):

| Name | Value |
|---|---|
| `STRAVA_CLIENT_ID` | numeric client id from Strava |
| `STRAVA_CLIENT_SECRET` | secret string from Strava |
| `STRAVA_REDIRECT_URI` | `https://<your-swa-host>/api/strava/callback` |
| `AUTH_STATE_SECRET` | any random ≥16 char string (HMAC-signs OAuth state) |

Or via CLI:

```bash
az staticwebapp appsettings set \
  --name <swa-name> \
  --resource-group <rg> \
  --setting-names \
    STRAVA_CLIENT_ID=<id> \
    STRAVA_CLIENT_SECRET=<secret> \
    STRAVA_REDIRECT_URI=https://<swa-host>/api/strava/callback
```

Restart isn't needed — SWA picks up new settings on the next request.

## 3. Connect from the app

1. Sign in (Microsoft account) on the app.
2. Open **Settings → Strava**.
3. Click **Connect Strava** → Strava asks you to authorise → you're redirected
   back with `?strava=connected`.
4. Click **Sync now** to pull new activities since last sync, or
   **Refresh last 60 days** to re-pull a wider window (idempotent — dedupes
   by `externalId = 'strava:<activityId>'`).

## Run-plan auto-tagging

If you maintain a **Weekly run plan** at `/cardio/plan`, every imported
run is auto-tagged with the planned kind for the day-of-week it landed on
(e.g. a Wednesday run inherits `quality` if Wed is set to "Quality").

- The matcher is intentionally minimal — **day-of-week only**. Names and
  descriptions from Strava aren't used because Runna (and most coaching
  apps) push generic titles like "Evening Run" with no metadata.
- Override per-row in `/cardio` via the **Tag as:** dropdown. Manual tags
  are sticky (`planMatch === 'manual'`) and survive re-syncs and
  plan edits.

## What gets imported

For every activity since the last sync:

- Sport, name, start time, distance, moving time, elevation
- Average + max heart rate (when wearable was used)
- Strava's suffer score / relative effort, perceived exertion
- Encoded route polyline (low-res)

For activities with HR data, the API additionally fetches the HR stream and
computes time-in-zone (Z1..Z5) using your Strava-configured zones.

For runs, the API fetches detailed activity to extract `best_efforts` for
1k / 1mi / 5k / 10k / Half / Marathon.

## Privacy

- The OAuth tokens are stored in **your** Cosmos DB, partitioned by your
  user id. They're never returned to the browser.
- The `sync/pull` endpoint excludes Strava token docs from its results, so
  even a malicious client cannot exfiltrate them.
- Disconnect from **Settings → Strava → Disconnect** at any time. Imported
  activities stay in your local DB and Cosmos; only the token doc is
  deleted. To revoke at Strava's side, also visit
  <https://www.strava.com/settings/apps> and revoke "Wendler 5/3/1".

## Rate limits

Strava allows 100 requests per 15 minutes per app and 1000 per day. The
sync function uses ~1 request per activity for the HR stream and ~1 extra
for run details. A typical weekly sync (5–10 activities) fits comfortably.
