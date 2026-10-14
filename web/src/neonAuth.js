import { createAuthClient, BetterAuthVanillaAdapter } from "@neondatabase/auth";

// The Neon Auth SDK appends endpoints such as /sign-in/email to this URL.
// Keep the project's /auth path in the base URL so requests do not hit the
// nonexistent /pwfb_financial_portal/sign-in/email route.
const configuredAuthUrl = import.meta.env.VITE_NEON_AUTH_URL
  || "https://ep-winter-resonance-b48nus4i.neonauth.c-6.us-east-2.aws.neon.tech/pwfb_financial_portal/auth";

const normalizedAuthUrl = configuredAuthUrl.replace(/\/$/, "");
const authUrl = normalizedAuthUrl.endsWith("/auth")
  ? normalizedAuthUrl
  : `${normalizedAuthUrl}/auth`;

export const authClient = createAuthClient(authUrl, {
  adapter: BetterAuthVanillaAdapter({
    fetchOptions: {
      onRequest(request) {
        // Temporary, non-secret diagnostic so a 404 identifies the exact route.
        if (typeof window !== "undefined") {
          window.__PWFB_LAST_AUTH_REQUEST_URL = request?.url || String(request);
        }
      },
    },
  }),
});
