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

app.get("/api/payroll-additions", asyncRoute(async (req, res) => {
  const actor = await authenticatedUser(req);
  if (!actor) return res.status(401).json({ error: "Please sign in to view payroll additions." });
  const month = String(req.query.month || "").trim();
  if (!["August 2026", "September 2026"].includes(month)) {
    return res.status(400).json({ error: "Choose August 2026 or September 2026." });
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
  if (!["August 2026", "September 2026"].includes(month)) return res.status(400).json({ error: "Choose August 2026 or September 2026." });
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
  const role = req.body?.role === "viewer" ? "viewer" : "staff";
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
      role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin','staff','viewer')),
      phone_verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      disabled_at TIMESTAMPTZ
    );
    ALTER TABLE pwfb_portal_users ADD COLUMN IF NOT EXISTS full_name TEXT NOT NULL DEFAULT '';
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
