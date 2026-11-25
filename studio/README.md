# ICHA AI Studio

A separate Node.js web application hosted from the `studio/` folder of the ICHA BOT repository. It does not change the existing bot application.

## Render setup
- Runtime: Node
- Build command: `npm install --prefix studio`
- Start command: `npm start --prefix studio`
- Branch: `icha-ai-studio`

## Current state
The public landing page and non-billable provider connection checks are deployed. Customer accounts, admin operations, payment approval, credits and generation are **not yet live**. Do not advertise these as available until the application code and credentials are configured and tested.

## Zero-cost-first database setup
A separate Supabase project can be used instead of a paid Render PostgreSQL instance.

1. Create a Supabase project.
2. Open its SQL Editor and run the complete contents of `schema.sql`.
3. In Supabase Authentication settings, enable email/password sign-in and configure the site URL as `https://studio.tanphat.shop`.
4. Register your own account on the Studio once the registration UI is deployed.
5. Promote only that account to admin from the SQL Editor, replacing the email below with the exact email used to register:

```sql
update public.profiles
set role = 'admin'
where email = 'YOUR_OWNER_EMAIL'
  and id = (select id from auth.users where email = 'YOUR_OWNER_EMAIL');
```

6. Add the Supabase project URL, anon key, and service-role key to Render Environment Variables. The service-role key must remain server-side and must never be put in browser code or committed to GitHub.

## Environment variables
See `.env.example` for names only. Set real values directly in Render:
- `REPLICATE_API_TOKEN` — Replicate API token
- `ELEVENLABS_API_KEY` — ElevenLabs API key
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_ANON_KEY` — Supabase public anon key
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service-role key (server-side only)

## Database design
`schema.sql` defines profiles, packages, manual payment requests, a credit ledger, generation job records, row-level security, and an atomic admin-only payment review function. Approval credits the customer exactly once. The schema does not by itself create a working login UI or payment admin UI; those still need application routes and end-to-end testing.

## Safety
- No public generation endpoint should be enabled until authenticated user checks, credit deduction, quotas, provider cost limits, upload restrictions and audit logging are implemented.
- Voice cloning must require explicit proof of speaker consent and must block impersonation or unauthorized cloning.
- Never trust a payment screenshot alone; verify the transfer in the business bank account before approving.
- Do not reuse the ICHA BOT database or change the bot's root application.
