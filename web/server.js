import crypto from "node:crypto";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 10000);
const databaseUrl = process.env.DATABASE_URL;
const sessionSecret = process.env.SESSION_SECRET;
const otpPepper = process.env.OTP_PEPPER || sessionSecret;
const sessionCookie = "pwfb_portal_session";
const sessionHours = 12;
const otpMinutes = 5;
const maxOtpAttempts = 5;

if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!sessionSecret || sessionSecret.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters");
if (!process.env.TERMII_API_KEY) console.warn("TERMII_API_KEY is not set; OTP delivery is disabled.");

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
function validPin(pin) { return /^\d{4,8}$/.test(String(pin || "")); }
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
    from: process.env.TERMII_SENDER_ID || "N-Alert",
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
    if (!response.ok || result.code === "ok" && result.message?.toLowerCase().includes("fail")) {
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
  res.json({ ok: true, service: "pwfb-financial-portal-api" });
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
  const pin = String(req.body?.pin || "");
  const code = String(req.body?.code || "").trim();
  if (!phone || name.length < 2 || name.length > 100 || !validPin(pin) || !/^[0-9]{6}$/.test(code)) {
    return res.status(400).json({ error: "Enter your name, valid phone number, 4–8 digit PIN, and 6-digit SMS code." });
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
      [phone, name, hashPin(pin), role]
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
  const pin = String(req.body?.pin || "");
  if (!phone || !validPin(pin)) return res.status(400).json({ error: "Enter your phone number and 4–8 digit PIN." });
  const result = await pool.query("SELECT id,full_name,phone_e164,pin_hash,role,disabled_at FROM pwfb_portal_users WHERE phone_e164=$1", [phone]);
  const user = result.rows[0];
  if (!user || user.disabled_at || !verifyPin(pin, user.pin_hash)) {
    return res.status(401).json({ error: "Phone number or PIN is incorrect." });
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
  `);
  app.listen(port, "0.0.0.0", () => console.log(`PWFB Financial Portal listening on ${port}`));
}
start().catch(error => { console.error("Startup failed:", error); process.exit(1); });
