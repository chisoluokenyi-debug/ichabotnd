# ICHA AI Studio

A separate Node.js web application hosted from the `studio/` folder. It does not change the existing ICHA BOT application.

## Render service

- Service: `icha-ai-studio`
- Runtime: Node.js
- Build command: `npm install --prefix studio`
- Start command: `npm start --prefix studio`
- Deploy branch: `icha-ai-studio`
- Health endpoint: `/api/health`
- Public status endpoint: `/api/status`
- Non-billable provider diagnostics: `/api/provider-check`

## Current implementation status

The deployed code currently contains a public landing page, a health endpoint, a configuration-status endpoint, and non-billable Replicate/ElevenLabs credential checks.

The following features are **not implemented or enabled yet**:
- Appwrite-backed customer registration and login
- Customer profile and credit ledger
- Manual payment submission and admin approval
- Admin dashboard and protected admin authorization
- Video generation jobs and result storage
- Voice generation or voice cloning workflows
- Credit charging, refunds, quotas, and audit logs

Do not advertise these unfinished features as available. Provider credentials passing a connection check does not mean generation is implemented or free. Generation must remain disabled until authentication, payment/credit controls, usage limits, consent, and provider-cost safeguards are implemented and tested.

## Database choice: Appwrite

This project uses **Appwrite**, not Supabase. The previous Supabase setup instructions have been removed to avoid configuring the wrong backend.

The Appwrite project already created for this application is expected to contain the `icha_ai_database` database and a `customers` table. Confirm the actual table ID and column keys in Appwrite Console before implementing database writes. A table's display name is not guaranteed to be its table ID.

### Required server configuration for the future Appwrite integration

Set these values in Render Environment Variables only after confirming the exact values in Appwrite Console:

- `APPWRITE_ENDPOINT` — Appwrite API endpoint for the project's region, ending in `/v1`
- `APPWRITE_PROJECT_ID` — Appwrite project ID
- `APPWRITE_DATABASE_ID` — database ID for `icha_ai_database`
- `APPWRITE_CUSTOMERS_TABLE_ID` — exact table ID for the existing customers table
- `APPWRITE_API_KEY` — server-only Appwrite API key with only the scopes required by implemented server routes
- `ADMIN_EMAIL` — exact owner email used for the protected admin allowlist

The Appwrite API key is a secret. Never put it in browser code, commit it to GitHub, or send it in chat. Do not grant broad database/schema-management scopes to a runtime key. The integration should use user JWTs for customer-scoped operations and reserve a narrowly scoped server key for trusted admin operations.

### Existing customer table

The expected existing columns recorded during setup are:

- `user_id` — required Varchar
- `full_name` — required Varchar
- `email` — required Varchar
- `status` — required Varchar, default `pending`
- `credits` — required Integer, default `0`
- `created_at` — required DateTime

Additional payment columns were discussed but their exact names and types have not yet been verified. Do not write payment data until the actual schema is confirmed. Do not create another table or upgrade the Appwrite plan just for this step.

## Provider configuration

Keep provider keys in Render Environment Variables only:

- `REPLICATE_API_TOKEN` — Replicate API token
- `ELEVENLABS_API_KEY` — ElevenLabs API key

The existing provider-check route makes account/profile requests only. It does not create video or audio and does not consume generation credits.

## Safety and release requirements

Before enabling any paid or public generation:
- Verify customer identity from an Appwrite session/JWT on the server; never trust a user ID supplied by the browser.
- Enforce customer-specific permissions and an explicit server-side admin allowlist.
- Verify bank transfers in the business account before approval; never approve from a screenshot alone.
- Make credit deduction and payment approval atomic and idempotent.
- Add request quotas, provider spend limits, job status tracking, failure handling, and audit logs.
- Require explicit, documented speaker consent for voice cloning and block unauthorized impersonation.
- Keep generation disabled until end-to-end tests pass.
