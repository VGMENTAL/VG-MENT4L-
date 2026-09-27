# VG MENT4L

Free Fire MAX sensitivity tools with:
- Website 1 — device/profile-based sensitivity generation
- Website 2 — OB update recalibration
- Website 3 — gameplay sensitivity checking
- Profile ID backend storage
- Gameplay AI analysis hooks

## Persistent Profile ID setup

The code now includes a Render Blueprint in `render.yaml` that wires the Node web service to a PostgreSQL database through `DATABASE_URL`.

**Important:** Render's Free Postgres is intended for testing/hobby use and currently expires after 30 days. For long-term permanent profile storage, use a database plan that does not expire. The website keeps a browser-local fallback, but that fallback is not cross-device.

After creating/syncing the Blueprint in Render:
1. Confirm the web service is `vg-ment4l`.
2. Confirm `DATABASE_URL` is present on the web service.
3. Open `/api/health` and check that `database` is `connected`.
4. Generate a new Profile ID in Website 1, then load that ID from another device in Website 2/3.

AI keys are intentionally not stored in GitHub. Add them as Render environment variables when needed.
