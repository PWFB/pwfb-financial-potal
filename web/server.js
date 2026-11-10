import crypto from "node:crypto";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pg from "pg";
import { createRemoteJWKSet, jwtVerify } from "jose";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 10000);
const databaseUrl = process.env.DATABASE_URL;
const sessionSecret = process.env.SESSION_SECRET;
const otpPepper = process.env.OTP_PEPPER;
const neonAuthBaseUrl = process.env.NEON_AUTH_BASE_URL || "https://ep-winter-resonance-b48nus4i.neonauth.c-6.us-east-2.aws.neon.tech/pwfb_financial_portal/auth";
const neonAuthJwksUrl = process.env.NEON_AUTH_JWKS_URL || "https://ep-winter-resonance-b48nus4i.neonauth.c-6.us-east-2.aws.neon.tech/pwfb_financial_portal/auth/.well-known/jwks.json";
const portalAdminEmail = String(process.env.PORTAL_ADMIN_EMAIL || "").trim().toLowerCase();
const neonJwks = createRemoteJWKSet(new URL(neonAuthJwksUrl));
const sessionCookie = "pwfb_portal_session";
const sessionHours = 12;
const maxOtpAttempts = 5;

if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!sessionSecret || sessionSecret.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters");
if (!otpPepper || otpPepper.length < 32) throw new Error("OTP_PEPPER must contain at least 32 characters and be different from SESSION_SECRET");
if (otpPepper === sessionSecret) throw new Error("OTP_PEPPER and SESSION_SECRET must be different secrets");

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000
});

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "12kb" }));
app.use("/api/auth", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
app.use("/api/auth", rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: "draft-8", legacyHeaders: false }));

function normalizePhone(input) {
  let value = String(input || "").trim().replace(/[\s()-]/g, "");
  if (value.startsWith("+")) value = value.slice(1);
  if (/^0\d{10}$/.test(value)) value = "234" + value.slice(1);
  else if (/^\d{10}$/.test(value)) value = "234" + value;
  if (!/^234\d{10}$/.test(value)) return null;
  return "+" + value;
}
function phoneForTermii(phone) { return phone.replace(/^\+/, ""); }
function hashText(value) { return crypto.createHmac("sha256", otpPepper).update(String(value)).digest("hex"); }
function hashSession(token) { return crypto.createHash("sha256").update(token).digest("hex"); }
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(pin, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}
function verifyPin(pin, stored) {
  if (!stored || !stored.startsWith("scrypt$")) return false;
  const [, salt, expectedHex] = stored.split("$");
  if (!salt || !expectedHex) return false;
  const actual = crypto.scryptSync(pin, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function validPin(pin) { return /^\d{6}$/.test(String(pin || "")); }
function validCredential(value) { const secret = String(value || ""); return validPin(secret) || (secret.length >= 8 && secret.length <= 128); }
function setSessionCookie(res, token) {
  res.cookie(sessionCookie, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: sessionHours * 60 * 60 * 1000
  });
}
function readCookie(req, name) {
  const cookies = String(req.headers.cookie || "").split(";").map(part => part.trim());
  const prefix = name + "=";
  const found = cookies.find(part => part.startsWith(prefix));
  if (!found) return null;
  try { return decodeURIComponent(found.slice(prefix.length)); } catch { return null; }
}
function clearSessionCookie(res) {
  res.clearCookie(sessionCookie, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/" });
}
function ipHash(req) { return hashText(req.ip || "unknown"); }
function safeUser(row) {
  return { id: row.id, name: row.full_name, phone: row.phone_e164, role: row.role };
}
async function issueSession(client, req, res, user) {
  const token = crypto.randomBytes(32).toString("base64url");
  await client.query(
    "INSERT INTO pwfb_portal_sessions (user_id, token_hash, expires_at, request_ip_hash, user_agent_hash) VALUES ($1,$2,NOW() + INTERVAL '12 hours',$3,$4)",
    [user.id, hashSession(token), ipHash(req), hashText(req.get("user-agent") || "")]
  );
  setSessionCookie(res, token);
}
async function sendOtp(phone, purpose, req) {
  if (!process.env.TERMII_API_KEY) {
    const error = new Error("SMS verification is not configured. Add TERMII_API_KEY to the Render environment.");
    error.status = 503;
    throw error;
  }
  const client = await pool.connect();
  let challengeId;
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  try {
    await client.query("BEGIN");
    const recent = await client.query(
      "SELECT COUNT(*)::int AS count FROM pwfb_portal_otp_challenges WHERE phone_e164=$1 AND created_at > NOW() - INTERVAL '15 minutes'",
      [phone]
    );
    const recentIp = await client.query(
      "SELECT COUNT(*)::int AS count FROM pwfb_portal_otp_challenges WHERE request_ip_hash=$1 AND created_at > NOW() - INTERVAL '15 minutes'",
      [ipHash(req)]
    );
    if (recent.rows[0].count >= 3 || recentIp.rows[0].count >= 12) {
      await client.query("ROLLBACK");
      const error = new Error("Too many code requests. Please wait 15 minutes and try again.");
      error.status = 429;
      throw error;
    }
    await client.query(
      "UPDATE pwfb_portal_otp_challenges SET consumed_at=NOW() WHERE phone_e164=$1 AND purpose=$2 AND consumed_at IS NULL",
      [phone, purpose]
    );
    const inserted = await client.query(
      "INSERT INTO pwfb_portal_otp_challenges (phone_e164,purpose,otp_hash,expires_at,max_attempts,request_ip_hash) VALUES ($1,$2,$3,NOW() + INTERVAL '5 minutes',$4,$5) RETURNING id",
      [phone, purpose, hashText(phone + "|" + purpose + "|" + code), maxOtpAttempts, ipHash(req)]
    );
    challengeId = inserted.rows[0].id;
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
  const smsBody = {
    api_key: process.env.TERMII_API_KEY,
    to: phoneForTermii(phone),
    from: process.env.TERMII_SENDER_ID,
    sms: `Your PWFB Financial Portal verification code is ${code}. It expires in 5 minutes. Do not share this code.`,
    type: "plain",
    channel: process.env.TERMII_CHANNEL || "dnd"
  };
  try {
    const response = await fetch(process.env.TERMII_SMS_URL || "https://api.ng.termii.com/api/sms/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(smsBody),
      signal: AbortSignal.timeout(12000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || (typeof result.message === "string" && /fail|error|invalid/i.test(result.message)) || (result.code && !["ok", "200", 200].includes(result.code))) {
      throw new Error("SMS provider rejected the request");
    }
  } catch (error) {
    await pool.query("UPDATE pwfb_portal_otp_challenges SET consumed_at=NOW() WHERE id=$1", [challengeId]);
    console.error("Termii OTP delivery failed:", error.message);
    const wrapped = new Error("Could not send an SMS code. Check the Termii API key, sender ID, and account balance.");
    wrapped.status = 502;
    throw wrapped;
  }
}
async function verifyOtp(client, phone, purpose, code) {
  const found = await client.query(
    "SELECT id,otp_hash,expires_at,attempts,max_attempts FROM pwfb_portal_otp_challenges WHERE phone_e164=$1 AND purpose=$2 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    [phone, purpose]
  );
  const challenge = found.rows[0];
  if (!challenge || new Date(challenge.expires_at).getTime() <= Date.now() || challenge.attempts >= challenge.max_attempts) {
    if (challenge) await client.query("UPDATE pwfb_portal_otp_challenges SET consumed_at=NOW() WHERE id=$1", [challenge.id]);
    return { status: 400, message: "That code has expired. Request a new SMS code." };
  }
  const expected = challenge.otp_hash;
  const actual = hashText(phone + "|" + purpose + "|" + code);
  const ok = /^[0-9]{6}$/.test(String(code || "")) && crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
  if (!ok) {
    const attempts = challenge.attempts + 1;
    await client.query(
      "UPDATE pwfb_portal_otp_challenges SET attempts=$2, consumed_at=CASE WHEN $2 >= max_attempts THEN NOW() ELSE consumed_at END WHERE id=$1",
      [challenge.id, attempts]
    );
    return { status: 400, message: attempts >= challenge.max_attempts ? "Too many incorrect codes. Request a new code." : "The code is incorrect. Please try again." };
  }
  await client.query("UPDATE pwfb_portal_otp_challenges SET consumed_at=NOW() WHERE id=$1", [challenge.id]);
  return null;
}
async function authenticatedUser(req) {
  const token = readCookie(req, sessionCookie);
  if (!token) return null;
  const result = await pool.query(
    "SELECT u.id,u.full_name,u.phone_e164,u.role FROM pwfb_portal_sessions s JOIN pwfb_portal_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > NOW() AND u.disabled_at IS NULL LIMIT 1",
    [hashSession(token)]
  );
  return result.rows[0] || null;
}
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.get("/api/health", asyncRoute(async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true, service: "pwfb-financial-portal-api", neonAuthJwksConfigured: Boolean(neonAuthJwksUrl), smsConfigured: Boolean(process.env.TERMII_API_KEY && process.env.TERMII_SENDER_ID) });
}));


app.get("/admin-setup", asyncRoute(async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const count = await pool.query("SELECT COUNT(*)::int AS total FROM pwfb_portal_users");
  const available = count.rows[0].total === 0 && Boolean(process.env.PORTAL_BOOTSTRAP_TOKEN && process.env.PORTAL_BOOTSTRAP_TOKEN.length >= 32);
  res.status(available ? 200 : 404).type("html").send(available ? `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PWFB Financial Potal — Secure Admin Setup</title>
<style>body{font:16px system-ui;background:#f5f7fb;color:#182230;margin:0;display:grid;min-height:100vh;place-items:center}.card{background:white;width:min(92vw,430px);box-sizing:border-box;padding:28px;border-radius:18px;box-shadow:0 12px 40px #18223018}h1{font-size:24px;margin:0 0 8px}p{line-height:1.5;color:#586174}label{display:block;font-weight:600;margin:16px 0 6px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #cbd2dc;border-radius:9px;font:inherit}button{width:100%;margin-top:20px;background:#ed7625;color:#fff;border:0;border-radius:9px;padding:13px;font-weight:700;font-size:16px}#status{white-space:pre-wrap}</style>
<div class="card"><h1>First administrator setup</h1><p>One-time setup for the existing PWFB Financial Potal deployment. This page works only while no portal accounts exist. Choose a new strong password; do not reuse a password that may have been saved in a different database.</p>
<form id="setup"><label for="token">One-time setup token</label><input id="token" type="password" autocomplete="off" required minlength="32"><label for="name">Administrator full name</label><input id="name" required minlength="2" maxlength="100" autocomplete="name"><label for="password">New password (12+ characters)</label><input id="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password"><button id="submit" type="submit">Create administrator and sign in</button><p id="status" role="status"></p></form></div>
<script>
const form=document.querySelector("#setup"),status=document.querySelector("#status"),button=document.querySelector("#submit");
form.addEventListener("submit",async event=>{event.preventDefault();button.disabled=true;status.textContent="Setting up securely…";
try{const response=await fetch("/api/auth/bootstrap-admin",{method:"POST",headers:{"content-type":"application/json"},credentials:"same-origin",body:JSON.stringify({token:document.querySelector("#token").value,name:document.querySelector("#name").value,password:document.querySelector("#password").value})});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||"Setup failed.");status.textContent="Administrator created. Opening the Potal…";window.location.replace("/");}
catch(error){status.textContent=error.message;button.disabled=false;}});
</script></html>` : `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Setup unavailable</title><h1>Secure setup unavailable</h1><p>Initial setup is disabled because an account already exists or the one-time setup token is not configured. No account was changed.</p>`);
}));

