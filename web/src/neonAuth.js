import { createAuthClient } from "@neondatabase/auth";

// Neon Auth SDK adds the /auth route prefix itself. Accept either the project
// base URL or the full dashboard URL, but never pass a duplicated /auth suffix.
const configuredAuthUrl = import.meta.env.VITE_NEON_AUTH_URL
  || "https://ep-winter-resonance-b48nus4i.neonauth.c-6.us-east-2.aws.neon.tech/pwfb_financial_portal";

const authUrl = configuredAuthUrl.replace(/\/auth\/?$/, "").replace(/\/$/, "");

export const authClient = createAuthClient(authUrl);
