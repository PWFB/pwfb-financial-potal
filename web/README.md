# PWFB Financial Portal

## Authentication API

The Render service runs the Vite-built frontend and the Express API from the same Node process. Authentication routes are server-side; OTPs and session tokens are never returned to the browser.

### Required Render environment variables

Configure these on the `pwfb-financial-potal-web` service in Render. Do not commit real values to GitHub.

- `DATABASE_URL`: connection string for the dedicated `pwfb-financial-portal-auth` Neon branch.
- `SESSION_SECRET`: random secret of at least 32 characters.
- `OTP_PEPPER`: a different random secret used to hash OTPs.
- `TERMII_API_KEY`: the Termii API key.
- `TERMII_SENDER_ID`: approved sender ID; use `N-Alert` only if available for your account.
- `TERMII_CHANNEL`: defaults to `dnd`.
- `PORTAL_ADMIN_PHONE`: the initial administrator's phone number in international format, e.g. `+234XXXXXXXXXX`.
- `PORTAL_ALLOW_REGISTRATION`: leave unset or set to `false` to restrict registration to the administrator number. Set to `true` only if open staff registration is intentionally approved.
- `NODE_ENV`: set to `production`.

The server creates/updates the three `pwfb_portal_*` tables on startup. It supports phone normalization for Nigerian numbers, 4–8 digit PINs hashed with scrypt, 6-digit SMS codes that expire after 5 minutes, a maximum of 5 verification attempts, rate limits, and 12-hour HttpOnly sessions. Login requires both the phone/PIN and a second SMS OTP.

### API endpoints

- `GET /api/health`
- `GET /api/auth/me`
- `POST /api/auth/register/request`
- `POST /api/auth/register/verify`
- `POST /api/auth/login/request`
- `POST /api/auth/login/verify`
- `POST /api/auth/logout`

### Important production-security limitation

The current payroll, salary-disbursement, and cooperative-ledger data is still embedded in the React frontend source/bundle. A login screen does **not** make that data confidential: a public frontend bundle can be downloaded and inspected. Before treating this portal as production-safe or making real financial data public, move records to authenticated server-side endpoints, enforce role-based authorization on every data request, and remove any real personal/payroll/bank information from the public source history. This branch provides the authentication foundation; it does not yet complete that data migration.

### Local development

Install dependencies and build the frontend with `npm install` and `npm run build`. Set the environment variables above, then run `npm start`. The API health endpoint is `/api/health`.