app.post("/api/auth/bootstrap-admin", asyncRoute(async (req, res) => {
  res.set("Cache-Control", "no-store");
  const expectedToken = String(process.env.PORTAL_BOOTSTRAP_TOKEN || "");
  const suppliedToken = String(req.body?.token || "");
  const phone = normalizePhone(process.env.PORTAL_ADMIN_PHONE || "");
  const name = String(req.body?.name || "").trim().replace(/\s+/g, " ");
  const password = String(req.body?.password || "");
  if (expectedToken.length < 32 || suppliedToken.length !== expectedToken.length ||
      !crypto.timingSafeEqual(Buffer.from(suppliedToken), Buffer.from(expectedToken))) {
    return res.status(403).json({ error: "Setup token is invalid or not configured." });
  }
  if (!phone) return res.status(503).json({ error: "The configured administrator phone number is missing." });
  if (name.length < 2 || name.length > 100 || password.length < 12 || password.length > 128) {
    return res.status(400).json({ error: "Enter your full name and a new password between 12 and 128 characters." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(741920261013)");
    const count = await client.query("SELECT COUNT(*)::int AS total FROM pwfb_portal_users");
    if (count.rows[0].total !== 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Initial setup has already been used. No account was changed." });
    }
    const inserted = await client.query(
      "INSERT INTO pwfb_portal_users (phone_e164,full_name,pin_hash,role,phone_verified_at) VALUES ($1,$2,$3,'admin',NOW()) RETURNING id,full_name,phone_e164,role",
      [phone, name, hashPin(password)]
    );
    const user = inserted.rows[0];
    await issueSession(client, req, res, user);
    await client.query("COMMIT");
    console.info("Initial portal administrator created successfully.");
    return res.status(201).json({ ok: true, user: safeUser(user) });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    if (error.code === "23505") return res.status(409).json({ error: "An account already exists. Initial setup is no longer available." });
    throw error;
  } finally {
    client.release();
  }
}));

app.post("/api/auth/register/request", asyncRoute(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: "Enter a valid Nigerian phone number." });
  const adminPhone = normalizePhone(process.env.PORTAL_ADMIN_PHONE || "");
  if (!adminPhone || (phone !== adminPhone && process.env.PORTAL_ALLOW_REGISTRATION !== "true")) {
    return res.status(403).json({ error: "Registration is restricted. Contact your PWFB portal administrator." });
  }
  const existing = await pool.query("SELECT id FROM pwfb_portal_users WHERE phone_e164=$1", [phone]);
  if (existing.rowCount) return res.status(409).json({ error: "An account already exists for this phone number. Please log in." });
  await sendOtp(phone, "register", req);
  res.json({ ok: true, message: "If SMS delivery is available, a verification code has been sent. It expires in 5 minutes." });
}));

app.post("/api/auth/register/verify", asyncRoute(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const name = String(req.body?.name || "").trim().replace(/\s+/g, " ");
  const password = String(req.body?.password ?? req.body?.pin ?? "");
  const code = String(req.body?.code || "").trim();
  if (!phone || name.length < 2 || name.length > 100 || !validCredential(password) || !/^[0-9]{6}$/.test(code)) {
    return res.status(400).json({ error: "Enter your name, phone number, an 8+ character password or 6-digit PIN, and the 6-digit SMS code." });
  }
  const adminPhoneForRegistration = normalizePhone(process.env.PORTAL_ADMIN_PHONE || "");
  if (!adminPhoneForRegistration || (phone !== adminPhoneForRegistration && process.env.PORTAL_ALLOW_REGISTRATION !== "true")) {
    return res.status(403).json({ error: "Registration is restricted. Contact your PWFB portal administrator." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const otpError = await verifyOtp(client, phone, "register", code);
    if (otpError) { await client.query("COMMIT"); return res.status(otpError.status).json({ error: otpError.message }); }
    const adminPhone = normalizePhone(process.env.PORTAL_ADMIN_PHONE || "");
    const role = adminPhone && phone === adminPhone ? "admin" : "staff";
    const inserted = await client.query(
      "INSERT INTO pwfb_portal_users (phone_e164,full_name,pin_hash,role,phone_verified_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING id,full_name,phone_e164,role",
      [phone, name, hashPin(password), role]
    );
    const user = inserted.rows[0];
    await issueSession(client, req, res, user);
    await client.query("COMMIT");
    res.json({ ok: true, user: safeUser(user) });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    if (error.code === "23505") return res.status(409).json({ error: "An account already exists for this phone number." });
    throw error;
  } finally {
    client.release();
  }
}));

app.post("/api/auth/login/request", asyncRoute(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const password = String(req.body?.password ?? req.body?.pin ?? "");
  if (!phone || !validCredential(password)) return res.status(400).json({ error: "Enter your phone number and an 8+ character password or 6-digit PIN." });
  const result = await pool.query("SELECT id,full_name,phone_e164,pin_hash,role,disabled_at FROM pwfb_portal_users WHERE phone_e164=$1", [phone]);
  const user = result.rows[0];
  if (!user || user.disabled_at || !verifyPin(password, user.pin_hash)) {
    return res.status(401).json({ error: "Phone number or password is incorrect." });
  }
  await sendOtp(phone, "login", req);
  res.json({ ok: true, message: "A one-time login code has been sent by SMS." });
}));

