import { createAuthClient } from "@neondatabase/auth";

const authUrl = import.meta.env.VITE_NEON_AUTH_URL || "https://ep-winter-resonance-b48nus4i.neonauth.c-6.us-east-2.aws.neon.tech/pwfb_financial_portal/auth";

export const authClient = createAuthClient(authUrl);
