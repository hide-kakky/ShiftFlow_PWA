# ShiftFlow PWA

## Frontend (Cloudflare Pages)
- Static assets served by Cloudflare Pages live in `frontend/public`.
- Set the Cloudflare Pages **Build Output Directory** to `frontend/public`.

## Backend (Apps Script API)
- Google Apps Script source is isolated in `backend/gas`.
- Managed through clasp; deploy independently from the frontend.
- Cloudflare Functions proxy (planned) should live under `functions/api/proxy` when switching away from direct redirects.