app.post("/api/auth/login/verify", asyncRoute(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const code = String(req.body?.code || "").trim();
  if (!phone || !/^[0-9]{6}$/.test(code)) return res.status(400).json({ error: "Enter your phone number and 6-digit SMS code." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const otpError = await verifyOtp(client, phone, "login", code);
    if (otpError) { await client.query("COMMIT"); return res.status(otpError.status).json({ error: otpError.message }); }
    const result = await client.query(
      "SELECT id,full_name,phone_e164,role FROM pwfb_portal_users WHERE phone_e164=$1 AND disabled_at IS NULL FOR UPDATE",
      [phone]
    );
    const user = result.rows[0];
    if (!user) {
      await client.query("ROLLBACK");
      clearSessionCookie(res);
      return res.status(401).json({ error: "Account unavailable. Please register or contact an administrator." });
    }
    await issueSession(client, req, res, user);
    await client.query("COMMIT");
    res.json({ ok: true, user: safeUser(user) });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}));


app.post("/api/auth/password-reset/request", asyncRoute(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: "Enter a valid Nigerian phone number." });
  const result = await pool.query("SELECT id FROM pwfb_portal_users WHERE phone_e164=$1 AND disabled_at IS NULL", [phone]);
  // Avoid revealing whether a phone number has a portal account.
  if (result.rowCount) await sendOtp(phone, "login_reset", req);
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, message: "If an active account matches that number, a password reset code has been sent. The code expires in 5 minutes." });
}));

app.post("/api/auth/password-reset/verify", asyncRoute(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const code = String(req.body?.code || "").trim();
  const password = String(req.body?.password || "");
  if (!phone || !/^[0-9]{6}$/.test(code) || password.length < 8 || password.length > 128) {
    return res.status(400).json({ error: "Enter a valid phone number, 6-digit SMS code, and password between 8 and 128 characters." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const otpError = await verifyOtp(client, phone, "login_reset", code);
    if (otpError) { await client.query("COMMIT"); return res.status(otpError.status).json({ error: otpError.message }); }
    const result = await client.query(
      "SELECT id FROM pwfb_portal_users WHERE phone_e164=$1 AND disabled_at IS NULL FOR UPDATE",
      [phone]
    );
    const user = result.rows[0];
    if (!user) {
      await client.query("COMMIT");
      return res.status(400).json({ error: "Unable to reset this account. Request a new code or contact the portal administrator." });
    }
    await client.query("UPDATE pwfb_portal_users SET pin_hash=$2, updated_at=NOW() WHERE id=$1", [user.id, hashPin(password)]);
    await client.query("UPDATE pwfb_portal_sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL", [user.id]);
    await client.query("COMMIT");
    clearSessionCookie(res);
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, message: "Password updated. Please sign in with your new password." });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}));


app.post("/api/auth/neon-session", asyncRoute(async (req, res) => {
  res.set("Cache-Control", "no-store");
  const authorization = String(req.headers.authorization || "");
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token || !portalAdminEmail) return res.status(401).json({ error: "Neon email login is not configured for this portal." });
  let claims;
  try {
    const verified = await jwtVerify(token, neonJwks, { issuer: new URL(neonAuthBaseUrl).origin });
    claims = verified.payload;
  } catch {
    return res.status(401).json({ error: "Your Neon session could not be verified. Please sign in again." });
  }
  const subject = String(claims.sub || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(subject)) {
    return res.status(401).json({ error: "The Neon identity token is invalid." });
  }
  // Read the email and verification flag from Neon Auth's own database row, not client-supplied claims.
  const identityResult = await pool.query(
    'SELECT email, "emailVerified", COALESCE(banned,false) AS banned FROM neon_auth."user" WHERE id=$1 LIMIT 1',
    [subject]
  );
  const identity = identityResult.rows[0];
  if (!identity || identity.banned || !identity.emailVerified ||
      String(identity.email || "").trim().toLowerCase() !== portalAdminEmail) {
    return res.status(403).json({ error: "Use the verified administrator email configured for this portal." });
  }
  const result = await pool.query(
    "SELECT id,full_name,phone_e164,role FROM pwfb_portal_users WHERE role='admin' AND disabled_at IS NULL ORDER BY created_at ASC,id ASC LIMIT 1"
  );
  const user = result.rows[0];
  if (!user) return res.status(503).json({ error: "The existing administrator record was not found. No data was changed." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await issueSession(client, req, res, user);
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
  res.json({ ok: true, user: safeUser(user) });
}));

app.get("/api/auth/me", asyncRoute(async (req, res) => {
  const user = await authenticatedUser(req);
  if (!user) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, user: safeUser(user) });
}));

app.post("/api/auth/logout", asyncRoute(async (req, res) => {
  const token = readCookie(req, sessionCookie);
  if (token) await pool.query("UPDATE pwfb_portal_sessions SET revoked_at=NOW() WHERE token_hash=$1 AND revoked_at IS NULL", [hashSession(token)]);
  clearSessionCookie(res);
  res.json({ ok: true });
}));


app.get("/api/transport-salaries", asyncRoute(async (req, res) => {
  const user = await authenticatedUser(req);
  if (!user) return res.status(401).json({ error: "Please sign in to view salary entries." });
  const region = String(req.query.region || "").trim();
  if (!["DM 1", "DM 2"].includes(region)) return res.status(400).json({ error: "Choose a valid transport region." });
  const result = await pool.query(
    "SELECT staff_ref, monthly_salary::text AS monthly_salary, updated_at FROM pwfb_portal_transport_salaries WHERE region=$1 ORDER BY staff_ref",
    [region]
  );
  res.set("Cache-Control", "no-store");
  res.json({ salaries: result.rows });
}));
app.put("/api/transport-salaries", asyncRoute(async (req, res) => {
  const user = await authenticatedUser(req);
  if (!user) return res.status(401).json({ error: "Please sign in again before saving salary entries." });
  if (user.role !== "admin") return res.status(403).json({ error: "Only a portal administrator can change monthly salary entries." });
  const region = String(req.body?.region || "").trim();
  const staffRef = String(req.body?.staffRef || "").trim();
  const rawSalary = req.body?.monthlySalary;
  const monthlySalary = Number(rawSalary);
  if (!["DM 1", "DM 2"].includes(region) || !/^\d{3}$/.test(staffRef)) return res.status(400).json({ error: "Invalid region or staff reference." });
  if (rawSalary === "" || rawSalary === null || rawSalary === undefined || !Number.isFinite(monthlySalary) || monthlySalary < 0 || monthlySalary > 1000000000 || !/^\d{1,10}(\.\d{1,2})?$/.test(String(rawSalary))) {
    return res.status(400).json({ error: "Enter a valid monthly salary between ₦0.00 and ₦1,000,000,000.00." });
  }
  const result = await pool.query(
    "INSERT INTO pwfb_portal_transport_salaries (region, staff_ref, monthly_salary, updated_by, updated_at) VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT (region,staff_ref) DO UPDATE SET monthly_salary=EXCLUDED.monthly_salary, updated_by=EXCLUDED.updated_by, updated_at=NOW() RETURNING staff_ref, monthly_salary::text AS monthly_salary, updated_at",
    [region, staffRef, monthlySalary, user.id]
  );
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, salary: result.rows[0] });
}));


app.post("/api/transport-salaries/bulk", asyncRoute(async (req, res) => {
  const user = await authenticatedUser(req);
  if (!user) return res.status(401).json({ error: "Please sign in again before uploading salary entries." });
  if (user.role !== "admin") return res.status(403).json({ error: "Only a portal administrator can upload monthly salary entries." });
  const region = String(req.body?.region || "").trim();
  const salaries = req.body?.salaries;
  if (!["DM 1", "DM 2"].includes(region) || !Array.isArray(salaries) || salaries.length < 1 || salaries.length > 500) {
    return res.status(400).json({ error: "Choose a valid region and upload between 1 and 500 salary rows." });
  }
  const seen = new Set();
  for (const row of salaries) {
    const staffRef = String(row?.staffRef || "").trim();
    const rawSalary = String(row?.monthlySalary ?? "").trim();
    const amount = Number(rawSalary);
    if (!/^\d{3}$/.test(staffRef) || seen.has(staffRef)) return res.status(400).json({ error: "Every staff reference must be a unique three-digit reference." });
    if (!/^\d{1,10}(\.\d{1,2})?$/.test(rawSalary) || !Number.isFinite(amount) || amount < 0 || amount > 1000000000) return res.status(400).json({ error: "Every monthly salary must be a valid amount between ₦0.00 and ₦1,000,000,000.00." });
    seen.add(staffRef);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const saved = [];
    for (const row of salaries) {
      const result = await client.query(
        "INSERT INTO pwfb_portal_transport_salaries (region, staff_ref, monthly_salary, updated_by, updated_at) VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT (region,staff_ref) DO UPDATE SET monthly_salary=EXCLUDED.monthly_salary, updated_by=EXCLUDED.updated_by, updated_at=NOW() RETURNING staff_ref, monthly_salary::text AS monthly_salary, updated_at",
        [region, String(row.staffRef).trim(), Number(row.monthlySalary), user.id]
      );
      saved.push(result.rows[0]);
    }
    await client.query("COMMIT");
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, count: saved.length, salaries: saved });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}));

