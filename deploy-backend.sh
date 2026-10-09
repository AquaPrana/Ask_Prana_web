#!/usr/bin/env bash
# Deploy the Ask Prana backend (Edge Functions + secrets) to your Supabase project.
# Usage: ./deploy-backend.sh <your-project-ref>
set -euo pipefail
cd "$(dirname "$0")"
REF="${1:?Usage: ./deploy-backend.sh <project-ref>}"
npx supabase login
npx supabase link --project-ref "$REF"
[ -f supabase/.env ] || { echo "Copy supabase/.env.example to supabase/.env and fill it in first."; exit 1; }
npx supabase secrets set --env-file supabase/.env --project-ref "$REF"
for fn in ask-prana ask-prana-tts ask-prana-transcribe msg91-auth google-auth; do
  npx supabase functions deploy "$fn" --no-verify-jwt --project-ref "$REF"
done
echo "Backend deployed. Run supabase/schema.sql once in the SQL Editor of a new project."
