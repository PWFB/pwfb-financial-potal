import { createAuthClient } from "@neondatabase/auth";

// Record the last requested URL for safe HTTP 404 diagnosis. Do not record
// request bodies, headers, credentials, or passwords.
if (typeof window !== "undefined" && typeof window.fetch === "function" && !window.__PWFB_FETCH_DIAGNOSTICS__) {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      window.__PWFB_LAST_AUTH_REQUEST_URL =
        typeof Request !== "undefined" && input instanceof Request
          ? input.url
          : String(input);
    } catch {
      window.__PWFB_LAST_AUTH_REQUEST_URL = "Request URL unavailable";
    }
    return nativeFetch(input, init);
  };
  window.__PWFB_FETCH_DIAGNOSTICS__ = true;
}

// Neon Auth's configured base URL includes the project's /auth prefix.
const configuredAuthUrl = import.meta.env.VITE_NEON_AUTH_URL
  || "https://ep-winter-resonance-b48nus4i.neonauth.c-6.us-east-2.aws.neon.tech/pwfb_financial_portal/auth";
const normalizedAuthUrl = configuredAuthUrl.replace(/\/$/, "");
const authUrl = normalizedAuthUrl.endsWith("/auth")
  ? normalizedAuthUrl
  : `${normalizedAuthUrl}/auth`;

export { authUrl };
export const authClient = createAuthClient(authUrl);