function payrollAdditionPayload(row) {
  return {
    id: String(row.id), month: row.month, region: row.region, branch: row.branch,
    name: row.name, gra: row.gra, gross: Number(row.gross), bonus: Number(row.bonus),
    coopS: Number(row.coopS), coopL: Number(row.coopL), dev: Number(row.dev),
    tax: Number(row.tax), offline: Number(row.offline), others: Number(row.others),
    advance: Number(row.advance), createdAt: row.createdAt
  };
}


function auditPayload(row){return {id:String(row.id),bankBalance:row.bank_balance===null?null:String(row.bank_balance),branch:row.branch,entryDate:row.entry_date,amount:row.amount===null?null:String(row.amount),charges:row.charges===null?null:String(row.charges),cashPaid:row.cash_paid===null?null:String(row.cash_paid),transferCode:row.transfer_code,excessBf:row.excess_bf===null?null:String(row.excess_bf),unconfirmed:row.unconfirmed===null?null:String(row.unconfirmed),currentExcess:row.current_excess===null?null:String(row.current_excess)}}
function auditInput(body){const branch=String(body?.branch||"").trim().replace(/\s+/g," ");const entryDate=String(body?.entryDate||"");if(branch.length<2||branch.length>160||!/^\d{4}-\d{2}-\d{2}$/.test(entryDate))throw Object.assign(new Error("Enter a branch name and valid date."),{status:400});const numeric={bankBalance:"bankBalance",amount:"amount",charges:"charges",cashPaid:"cashPaid",excessBf:"excessBf",unconfirmed:"unconfirmed",currentExcess:"currentExcess"};const values={};for(const [key] of Object.entries(numeric)){const raw=body?.[key];if(raw===null||raw===undefined||raw===""){values[key]=null;continue}const value=Number(raw);if(!Number.isFinite(value)||Math.abs(value)>999999999999.99)throw Object.assign(new Error("Enter valid amounts or leave unavailable amounts blank."),{status:400});values[key]=Math.round((value+Number.EPSILON)*100)/100}const transferCode=String(body?.transferCode||"").trim().slice(0,160);return {branch,entryDate,transferCode,...values}}
app.get("/api/audit-ledger",asyncRoute(async(_req,res)=>{const result=await pool.query("SELECT id,bank_balance,branch,entry_date,amount,charges,cash_paid,transfer_code,excess_bf,unconfirmed,current_excess FROM pwfb_portal_audit_ledger ORDER BY entry_date,id");res.set("Cache-Control","no-store");res.json({rows:result.rows.map(auditPayload)})}));
app.post("/api/audit-ledger",asyncRoute(async(req,res)=>{const actor=await authenticatedUser(req);if(!actor)return res.status(401).json({error:"Please sign in again."});if(actor.role!=="admin")return res.status(403).json({error:"Only a portal administrator can add audit entries."});const v=auditInput(req.body);const result=await pool.query("INSERT INTO pwfb_portal_audit_ledger(bank_balance,branch,entry_date,amount,charges,cash_paid,transfer_code,excess_bf,unconfirmed,current_excess,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING id,bank_balance,branch,entry_date,amount,charges,cash_paid,transfer_code,excess_bf,unconfirmed,current_excess",[v.bankBalance,v.branch,v.entryDate,v.amount,v.charges,v.cashPaid,v.transferCode,v.excessBf,v.unconfirmed,v.currentExcess,actor.id]);res.status(201).json({row:auditPayload(result.rows[0])})}));
app.put("/api/audit-ledger/:id",asyncRoute(async(req,res)=>{const actor=await authenticatedUser(req);if(!actor)return res.status(401).json({error:"Please sign in again."});if(actor.role!=="admin")return res.status(403).json({error:"Only a portal administrator can edit audit entries."});if(!/^\d+$/.test(String(req.params.id||"")))return res.status(400).json({error:"Invalid audit entry ID."});const v=auditInput(req.body);const result=await pool.query("UPDATE pwfb_portal_audit_ledger SET bank_balance=$2,branch=$3,entry_date=$4,amount=$5,charges=$6,cash_paid=$7,transfer_code=$8,excess_bf=$9,unconfirmed=$10,current_excess=$11,updated_by=$12,updated_at=NOW() WHERE id=$1 RETURNING id,bank_balance,branch,entry_date,amount,charges,cash_paid,transfer_code,excess_bf,unconfirmed,current_excess",[req.params.id,v.bankBalance,v.branch,v.entryDate,v.amount,v.charges,v.cashPaid,v.transferCode,v.excessBf,v.unconfirmed,v.currentExcess,actor.id]);if(!result.rowCount)return res.status(404).json({error:"Audit entry not found."});res.set("Cache-Control","no-store");res.json({row:auditPayload(result.rows[0])})}));
app.delete("/api/audit-ledger/:id",asyncRoute(async(req,res)=>{const actor=await authenticatedUser(req);if(!actor)return res.status(401).json({error:"Please sign in again."});if(actor.role!=="admin")return res.status(403).json({error:"Only a portal administrator can delete audit entries."});if(!/^\d+$/.test(String(req.params.id||"")))return res.status(400).json({error:"Invalid audit entry ID."});const result=await pool.query("DELETE FROM pwfb_portal_audit_ledger WHERE id=$1 RETURNING id",[req.params.id]);if(!result.rowCount)return res.status(404).json({error:"Audit entry not found."});res.set("Cache-Control","no-store");res.json({ok:true,deletedId:String(result.rows[0].id)})}));


