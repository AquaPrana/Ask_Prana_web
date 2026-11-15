# Ask Prana Node backend

Node + Express + MySQL backend for the Ask Prana web app. It has every feature
the Supabase functions had: chat (typed and streaming), voice chat, microphone
(dictation), read aloud, file and photo upload, generated PDF/Excel/Word
answers, chat history in English/Telugu/Hindi, OTP and Google login, profile
and profile photo.

## How it is built

- `src/functions/` — the Ask Prana features (chat, voice session, transcribe,
  read aloud, translation, MSG91 login, Google login). Same logic and prompts
  as before, running in Node.
- `src/edge/supabase-mysql.ts` — the database and file layer those features
  use: data and files both in MySQL (files in the `storage_objects` table).
- `src/edge/routes.ts` — Express routes the web app calls:
  `POST /functions/v1/<feature>`, `/storage/v1/object/...` for file links.
- `migrations/` — MySQL tables (`npm run migrate`, safe to run again).

## Run locally (Windows)

```
cd backend
npm.cmd install
npm.cmd run migrate
npm.cmd run dev
```

Then in `web/.env.local`:

```
EXPO_PUBLIC_BACKEND=node
EXPO_PUBLIC_API_URL=http://localhost:3001
```

and start the web app (`npm.cmd run dev` in `web`). Without these two lines
the web app keeps using Supabase.

`backend/.env` needs the database settings, `SESSION_SECRET`,
`REGISTRATION_SECRET`, and the same `OPENAI_API_KEY`, `MSG91_AUTHKEY`,
`MSG91_WIDGET_ID` and `GOOGLE_WEB_CLIENT_ID` values as the Supabase function
secrets. In production also set `PUBLIC_API_URL` and `ALLOWED_ORIGINS`.

Production: `npm run build` then `npm start`. Uploaded files, generated
PDF/Excel/Word answers and profile photos are stored in MySQL, so no
persistent disk is needed. Files saved by older versions under
`UPLOAD_DIR/storage/` can be copied in with `npm run import-files` (safe to
run again).

## Notes

- Pond mode (ponds, crop cycles, pond logs) needs those tables, which are not
  in MySQL yet; the web app uses general chat, which works fully.
- `/v1/auth` and `/v1/auth/me` (older JSON API) are still available.

---


## Hostinger notes

Use Node 22 (the package `engines` range also permits a supported Node 20). Bind to `process.env.PORT`; Hostinger Web Apps supply the hosted port. Keep requests below 120 seconds, use no inbound WebSockets, and use bounded scheduled scripts for eventual jobs. Hostinger’s current documentation confirms those managed-host limits and Express/Node support: [Node.js limits](https://www.hostinger.com/support/hostinger-node-js-limits-for-web-and-cloud-plans/), [Node.js Web Apps](https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/), and [Node cron jobs](https://www.hostinger.com/support/how-to-run-cron-jobs-for-node-js-websites-at-hostinger/).
