# VG MENT4L — Public Deployment

Free Fire MAX sensitivity tools with Website 1 (device/HUD sensitivity) and Website 2 (OB update recalibration).

## Render
- Build command: `npm install`
- Start command: `npm start`
- Environment variables: none required

## Important
Profile data is written to the service filesystem as a backend fallback. On hosting plans with an ephemeral filesystem, data can be lost after a restart/redeploy; for permanent cross-device storage, connect a persistent database later.

## Routes
- `/` — landing page
- `/website1.html` — sensitivity generator
- `/website2.html` — OB updates
- `/api/health` — backend health
- `/api/config` — latest supported OB configuration