const auditSheetCols=[["actualWorkDate","actual_work_date","date"],["auditDate","audit_date","date"],["openingBalance","opening_balance","number"],["bankBalance","bank_balance","number"],["expectingBranch","expecting_branch","text"],["expectingDate","expecting_date","text"],["expectingAmount","expecting_amount","number"],["chargesBranch","charges_branch","text"],["chargesAmount","charges_amount","number"],["cashPaidBranch","cash_paid_branch","text"],["cashPaidAmount","cash_paid_amount","number"],["transferBankCode","transfer_bank_code","text"],["transferAmount","transfer_amount","number"],["excessBfDate","excess_bf_date","text"],["excessBfAmount","excess_bf_amount","number"],["unconfirmedDate","unconfirmed_date","text"],["unconfirmedAmount","unconfirmed_amount","number"],["currentExcessDate","current_excess_date","text"],["currentExcessAmount","current_excess_amount","number"]];
function auditSheetPayload(row){const out={id:String(row.id)};for(const [key,col,type] of auditSheetCols)out[key]=type==="number"?(row[col]===null?null:String(row[col])):(row[col]||"");return out}
function auditSheetInput(body){const out={};for(const [key,,type] of auditSheetCols){const raw=body?.[key];if(type==="number"){if(raw===null||raw===undefined||raw===""){out[key]=null;continue}const n=Number(raw);if(!Number.isFinite(n)||Math.abs(n)>999999999999.99)throw Object.assign(new Error("Enter valid amounts or leave unavailable amounts blank."),{status:400});out[key]=Math.round((n+Number.EPSILON)*100)/100}else if(type==="date"){const v=String(raw??"");if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(v))throw Object.assign(new Error("Select valid work and audit dates."),{status:400});out[key]=v}else out[key]=String(raw??"").trim().slice(0,160)}return out}
app.get("/api/audit-sheet",asyncRoute(async(_req,res)=>{const q=await pool.query("SELECT * FROM pwfb_portal_audit_sheet_rows ORDER BY actual_work_date,COALESCE(source_row,2147483647),id");res.set("Cache-Control","no-store");res.json({rows:q.rows.map(auditSheetPayload)})}));
app.post("/api/audit-sheet",asyncRoute(async(req,res)=>{const actor=await authenticatedUser(req);if(!actor)return res.status(401).json({error:"Please sign in again."});if(actor.role!=="admin")return res.status(403).json({error:"Only a portal administrator can add audit rows."});const v=auditSheetInput(req.body),names=auditSheetCols.map(x=>x[1]),values=auditSheetCols.map(x=>v[x[0]]),p=values.map((_,i)=>"$"+(i+1));const q=await pool.query("INSERT INTO pwfb_portal_audit_sheet_rows("+names.join(",")+",created_by,updated_by) VALUES("+p.join(",")+",$"+(values.length+1)+",$"+(values.length+1)+") RETURNING *",[...values,actor.id]);res.status(201).json({row:auditSheetPayload(q.rows[0])})}));
app.put("/api/audit-sheet/:id",asyncRoute(async(req,res)=>{const actor=await authenticatedUser(req);if(!actor)return res.status(401).json({error:"Please sign in again."});if(actor.role!=="admin")return res.status(403).json({error:"Only a portal administrator can edit audit rows."});if(!/^\\d+$/.test(String(req.params.id||"")))return res.status(400).json({error:"Invalid audit row ID."});const v=auditSheetInput(req.body),values=auditSheetCols.map(x=>v[x[0]]),sets=auditSheetCols.map((x,i)=>x[1]+"=$"+(i+2));const q=await pool.query("UPDATE pwfb_portal_audit_sheet_rows SET "+sets.join(",")+",updated_by=$"+(values.length+2)+",updated_at=NOW() WHERE id=$1 RETURNING *",[req.params.id,...values,actor.id]);if(!q.rowCount)return res.status(404).json({error:"Audit row not found."});res.json({row:auditSheetPayload(q.rows[0])})}));
app.delete("/api/audit-sheet/:id",asyncRoute(async(req,res)=>{const actor=await authenticatedUser(req);if(!actor)return res.status(401).json({error:"Please sign in again."});if(actor.role!=="admin")return res.status(403).json({error:"Only a portal administrator can delete audit rows."});if(!/^\\d+$/.test(String(req.params.id||"")))return res.status(400).json({error:"Invalid audit row ID."});const q=await pool.query("DELETE FROM pwfb_portal_audit_sheet_rows WHERE id=$1 RETURNING id", [req.params.id]);if(!q.rowCount)return res.status(404).json({error:"Audit row not found."});res.json({ok:true,deletedId:String(q.rows[0].id)})}));

app.get("/api/payroll-additions", asyncRoute(async (req, res) => {
  const actor = await authenticatedUser(req);
  if (!actor) return res.status(401).json({ error: "Please sign in to view payroll additions." });
  const month = String(req.query.month || "").trim();
  if (month !== "September 2026") {
    return res.status(400).json({ error: "Only September 2026 monthly payroll is available." });
  }
  const result = await pool.query(
    `SELECT id, month, region, branch, name, gra, gross::text AS gross, bonus::text AS bonus,
      coop_s::text AS "coopS", coop_l::text AS "coopL", dev::text AS dev, tax::text AS tax,
      offline::text AS offline, others::text AS others, advance::text AS advance,
      created_at AS "createdAt"
     FROM pwfb_portal_payroll_additions WHERE month=$1 ORDER BY region, branch, id`,
    [month]
  );
  res.set("Cache-Control", "no-store");
  res.json({ staff: result.rows.map(payrollAdditionPayload) });
}));

app.post("/api/payroll-additions", asyncRoute(async (req, res) => {
  const actor = await authenticatedUser(req);
  if (!actor) return res.status(401).json({ error: "Please sign in again before adding payroll staff." });
  if (actor.role !== "admin") return res.status(403).json({ error: "Only a portal administrator can add payroll staff." });
  const month = String(req.body?.month || "").trim();
  const region = String(req.body?.region || "").trim();
  const branch = String(req.body?.branch || "").trim().replace(/\s+/g, " ").toUpperCase();
  const name = String(req.body?.name || "").trim().replace(/\s+/g, " ").toUpperCase();
  const gra = String(req.body?.gra || "").trim();
  if (month !== "September 2026") return res.status(400).json({ error: "Only September 2026 monthly payroll is available." });
  if (!["DM 1", "DM 2"].includes(region)) return res.status(400).json({ error: "Choose DM 1 or DM 2." });
  if (branch.length < 2 || branch.length > 100) return res.status(400).json({ error: "Enter a branch name between 2 and 100 characters." });
  if (name.length < 2 || name.length > 100) return res.status(400).json({ error: "Enter a staff name between 2 and 100 characters." });
  if (!gra || gra.length > 50) return res.status(400).json({ error: "Enter a GRA/reference value up to 50 characters." });
  const amountKeys = ["gross", "bonus", "coopS", "coopL", "offline", "others", "advance"];
  const amounts = {};
  for (const key of amountKeys) {
    const raw = req.body?.[key];
    const value = raw === "" || raw === null || raw === undefined ? NaN : Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 999999999999.99) {
      return res.status(400).json({ error: "Enter valid non-negative payroll amounts for all amount fields." });
    }
    amounts[key] = Math.round((value + Number.EPSILON) * 100) / 100;
  }
  const round5 = value => Math.round(value / 5) * 5;
  const dev = round5(amounts.gross * 0.025);
  const tax = round5(amounts.gross * 0.03);
  const result = await pool.query(
    `INSERT INTO pwfb_portal_payroll_additions
      (month, region, branch, name, gra, gross, bonus, coop_s, coop_l, dev, tax, offline, others, advance, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id, month, region, branch, name, gra, gross::text AS gross, bonus::text AS bonus,
       coop_s::text AS "coopS", coop_l::text AS "coopL", dev::text AS dev, tax::text AS tax,
       offline::text AS offline, others::text AS others, advance::text AS advance,
       created_at AS "createdAt"`,
    [month, region, branch, name, gra, amounts.gross, amounts.bonus, amounts.coopS, amounts.coopL, dev, tax, amounts.offline, amounts.others, amounts.advance, actor.id]
  );
  res.set("Cache-Control", "no-store");
  res.status(201).json({ ok: true, staff: payrollAdditionPayload(result.rows[0]) });
}));


// Edit or delete administrator-created payroll rows without changing original imported source rows.
app.put("/api/payroll-additions/:id", asyncRoute(async (req, res) => {
  const actor = await authenticatedUser(req);
  if (!actor) return res.status(401).json({ error: "Please sign in again before editing payroll." });
  if (actor.role !== "admin") return res.status(403).json({ error: "Only a portal administrator can edit payroll." });
  const id = String(req.params.id || "");
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: "Invalid payroll record ID." });
  const month = String(req.body?.month || "").trim();
  const region = String(req.body?.region || "").trim();
  const branch = String(req.body?.branch || "").trim().replace(/\s+/g, " ").toUpperCase();
  const name = String(req.body?.name || "").trim().replace(/\s+/g, " ").toUpperCase();
  const gra = String(req.body?.gra || "").trim();
  if (month !== "September 2026" || !["DM 1", "DM 2"].includes(region) || branch.length < 2 || name.length < 2 || !gra || gra.length > 50) return res.status(400).json({ error: "Enter valid month, division, branch, staff name and GRA." });
  const keys = ["gross", "bonus", "coopS", "coopL", "offline", "others", "advance"];
  const values = {};
  for (const key of keys) {
    const raw = req.body?.[key];
    const value = raw === "" || raw === null || raw === undefined ? NaN : Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 999999999999.99) return res.status(400).json({ error: "Enter valid non-negative payroll amounts." });
    values[key] = Math.round((value + Number.EPSILON) * 100) / 100;
  }
  const round5 = value => Math.round(value / 5) * 5;
  const dev = round5(values.gross * 0.025), tax = round5(values.gross * 0.03);
  const result = await pool.query(
    `UPDATE pwfb_portal_payroll_additions SET month=$2, region=$3, branch=$4, name=$5, gra=$6, gross=$7, bonus=$8, coop_s=$9, coop_l=$10, dev=$11, tax=$12, offline=$13, others=$14, advance=$15 WHERE id=$1 RETURNING id, month, region, branch, name, gra, gross::text AS gross, bonus::text AS bonus, coop_s::text AS "coopS", coop_l::text AS "coopL", dev::text AS dev, tax::text AS tax, offline::text AS offline, others::text AS others, advance::text AS advance, created_at AS "createdAt"`,
    [id, month, region, branch, name, gra, values.gross, values.bonus, values.coopS, values.coopL, dev, tax, values.offline, values.others, values.advance]
  );
  if (!result.rowCount) return res.status(404).json({ error: "Payroll row was not found. No record was changed." });
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, staff: payrollAdditionPayload(result.rows[0]) });
}));

