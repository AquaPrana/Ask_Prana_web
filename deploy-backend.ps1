# Deploy the Ask Prana backend (Edge Functions + secrets) to your Supabase project.
# Usage (PowerShell, from this folder):  .\deploy-backend.ps1 -ProjectRef <your-project-ref>
# Needs the Supabase CLI: https://supabase.com/docs/guides/local-development/cli/getting-started
param([Parameter(Mandatory = $true)][string]$ProjectRef)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

npx supabase login
npx supabase link --project-ref $ProjectRef

if (Test-Path "supabase/.env") {
  npx supabase secrets set --env-file supabase/.env --project-ref $ProjectRef
} else {
  Write-Warning "supabase/.env not found - copy supabase/.env.example to supabase/.env and fill it in, then run this again."
  exit 1
}

foreach ($fn in @("ask-prana", "ask-prana-tts", "ask-prana-transcribe", "msg91-auth", "google-auth")) {
  npx supabase functions deploy $fn --no-verify-jwt --project-ref $ProjectRef
}
Write-Host "Backend deployed. Remember to run supabase/schema.sql once in the SQL Editor of a new project."
