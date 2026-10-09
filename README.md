# Ask Prana — Website + Backend

| Folder | What it is |
| --- | --- |
| `web/` | The website (Vite + React). Same screens, UI and behaviour as the Expo app. |
| `supabase/functions/` | Backend (Supabase Edge Functions, Deno) |
| `supabase/schema.sql` | Database tables, indexes, triggers, security rules and storage buckets |
| `supabase/config.toml` | Supabase CLI config (JWT verification off; the functions do their own auth) |
| `supabase/.env.example` | List of backend secrets |
| `deploy-backend.ps1` / `.sh` | One-command backend deploy |

**Backend functions:**

| Function | Used for |
| --- | --- |
| `ask-prana` | Chat answers (OpenAI model `gpt-5.6-sol`, set in `supabase/functions/_shared/openai-responses.ts`), chat history, file uploads, translation, document export |
| `msg91-auth` | Phone + email OTP login through MSG91, registration, sessions, profile, profile photo |
| `google-auth` | Google sign-in |
| `ask-prana-transcribe` | Voice-to-text (mic and voice mode) |
| `ask-prana-tts` | Read-aloud voice |

The function code is identical to what runs on the live Supabase project `Ask_Prana_Generic_Assistant`. The schema was exported from the same live database.

---

## 1. Run the website locally (uses the existing live backend)

Install **Node.js 22** (or 20.19+) from https://nodejs.org.

- **Windows:** open `web` and double-click `start-windows.bat`.
- **Mac/Linux:** run `cd web && ./start.sh`.
- **Manual:** `cd web && npm install && npm run dev`

The site opens at **http://localhost:8081**.

`web/.env` already points at the live Supabase project, so login, OTP, Google sign-in and chat work right away.

---

## 2. Deploy everything fresh (new GitHub repo + optional new Supabase project)

### a. Push to your new GitHub repo

```bash
git init
git add .
git commit -m "Ask Prana website + backend"
git branch -M main
git remote add origin https://github.com/<you>/<new-repo>.git
git push -u origin main
```

`.gitignore` keeps `.env` files out of GitHub. Your keys go into Vercel and Supabase instead.

### b. Backend

You can keep using the current Supabase project, or create a new one. To create a new one:

1. Go to supabase.com and click **New project**.
2. Open **SQL Editor**, paste the whole of `supabase/schema.sql`, and click **Run**.
3. Copy `supabase/.env.example` to `supabase/.env` and fill in:
   - `OPENAI_API_KEY`
   - `MSG91_AUTHKEY` and `MSG91_WIDGET_ID`
   - `GOOGLE_WEB_CLIENT_ID`
4. Deploy the functions and secrets. Your project ref is the `xxxx` in `https://xxxx.supabase.co`.
   - Windows PowerShell: `.\deploy-backend.ps1 -ProjectRef <project-ref>`
   - Mac/Linux: `./deploy-backend.sh <project-ref>`

### c. Website (Vercel)

1. On vercel.com, click **Add New → Project** and import the new GitHub repo.
2. Set **Root Directory** to `web`. The framework is auto-detected as **Vite**, the build command is `npm run build`, and the output folder is `dist`.
3. Under **Environment Variables**, add:
   - `EXPO_PUBLIC_SUPABASE_URL` = `https://<project-ref>.supabase.co`
   - `EXPO_PUBLIC_SUPABASE_ANON_KEY` = Supabase → Project Settings → API → `anon` / publishable key
   - `EXPO_PUBLIC_MSG91_WIDGET_TOKEN` and `EXPO_PUBLIC_MSG91_WIDGET_ID` (same values as in `web/.env`)
4. Click **Deploy**.

For local runs against a new project, put the same values in `web/.env`.

### d. After the first deploy

- **Google sign-in:** in Google Cloud Console → Credentials → your OAuth *Web* client → **Authorized redirect URIs**, add:
  - `https://<your-vercel-domain>/phone-login`
  - `http://localhost:8081/phone-login`
  
  Under **Authorized JavaScript origins**, add the same two origins without `/phone-login`.
- **MSG91:** in the OTP widget settings, set **SMS** as the primary channel and attach your DLT-approved template. This makes phone codes arrive by SMS.