app.delete("/api/payroll-additions/:id", asyncRoute(async (req, res) => {
  const actor = await authenticatedUser(req);
  if (!actor) return res.status(401).json({ error: "Please sign in again before deleting payroll." });
  if (actor.role !== "admin") return res.status(403).json({ error: "Only a portal administrator can delete payroll." });
  const id = String(req.params.id || "");
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: "Invalid payroll record ID." });
  const result = await pool.query("DELETE FROM pwfb_portal_payroll_additions WHERE id=$1 RETURNING id", [id]);
  if (!result.rowCount) return res.status(404).json({ error: "Payroll row was not found. No record was deleted." });
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, deletedId: String(result.rows[0].id) });
}));

app.get("/api/admin/staff", asyncRoute(async (req, res) => {
  const actor = await authenticatedUser(req);
  if (!actor) return res.status(401).json({ error: "Please sign in again." });
  if (actor.role !== "admin") return res.status(403).json({ error: "Administrator access is required." });
  const result = await pool.query(
    "SELECT id,full_name,phone_e164,role,created_at,disabled_at FROM pwfb_portal_users ORDER BY created_at DESC,id DESC LIMIT 500"
  );
  res.set("Cache-Control", "no-store");
  res.json({ staff: result.rows.map(row => ({
    id: row.id, name: row.full_name, phone: row.phone_e164, role: row.role,
    createdAt: row.created_at, disabled: Boolean(row.disabled_at)
  })) });
}));

app.post("/api/admin/staff", asyncRoute(async (req, res) => {
  const actor = await authenticatedUser(req);
  if (!actor) return res.status(401).json({ error: "Please sign in again." });
  if (actor.role !== "admin") return res.status(403).json({ error: "Administrator access is required." });
  const name = String(req.body?.name || "").trim().replace(/\s+/g, " ");
  const phone = normalizePhone(req.body?.phone);
  const password = String(req.body?.password || "");
  const requestedRole = String(req.body?.role || "staff");
  const role = ["staff", "viewer", "RM1", "RM2"].includes(requestedRole) ? requestedRole : "staff";
  if (name.length < 2 || name.length > 100) return res.status(400).json({ error: "Enter a staff name between 2 and 100 characters." });
  if (!phone) return res.status(400).json({ error: "Enter a valid Nigerian phone number." });
  if (!validCredential(password)) return res.status(400).json({ error: "Use exactly a 6-digit PIN or an 8–128 character password." });
  try {
    const result = await pool.query(
      "INSERT INTO pwfb_portal_users (phone_e164,full_name,pin_hash,role,phone_verified_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING id,full_name,phone_e164,role,created_at",
      [phone, name, hashPin(password), role]
    );
    const row = result.rows[0];
    res.status(201).json({ ok: true, staff: {
      id: row.id, name: row.full_name, phone: row.phone_e164, role: row.role, createdAt: row.created_at
    }, message: "Staff account created. They must complete SMS verification when signing in." });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "An account already exists for that phone number." });
    throw error;
  }
}));


app.get("/api/transport-roster", asyncRoute(async (req, res) => {
  const user = await authenticatedUser(req);
  if (!user) return res.status(401).json({ error: "Please sign in to view the transport roster." });
  const region = String(req.query.region || "").trim();
  if (region && !["DM 1", "DM 2"].includes(region)) return res.status(400).json({ error: "Choose a valid transport division." });
  const result = await pool.query(
    "SELECT region, staff_ref, payload, is_deleted, is_added, updated_at FROM pwfb_portal_transport_roster WHERE ($1 = '' OR region = $1) ORDER BY region, staff_ref",
    [region]
  );
  res.set("Cache-Control", "no-store");
  res.json({ records: result.rows.map(row => ({ ...row.payload, region: row.region, staffRef: row.staff_ref, deleted: row.is_deleted, isAdded: row.is_added, updatedAt: row.updated_at })) });
}));

function validateTransportRecord(input, region, staffRef) {
  const name = String(input?.name || "").trim().slice(0, 120);
  const bank = String(input?.bank || "").trim().slice(0, 100);
  const code = String(input?.code || "").trim().slice(0, 12);
  const acc = String(input?.acc || "").trim().slice(0, 34);
  const narration = String(input?.narration || "").trim().slice(0, 120);
  const rawAmount = String(input?.amount ?? "").trim();
  const amount = Number(rawAmount);
  if (!["DM 1", "DM 2"].includes(region) || !/^\d{3}$/.test(staffRef)) throw Object.assign(new Error("Invalid division or three-digit staff reference."), { status: 400 });
  if (!name || !bank || !code || !acc || !narration) throw Object.assign(new Error("Complete staff name, bank code, destination bank, account number, and branch/narration."), { status: 400 });
  if (!/^\d{1,12}$/.test(code)) throw Object.assign(new Error("Bank code must contain digits only. Use VERIFY in the schedule for an unconfirmed code, not a guessed code."), { status: 400 });
  if (!/^\d{1,34}$/.test(acc)) throw Object.assign(new Error("Account number must contain digits only."), { status: 400 });
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(rawAmount) || !Number.isFinite(amount) || amount < 0 || amount > 1000000000) throw Object.assign(new Error("Enter a valid transport amount from ₦0 to ₦1,000,000,000."), { status: 400 });
  return { region, ref: staffRef, code, bank, acc, name, amount, narration };
}

app.post("/api/transport-roster", asyncRoute(async (req, res) => {
  const user = await authenticatedUser(req);
  if (!user) return res.status(401).json({ error: "Please sign in again before adding staff." });
  if (user.role !== "admin") return res.status(403).json({ error: "Only a portal administrator can add transport staff." });
  const region = String(req.body?.region || "").trim();
  const staffRef = String(req.body?.staffRef || "").trim();
  let payload;
  try { payload = validateTransportRecord(req.body?.record, region, staffRef); }
  catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
  try {
    const result = await pool.query(
      "INSERT INTO pwfb_portal_transport_roster (region, staff_ref, payload, is_deleted, is_added, updated_by, updated_at) VALUES ($1,$2,$3::jsonb,FALSE,TRUE,$4,NOW()) RETURNING region, staff_ref, payload, is_deleted, is_added, updated_at",
      [region, staffRef, JSON.stringify(payload), user.id]
    );
    const row = result.rows[0];
    res.status(201).json({ ok: true, record: { ...row.payload, region: row.region, staffRef: row.staff_ref, deleted: row.is_deleted, isAdded: row.is_added, updatedAt: row.updated_at } });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "That staff reference already exists in this division. Refresh the roster and try again." });
    throw error;
  }
}));

app.put("/api/transport-roster", asyncRoute(async (req, res) => {
  const user = await authenticatedUser(req);
  if (!user) return res.status(401).json({ error: "Please sign in again before editing staff." });
  if (user.role !== "admin") return res.status(403).json({ error: "Only a portal administrator can edit transport staff." });
  const region = String(req.body?.region || "").trim();
  const staffRef = String(req.body?.staffRef || "").trim();
  let payload;
  try { payload = validateTransportRecord(req.body?.record, region, staffRef); }
  catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
  const isAdded = req.body?.isAdded === true;
  const result = await pool.query(
    "INSERT INTO pwfb_portal_transport_roster (region, staff_ref, payload, is_deleted, is_added, updated_by, updated_at) VALUES ($1,$2,$3::jsonb,FALSE,$4,$5,NOW()) ON CONFLICT (region,staff_ref) DO UPDATE SET payload=EXCLUDED.payload, is_deleted=FALSE, is_added=EXCLUDED.is_added, updated_by=EXCLUDED.updated_by, updated_at=NOW() RETURNING region, staff_ref, payload, is_deleted, is_added, updated_at",
    [region, staffRef, JSON.stringify(payload), isAdded, user.id]
  );
  const row = result.rows[0];
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, record: { ...row.payload, region: row.region, staffRef: row.staff_ref, deleted: row.is_deleted, isAdded: row.is_added, updatedAt: row.updated_at } });
}));

