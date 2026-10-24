# Snap Lite

A phone app for one trade business at a time. The owner (or crew) takes before, during and after photos; the server turns them into a short branded video with an optional UK voiceover; the owner approves it and shares it from the phone's share sheet.

One codebase (the chassis), one folder per client (`skins/<id>/`). `SKIN=<id>` picks the client. The first skin is `ekp11`.

Not a public website, feed, quote system or auto-poster. Everything is behind a sign-in.

## Run

    DATABASE_URL=postgres://... SKIN=ekp11 ADMIN_PASSWORD=... MEDIA_DIR=./media node server.js
    BASE_URL=http://localhost:3000 ADMIN_PASSWORD=... node test/smoke.js all   # tests also run against a deployed server

## Layout

- `server.js` wiring, brand assets, manifest. `accounts.js` users, roles, sessions. `jobs.js` capture flow and owner-only actions. `admin.js` /admin (Robert only).
- `skins/<id>/skin.json` + `logo.png.b64`: everything client-specific. A new client is a new folder.
- `deploy/snaplite.compose.yml` Docker project for the Hostinger VPS (push to main, restart the project).
- `video/engine.py` the video engine inherited from snapthejob-site (replaced in phase 4).