app.delete("/api/transport-roster", asyncRoute(async (req, res) => {
  const user = await authenticatedUser(req);
  if (!user) return res.status(401).json({ error: "Please sign in again before deleting staff." });
  if (user.role !== "admin") return res.status(403).json({ error: "Only a portal administrator can delete transport staff." });
  const region = String(req.body?.region || "").trim();
  const staffRef = String(req.body?.staffRef || "").trim();
  if (!["DM 1", "DM 2"].includes(region) || !/^\d{3}$/.test(staffRef)) return res.status(400).json({ error: "Invalid division or staff reference." });
  const result = await pool.query(
    "INSERT INTO pwfb_portal_transport_roster (region, staff_ref, payload, is_deleted, is_added, updated_by, updated_at) VALUES ($1,$2,'{}'::jsonb,TRUE,$3,$4,NOW()) ON CONFLICT (region,staff_ref) DO UPDATE SET is_deleted=TRUE, updated_by=EXCLUDED.updated_by, updated_at=NOW() RETURNING region, staff_ref, is_deleted",
    [region, staffRef, req.body?.isAdded === true, user.id]
  );
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, deleted: true, region: result.rows[0].region, staffRef: result.rows[0].staff_ref });
}));

app.use("/api", (_req, res) => res.status(404).json({ error: "API endpoint not found." }));

app.use(express.static(path.join(__dirname, "dist"), { index: false, maxAge: "1h" }));
app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});
app.use((error, _req, res, _next) => {
  if (error.status && error.status < 500) return res.status(error.status).json({ error: error.message });
  console.error("Portal API error:", error.message);
  res.status(500).json({ error: "The request could not be completed. Please try again." });
});

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pwfb_portal_users (
      id BIGSERIAL PRIMARY KEY,
      phone_e164 TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL DEFAULT '',
      pin_hash TEXT,
      role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin','staff','viewer','RM1','RM2')),
      phone_verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      disabled_at TIMESTAMPTZ
    );
    ALTER TABLE pwfb_portal_users ADD COLUMN IF NOT EXISTS full_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE pwfb_portal_users DROP CONSTRAINT IF EXISTS pwfb_portal_users_role_check;
    ALTER TABLE pwfb_portal_users ADD CONSTRAINT pwfb_portal_users_role_check CHECK (role IN ('admin','staff','viewer','RM1','RM2'));
    CREATE TABLE IF NOT EXISTS pwfb_portal_otp_challenges (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      phone_e164 TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('register','login_reset','login')),
      otp_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      request_ip_hash TEXT
    );
    ALTER TABLE pwfb_portal_otp_challenges DROP CONSTRAINT IF EXISTS pwfb_portal_otp_challenges_purpose_check;
    ALTER TABLE pwfb_portal_otp_challenges ADD CONSTRAINT pwfb_portal_otp_challenges_purpose_check CHECK (purpose IN ('register','login_reset','login'));
    CREATE INDEX IF NOT EXISTS pwfb_portal_otp_phone_created_idx ON pwfb_portal_otp_challenges (phone_e164, created_at DESC);
    CREATE INDEX IF NOT EXISTS pwfb_portal_otp_expiry_idx ON pwfb_portal_otp_challenges (expires_at);
    CREATE TABLE IF NOT EXISTS pwfb_portal_sessions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES pwfb_portal_users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ,
      request_ip_hash TEXT,
      user_agent_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS pwfb_portal_sessions_user_idx ON pwfb_portal_sessions (user_id, expires_at DESC);
    CREATE TABLE IF NOT EXISTS pwfb_portal_transport_salaries (
      region TEXT NOT NULL CHECK (region IN ('DM 1','DM 2')),
      staff_ref TEXT NOT NULL CHECK (staff_ref ~ '^[0-9]{3}$'),
      monthly_salary NUMERIC(14,2) NOT NULL CHECK (monthly_salary >= 0),
      updated_by BIGINT REFERENCES pwfb_portal_users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (region, staff_ref)
    );
    CREATE TABLE IF NOT EXISTS pwfb_portal_transport_roster (
      region TEXT NOT NULL CHECK (region IN ('DM 1','DM 2')),
      staff_ref TEXT NOT NULL CHECK (staff_ref ~ '^[0-9]{3}$'),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
      is_added BOOLEAN NOT NULL DEFAULT FALSE,
      updated_by BIGINT REFERENCES pwfb_portal_users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (region, staff_ref)
    );
    CREATE INDEX IF NOT EXISTS pwfb_portal_transport_roster_updated_idx
      ON pwfb_portal_transport_roster (updated_at DESC);

    CREATE TABLE IF NOT EXISTS pwfb_portal_audit_ledger (
      id BIGSERIAL PRIMARY KEY,
      bank_balance NUMERIC(16,2),
      branch TEXT NOT NULL,
      entry_date DATE NOT NULL,
      amount NUMERIC(16,2),
      charges NUMERIC(16,2),
      cash_paid NUMERIC(16,2),
      transfer_code TEXT NOT NULL DEFAULT '',
      excess_bf NUMERIC(16,2),
      unconfirmed NUMERIC(16,2),
      current_excess NUMERIC(16,2),
      created_by BIGINT REFERENCES pwfb_portal_users(id) ON DELETE SET NULL,
      updated_by BIGINT REFERENCES pwfb_portal_users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS pwfb_portal_audit_ledger_date_idx ON pwfb_portal_audit_ledger(entry_date,id);

CREATE TABLE IF NOT EXISTS pwfb_portal_audit_sheet_rows (
 id BIGSERIAL PRIMARY KEY, source_row INTEGER UNIQUE,
 bank_balance NUMERIC(16,2), expecting_branch TEXT NOT NULL DEFAULT '', expecting_date TEXT NOT NULL DEFAULT '', expecting_amount NUMERIC(16,2),
 charges_branch TEXT NOT NULL DEFAULT '', charges_amount NUMERIC(16,2), cash_paid_branch TEXT NOT NULL DEFAULT '', cash_paid_amount NUMERIC(16,2),
 transfer_bank_code TEXT NOT NULL DEFAULT '', transfer_amount NUMERIC(16,2), excess_bf_date TEXT NOT NULL DEFAULT '', excess_bf_amount NUMERIC(16,2),
 unconfirmed_date TEXT NOT NULL DEFAULT '', unconfirmed_amount NUMERIC(16,2), current_excess_date TEXT NOT NULL DEFAULT '', current_excess_amount NUMERIC(16,2),
 created_by BIGINT REFERENCES pwfb_portal_users(id) ON DELETE SET NULL, updated_by BIGINT REFERENCES pwfb_portal_users(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE pwfb_portal_audit_sheet_rows ADD COLUMN IF NOT EXISTS actual_work_date DATE NOT NULL DEFAULT '2026-11-06';
ALTER TABLE pwfb_portal_audit_sheet_rows ADD COLUMN IF NOT EXISTS audit_date DATE NOT NULL DEFAULT '2026-11-09';
ALTER TABLE pwfb_portal_audit_sheet_rows ADD COLUMN IF NOT EXISTS opening_balance NUMERIC(16,2) NOT NULL DEFAULT 46172107.40;
INSERT INTO pwfb_portal_audit_sheet_rows(source_row,bank_balance,expecting_branch,expecting_date,expecting_amount,charges_branch,charges_amount,cash_paid_branch,cash_paid_amount,transfer_bank_code,transfer_amount,excess_bf_date,excess_bf_amount,unconfirmed_date,unconfirmed_amount,current_excess_date,current_excess_amount)
VALUES (1,58307.6,'Moniya 2','',50000,'Dugbe',9000,'',NULL,'',100800,'',55000,'',64500,'',19500),
(2,NULL,'Adeoyo','',90000,'Iwo Rd',5000,'',NULL,'',58500,'',126000,'',38800,'',40500),
(3,NULL,'Moniya 3','',114600,'',NULL,'',14000,'',11000,'',135000,'',990,'',17500),
(4,NULL,'Olorunsogo','',136200,'',NULL,'',NULL,'',10000000,'',15100,'',990,'',19500),
(5,NULL,'Ajibode','',15000,'',NULL,'',NULL,'',525100,'',11000,'',90000,'',1000),
(6,NULL,'Awotan','',158700,'',NULL,'',NULL,'',18536500,'',82000,'',69200,'',150000),
(7,NULL,'N.I.G','',58700,'',NULL,'',NULL,'',2960500,'',41000,'',98500,'',42000),
(8,NULL,'Akobo 2','',80115,'',NULL,'',NULL,'',23752000,'',83000,'',90000,'',14900),
(9,NULL,'Moniya 1','',190000,'',NULL,'',NULL,'',NULL,'',35000,'',3000,'',196100),
(10,NULL,'Bodija 1','',167000,'',NULL,'',NULL,'',NULL,'',25100,'',150000,'',39100),
(11,NULL,'Sabo 2','',38440,'',NULL,'',NULL,'',NULL,'',3279100,'',20000,'',17000),
(12,NULL,'Olugi','',14500,'',NULL,'',NULL,'',NULL,'',NULL,'',48000,'',15400),
(13,NULL,'Bodija 2','',59900,'',NULL,'',NULL,'',NULL,'',NULL,'',NULL,'',15000),
(14,NULL,'Tede','',82000,'',NULL,'',NULL,'',NULL,'',NULL,'',NULL,'',16000),
(15,NULL,'Sango 2','',74500,'',NULL,'',NULL,'',NULL,'',NULL,'',NULL,'',410),
(16,NULL,'','',NULL,'',NULL,'',NULL,'',NULL,'',NULL,'',NULL,'',80000),
(17,NULL,'','',NULL,'',NULL,'',NULL,'',NULL,'',NULL,'',NULL,'',55000),
(18,NULL,'','',NULL,'',NULL,'',NULL,'',NULL,'',NULL,'',NULL,'',9700),
(19,NULL,'','',NULL,'',NULL,'',NULL,'',NULL,'',NULL,'',NULL,'',5100),
(20,NULL,'','',NULL,'',NULL,'',NULL,'',NULL,'',NULL,'',NULL,'',92000),
(21,NULL,'','',NULL,'',NULL,'',NULL,'',NULL,'',NULL,'',NULL,'',32100),
(22,NULL,'','',NULL,'',NULL,'',NULL,'',NULL,'',NULL,'',NULL,'',60899) ON CONFLICT(source_row) DO NOTHING;

    INSERT INTO pwfb_portal_audit_sheet_rows(source_row,actual_work_date,audit_date,opening_balance,bank_balance,expecting_branch,expecting_date,expecting_amount,charges_branch,charges_amount,cash_paid_branch,cash_paid_amount,transfer_bank_code,transfer_amount,excess_bf_date,excess_bf_amount,unconfirmed_date,unconfirmed_amount,current_excess_date,current_excess_amount) VALUES
(1001,'2026-11-05','2026-11-06',19430655.83,'58255.83','Iwo Road 2','','90000','','','Iwo Road 1','7000','FCMB','19990','','900','','64500','','90000'),
(1002,'2026-11-05','2026-11-06',19430655.83,NULL,'Moniya 2','','85500','','','','20000','GTB','522000','','55800','','38800','','26000'),
(1003,'2026-11-05','2026-11-06',19430655.83,NULL,'Adeoyo','','10000','','','',NULL,'FCMB','33640','','233500','','990','','300000'),
(1004,'2026-11-05','2026-11-06',19430655.83,NULL,'Ayete','','85300','','','',NULL,'FCMB','20200','','70900','','990','','15000'),
(1005,'2026-11-05','2026-11-06',19430655.83,NULL,'Adeoyo','','70000','','','',NULL,'','','','3600','','90000','','11000'),
(1006,'2026-11-05','2026-11-06',19430655.83,NULL,'Iwo Road','','363000','','','',NULL,'','','','58400','','69200','','3000'),
(1007,'2026-11-05','2026-11-06',19430655.83,NULL,'Akobo 2','','242000','','','',NULL,'','','','5263333','','98500','','15000'),
(1008,'2026-11-05','2026-11-06',19430655.83,NULL,'N.I.G','','502300','','','',NULL,'','','','596000','','70000','Status: Fail','8000'),
(1009,'2026-11-05','2026-11-06',19430655.83,NULL,'Amuloko','','20000','','','',NULL,'','','','5000','','70000','Sango 2','41000'),
(1010,'2026-11-05','2026-11-06',19430655.83,NULL,'Awotan','','436000','','','',NULL,'','','','25000','','55000','','83000'),
(1011,'2026-11-05','2026-11-06',19430655.83,NULL,'Iwo Road 1','','73000','','','',NULL,'','','','73100','','','','35000'),
(1012,'2026-11-05','2026-11-06',19430655.83,NULL,'Ilangale','','51000','','','',NULL,'','','','28000','','','','20000'),
(1013,'2026-11-05','2026-11-06',19430655.83,NULL,'Bodija 1','','89200','','','',NULL,'','','','16000','','','','25100'),
(1014,'2026-11-05','2026-11-06',19430655.83,NULL,'Bodija 2','','534400','','','',NULL,'','','','19200','','','','3617500'),
(1015,'2026-11-05','2026-11-06',19430655.83,NULL,'Olugi','','15600','','','',NULL,'','','','15000','','','',NULL),
(1016,'2026-11-05','2026-11-06',19430655.83,NULL,'Iwo Rd 2','','27800','','','',NULL,'','','','3500','','','',NULL),
(1017,'2026-11-05','2026-11-06',19430655.83,NULL,'Sango 2','','179900','','','',NULL,'','','','11000','','','',NULL),
(1018,'2026-11-05','2026-11-06',19430655.83,NULL,'Tede','','56000','','','',NULL,'','','','5200','','','',NULL),
(1019,'2026-11-05','2026-11-06',19430655.83,NULL,'','',NULL,'','','',NULL,'','','','20000','','','',NULL),
(1020,'2026-11-05','2026-11-06',19430655.83,NULL,'','',NULL,'','','',NULL,'','','','3900','','','',NULL),
(1021,'2026-11-05','2026-11-06',19430655.83,NULL,'','',NULL,'','','',NULL,'','','','20000','','','',NULL),
(1022,'2026-11-05','2026-11-06',19430655.83,NULL,'','',NULL,'','','',NULL,'','','','10000','','','',NULL),
(1023,'2026-11-05','2026-11-06',19430655.83,NULL,'','',NULL,'','','',NULL,'','','','8000','','','',NULL),
(1024,'2026-11-05','2026-11-06',19430655.83,NULL,'','',NULL,'','','',NULL,'','','','10000','','','',NULL),
(1025,'2026-11-05','2026-11-06',19430655.83,NULL,'','',NULL,'','','',NULL,'','','','100','','','',NULL),
(1026,'2026-11-05','2026-11-06',19430655.83,NULL,'','',NULL,'','','',NULL,'','','','8200','','','',NULL),
(1027,'2026-11-05','2026-11-06',19430655.83,NULL,'','',NULL,'','','',NULL,'','','','1100','','','',NULL),
(1028,'2026-11-05','2026-11-06',19430655.83,NULL,'','',NULL,'','','',NULL,'','','','300','','','',NULL),
(1029,'2026-11-05','2026-11-06',19430655.83,NULL,'','',NULL,'','','',NULL,'','','','21400','','','',NULL)
ON CONFLICT(source_row) DO NOTHING;

CREATE TABLE IF NOT EXISTS pwfb_portal_payroll_additions (
      id BIGSERIAL PRIMARY KEY,
      month TEXT NOT NULL CHECK (month IN ('August 2026','September 2026')),
      region TEXT NOT NULL CHECK (region IN ('DM 1','DM 2')),
      branch TEXT NOT NULL,
      name TEXT NOT NULL,
      gra TEXT NOT NULL,
      gross NUMERIC(14,2) NOT NULL CHECK (gross >= 0),
      bonus NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (bonus >= 0),
      coop_s NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (coop_s >= 0),
      coop_l NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (coop_l >= 0),
      dev NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (dev >= 0),
      tax NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tax >= 0),
      offline NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (offline >= 0),
      others NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (others >= 0),
      advance NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (advance >= 0),
      created_by BIGINT REFERENCES pwfb_portal_users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS pwfb_portal_payroll_additions_month_idx
      ON pwfb_portal_payroll_additions (month, region, branch, id);
  `);
  const configuredAdminPhone = normalizePhone(process.env.PORTAL_ADMIN_PHONE || "");
  if (configuredAdminPhone) {
    await pool.query("UPDATE pwfb_portal_users SET role = 'admin', updated_at = NOW() WHERE phone_e164 = $1 AND disabled_at IS NULL", [configuredAdminPhone]);
  }
  app.listen(port, "0.0.0.0", () => console.log(`PWFB Financial Portal listening on ${port}`));
}
start().catch(error => { console.error("Startup failed:", error); process.exit(1); });
