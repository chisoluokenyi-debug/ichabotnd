const express = require("express");
const helmet = require("helmet");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;
// Launch offer and conservative application-side spend ceiling.
const FREE_VIDEO_LIMIT_PER_CUSTOMER = 2;
const FREE_VIDEO_POLICY = "lifetime";
const MONTHLY_AI_BUDGET_NGN = 4000;
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
// First-party random device token: no canvas, browser fingerprint, or phone number.
app.use((req, res, next) => {
  const cookies = req.headers.cookie || "";
  const match = cookies.match(/(?:^|;\s*)icha_device=([^;]+)/);
  let token = match ? decodeURIComponent(match[1]) : "";
  if (!/^[a-f0-9]{64}$/.test(token)) {
    token = crypto.randomBytes(32).toString("hex");
    res.cookie("icha_device", token, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 365 * 24 * 60 * 60 * 1000 });
  }
  req.ichaDeviceToken = token;
  next();
});
app.use(express.json({ limit: "1mb", verify(req, _res, buffer) { if (req.originalUrl.startsWith("/api/paystack/webhook")) req.rawBody = Buffer.from(buffer); } }));
app.use(express.static(path.join(__dirname, "public")));


// Idempotently provision a separate customer-profile table. The existing
// "customers" table is left untouched because it contains auth/token fields.
async function ensureCustomerProfileTable() {
  const required = ["APPWRITE_ENDPOINT", "APPWRITE_PROJECT_ID", "APPWRITE_DATABASE_ID", "APPWRITE_API_KEY"];
  if (required.some((name) => !process.env[name])) {
    console.warn("Appwrite profile table setup skipped: required configuration is missing.");
    return;
  }

  let endpoint = process.env.APPWRITE_ENDPOINT.trim();
  while (endpoint.endsWith("/")) endpoint = endpoint.slice(0, -1);
  if (!endpoint.toLowerCase().endsWith("/v1")) endpoint += "/v1";

  const databaseId = encodeURIComponent(process.env.APPWRITE_DATABASE_ID);
  const tableId = "icha_customer_profiles";
  const headers = {
    "X-Appwrite-Project": process.env.APPWRITE_PROJECT_ID,
    "X-Appwrite-Key": process.env.APPWRITE_API_KEY,
    "Content-Type": "application/json"
  };
  const tableUrl = `${endpoint}/tablesdb/${databaseId}/tables/${tableId}`;

  try {
    const existing = await fetch(tableUrl, {
      headers,
      signal: AbortSignal.timeout(10000)
    });
    if (existing.ok) {
      console.log("Appwrite customer profile table already exists.");
      return;
    }
    if (existing.status !== 404) {
      console.error("Appwrite profile table check failed with HTTP " + existing.status + ".");
      return;
    }

    const created = await fetch(`${endpoint}/tablesdb/${databaseId}/tables`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        tableId,
        name: "ICHA Customer Profiles",
        permissions: [],
        rowSecurity: true,
        enabled: true,
        columns: [
          { key: "user_id", type: "string", size: 36, required: true },
          { key: "full_name", type: "string", size: 128, required: true },
          { key: "email", type: "string", size: 128, required: true },
          { key: "status", type: "string", size: 24, required: false, default: "pending" },
          { key: "credits", type: "integer", required: false, default: 0 },
          { key: "created_at", type: "datetime", required: true }
        ],
        indexes: [
          { key: "unique_user_id", type: "unique", attributes: ["user_id"] },
          { key: "unique_email", type: "unique", attributes: ["email"] }
        ]
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!created.ok) {
      let appwriteError = {};
      try { appwriteError = await created.json(); } catch (_) {}
      const safeType = typeof appwriteError.type === "string" ? appwriteError.type : "unknown";
      const safeMessage = typeof appwriteError.message === "string"
        ? appwriteError.message.slice(0, 240).replace(/[\\r\\n]+/g, " ")
        : "No error message returned";
      console.error("Appwrite profile table creation failed: HTTP " + created.status +
        ", type=" + safeType + ", message=" + safeMessage);
      return;
    }
    console.log("Appwrite customer profile table created.");
  } catch (error) {
    console.error("Appwrite profile table setup failed: " +
      (error && error.name === "TimeoutError" ? "timeout" : "network error"));
  }
}


const PROFILE_TABLE_ID = "icha_customer_profiles";
const SESSION_COOKIE = "icha_session";
const DEVICE_TABLE_ID = "icha_trial_devices";
function appwriteBase() {
  let value = (process.env.APPWRITE_ENDPOINT || "").trim();
  while (value.endsWith("/")) value = value.slice(0, -1);
  if (value && !value.toLowerCase().endsWith("/v1")) value += "/v1";
  return value;
}
function sessionFrom(req) { return req.cookies?.[SESSION_COOKIE] || req.headers["x-icha-session"] || ""; }
app.use((req, _res, next) => {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)icha_session=([^;]+)/);
  req.cookies = { [SESSION_COOKIE]: match ? decodeURIComponent(match[1]) : "" };
  next();
});
async function accountRequest(pathname, options = {}, session = "") {
  const headers = { "X-Appwrite-Project": process.env.APPWRITE_PROJECT_ID, "Content-Type": "application/json" };
  if (session) headers["X-Appwrite-Session"] = session;
  const response = await fetch(appwriteBase() + pathname, { ...options, headers: { ...headers, ...(options.headers || {}) }, signal: AbortSignal.timeout(12000) });
  let body = {};
  try { body = await response.json(); } catch (_) {}
  return { response, body };
}
async function requireAccount(req) {
  const session = sessionFrom(req);
  if (!session) return null;
  const result = await accountRequest("/account", { method: "GET" }, session);
  return result.response.ok ? { account: result.body, session } : null;
}

async function ensureTrialDeviceTable() {
  const required = ["APPWRITE_DATABASE_ID", "APPWRITE_API_KEY", "APPWRITE_PROJECT_ID"];
  if (required.some((name) => !process.env[name])) return false;
  const db = encodeURIComponent(process.env.APPWRITE_DATABASE_ID);
  const headers = { "X-Appwrite-Project": process.env.APPWRITE_PROJECT_ID, "X-Appwrite-Key": process.env.APPWRITE_API_KEY, "Content-Type": "application/json" };
  const base = appwriteBase() + "/tablesdb/" + db + "/tables/" + DEVICE_TABLE_ID;
  try {
    const existing = await fetch(base, { headers, signal: AbortSignal.timeout(10000) });
    if (existing.ok) return true;
    if (existing.status !== 404) return false;
    const created = await fetch(appwriteBase() + "/tablesdb/" + db + "/tables", {
      method: "POST", headers, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        tableId: DEVICE_TABLE_ID, name: "ICHA Free Trial Device Checks", permissions: [], rowSecurity: false, enabled: true,
        columns: [
          { key: "device_hash", type: "string", size: 64, required: true },
          { key: "first_user_id", type: "string", size: 36, required: true },
          { key: "account_count", type: "integer", required: true, default: 1 },
          { key: "first_seen", type: "datetime", required: true },
          { key: "last_seen", type: "datetime", required: true },
          { key: "reused", type: "boolean", required: true, default: false }
        ],
        indexes: [{ key: "unique_device_hash", type: "unique", attributes: ["device_hash"] }]
      })
    });
    return created.ok || created.status === 409;
  } catch (error) {
    console.error("Trial device table setup failed: " + (error && error.name === "TimeoutError" ? "timeout" : "network error"));
    return false;
  }
}
let trialDeviceTableReady = false;
async function recordTrialDevice(userId, deviceToken) {
  if (!trialDeviceTableReady) throw new Error("Trial device checks are not ready.");
  const hash = crypto.createHash("sha256").update(deviceToken).digest("hex");
  const db = encodeURIComponent(process.env.APPWRITE_DATABASE_ID);
  const base = appwriteBase() + "/tablesdb/" + db + "/tables/" + DEVICE_TABLE_ID + "/rows";
  const headers = { "X-Appwrite-Project": process.env.APPWRITE_PROJECT_ID, "X-Appwrite-Key": process.env.APPWRITE_API_KEY, "Content-Type": "application/json" };
  const rowId = "d_" + hash.slice(0, 34);
  const now = new Date().toISOString();
  const lookup = await fetch(base + "/" + encodeURIComponent(rowId), { headers, signal: AbortSignal.timeout(10000) });
  if (lookup.ok) {
    const row = await lookup.json();
    const reused = row.first_user_id !== userId;
    if (reused) {
      await fetch(base + "/" + encodeURIComponent(rowId), {
        method: "PATCH", headers, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ data: { account_count: Number(row.account_count || 1) + 1, last_seen: now, reused: true } })
      });
    } else {
      await fetch(base + "/" + encodeURIComponent(rowId), {
        method: "PATCH", headers, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ data: { last_seen: now } })
      });
    }
    return { previouslySeen: true, reusedByAnotherAccount: reused, accountCount: Number(row.account_count || 1) + (reused ? 1 : 0) };
  }
  if (lookup.status !== 404) throw new Error("Trial device lookup failed.");
  const created = await fetch(base, {
    method: "POST", headers, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ rowId, data: { device_hash: hash, first_user_id: userId, account_count: 1, first_seen: now, last_seen: now, reused: false }, permissions: [] })
  });
  if (created.ok) return { previouslySeen: false, reusedByAnotherAccount: false, accountCount: 1 };
  if (created.status === 409) return recordTrialDevice(userId, deviceToken);
  throw new Error("Trial device record could not be saved.");
}

async function ensureCustomerProfile(account) {
  if (!account || !account.$id || !process.env.APPWRITE_DATABASE_ID || !process.env.APPWRITE_API_KEY) {
    throw new Error("Customer profile configuration is incomplete.");
  }
  const base = appwriteBase();
  const databaseId = encodeURIComponent(process.env.APPWRITE_DATABASE_ID);
  const rowUrl = base + "/tablesdb/" + databaseId + "/tables/" + PROFILE_TABLE_ID + "/rows/" + encodeURIComponent(account.$id);
  const headers = {
    "X-Appwrite-Project": process.env.APPWRITE_PROJECT_ID,
    "X-Appwrite-Key": process.env.APPWRITE_API_KEY,
    "Content-Type": "application/json"
  };
  const existing = await fetch(rowUrl, { headers, signal: AbortSignal.timeout(10000) });
  if (existing.ok) return true;
  if (existing.status !== 404) {
    throw new Error("Customer profile lookup failed with HTTP " + existing.status);
  }
  const created = await fetch(base + "/tablesdb/" + databaseId + "/tables/" + PROFILE_TABLE_ID + "/rows", {
    method: "POST",
    headers,
    body: JSON.stringify({
      rowId: account.$id,
      data: {
        user_id: account.$id,
        full_name: String(account.name || "Customer").slice(0, 128),
        email: String(account.email || "").toLowerCase(),
        status: "pending",
        credits: 0,
        created_at: new Date().toISOString()
      },
      permissions: [`read("user:${account.$id}")`, `update("user:${account.$id}")`]
    }),
    signal: AbortSignal.timeout(12000)
  });
  if (created.ok || created.status === 409) return true;
  throw new Error("Customer profile creation failed with HTTP " + created.status);
}

const ensureWalletTable = require("./payments").registerPaymentRoutes(app, requireAccount, appwriteBase);
app.post("/api/auth/register", async (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 128);
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!name || !/^\S+@\S+\.\S+$/.test(email) || !password) {
    return res.status(400).json({ error: "Enter your name, a valid email address, and a password." });
  }
  try {
    const created = await accountRequest("/account", { method: "POST", body: JSON.stringify({ userId: "unique()", name, email, password }) });
    if (!created.response.ok) {
      const status = created.response.status === 409 ? 409 : created.response.status === 429 ? 429 : 400;
      const error = created.response.status === 429
        ? "Too many attempts right now. Please wait a little and try again."
        : created.body.message || "Could not create account.";
      const retryAfter = created.response.headers.get("retry-after");
      if (retryAfter) res.set("Retry-After", retryAfter);
      return res.status(status).json({ error });
    }
    const login = await accountRequest("/account/sessions/email", { method: "POST", body: JSON.stringify({ email, password }) });
    if (!login.response.ok || !login.body.secret) {
      if (login.response.status === 429) {
        const retryAfter = login.response.headers.get("retry-after");
        if (retryAfter) res.set("Retry-After", retryAfter);
        return res.status(429).json({ error: "Your account was created, but sign-in is temporarily busy. Please try signing in again shortly." });
      }
      return res.status(502).json({ error: "Your account was created. Please sign in to continue." });
    }
    const session = login.body.secret;
    res.cookie(SESSION_COOKIE, session, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 14 * 24 * 60 * 60 * 1000 });
    // Record this browser against the account without slowing registration.
    setImmediate(() => recordTrialDevice(created.body.$id, req.ichaDeviceToken)
      .catch(() => console.warn("Trial device check could not be recorded during registration.")));
    // Profile provisioning is non-blocking so it cannot delay first sign-in.
    setImmediate(() => ensureCustomerProfile({ $id: created.body.$id, name, email })
      .catch(profileError => console.error("Customer profile provisioning deferred: " + String(profileError.message || "unknown").slice(0, 120))));
    return res.status(201).json({ ok: true, name });
  } catch (_) { return res.status(502).json({ error: "Account service temporarily unavailable." }); }
});
app.post("/api/auth/login", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!email || !password) return res.status(400).json({ error: "Enter your email and password." });
  try {
    const result = await accountRequest("/account/sessions/email", { method: "POST", body: JSON.stringify({ email, password }) });
    if (!result.response.ok || !result.body.secret) {
      if (result.response.status === 429) {
        const retryAfter = result.response.headers.get("retry-after");
        if (retryAfter) res.set("Retry-After", retryAfter);
        return res.status(429).json({ error: "Sign-in is temporarily busy. Please wait a little and try again." });
      }
      return res.status(401).json({ error: "Email or password is incorrect." });
    }
    res.cookie(SESSION_COOKIE, result.body.secret, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 14 * 24 * 60 * 60 * 1000 });
    // Record this browser against the account without slowing sign-in.
    setImmediate(() => recordTrialDevice(result.body.userId, req.ichaDeviceToken)
      .catch(() => console.warn("Trial device check could not be recorded during sign-in.")));
    // Repair the customer profile after the sign-in response, not in the critical path.
    setImmediate(() => ensureCustomerProfile({ $id: result.body.userId, name: result.body.userName || "Customer", email: result.body.userEmail || email })
      .catch(profileError => console.error("Customer profile repair deferred: " + String(profileError.message || "unknown").slice(0, 120))));
    return res.json({ ok: true });
  } catch (_) { return res.status(502).json({ error: "Account service temporarily unavailable." }); }
});
app.post("/api/auth/forgot-password", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Enter the email address linked to your account." });
  try {
    const result = await accountRequest("/account/recovery", { method: "POST", body: JSON.stringify({ email, url: "https://studio.tanphat.shop/reset-password.html" }) });
    if (result.response.status === 429) {
      const retryAfter = result.response.headers.get("retry-after");
      if (retryAfter) res.set("Retry-After", retryAfter);
      return res.status(429).json({ error: "Too many requests. Please wait a little and try again." });
    }
    if (!result.response.ok) {
      console.error("Password recovery request failed with HTTP " + result.response.status);
      return res.status(502).json({ error: "We could not send the reset email right now. Please try again later." });
    }
    return res.json({ ok: true, message: "If an account exists for that email, a password reset link has been sent. Check your inbox and spam folder." });
  } catch (_) { return res.status(502).json({ error: "Password reset is temporarily unavailable. Please try again later." }); }
});
app.post("/api/auth/reset-password", async (req, res) => {
  const userId = String(req.body?.userId || "").trim();
  const secret = String(req.body?.secret || "").trim();
  const password = String(req.body?.password || "");
  const passwordAgain = String(req.body?.passwordAgain || "");
  if (!userId || !secret || !password || !passwordAgain) return res.status(400).json({ error: "Open the reset link from your email and enter your new password twice." });
  if (password !== passwordAgain) return res.status(400).json({ error: "The passwords do not match." });
  try {
    const result = await accountRequest("/account/recovery", { method: "PUT", body: JSON.stringify({ userId, secret, password, passwordAgain }) });
    if (!result.response.ok) return res.status(result.response.status === 429 ? 429 : 400).json({ error: result.response.status === 429 ? "Too many attempts. Please wait a little and try again." : "This reset link is invalid or has expired. Request a new password reset link." });
    return res.json({ ok: true, message: "Your password has been changed. You can now sign in with your new password." });
  } catch (_) { return res.status(502).json({ error: "Password reset is temporarily unavailable. Please try again later." }); }
});
app.get("/api/trial/device-check", async (req, res) => {
  try {
    const current = await requireAccount(req);
    if (!current) return res.status(401).json({ error: "Please sign in." });
    const device = await recordTrialDevice(current.account.$id, req.ichaDeviceToken);
    return res.json({
      checked: true,
      sameDevicePreviouslyUsed: device.previouslySeen,
      usedByAnotherAccount: device.reusedByAnotherAccount,
      accountCountOnDevice: device.accountCount,
      freeTrialDecision: "pending_generation_integration",
      message: "This is a device-risk signal only. It does not by itself prove a person's identity."
    });
  } catch (_) {
    return res.status(503).json({ error: "Free-trial protection is temporarily unavailable." });
  }
});

app.get("/api/auth/me", async (req, res) => {
  try {
    const current = await requireAccount(req);
    if (!current) return res.status(401).json({ authenticated: false });
    return res.json({ authenticated: true, user: { id: current.account.$id, name: current.account.name, email: current.account.email } });
  } catch (_) { return res.status(502).json({ error: "Could not verify your session." }); }
});
app.post("/api/auth/logout", async (req, res) => {
  try {
    const session = sessionFrom(req);
    if (session) await accountRequest("/account/sessions/current", { method: "DELETE" }, session);
  } catch (_) {}
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: true, sameSite: "lax", path: "/" });
  return res.json({ ok: true });
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", app: "ICHA AI Studio" });
});

app.get("/api/status", (_req, res) => {
  res.json({
    videoProviderConfigured: Boolean(process.env.REPLICATE_API_TOKEN),
    voiceProviderConfigured: Boolean(process.env.ELEVENLABS_API_KEY),
    generationEnabled: false,
    freeVideosPerCustomer: FREE_VIDEO_LIMIT_PER_CUSTOMER,
    freeVideoPolicy: FREE_VIDEO_POLICY,
    freeVideosActive: false,
    monthlyAiBudgetNgn: MONTHLY_AI_BUDGET_NGN,
    monthlyAiBudgetEnforced: false,
    usageLedgerReady: false,
    note: "Planned launch offer: two lifetime free videos per customer. Generation remains disabled until a specific video model and duration are selected and durable usage metering, atomic budget reservations, provider cost controls and failure handling are implemented and tested."
  });
});

// Verify both credentials with non-billable account/profile requests.
// Return only HTTP status and a safe error category; never return keys or provider response bodies.
// Check Appwrite access to the configured customer table without exposing credentials.
app.get("/api/appwrite-check", async (_req, res) => {
  const required = [
    "APPWRITE_ENDPOINT",
    "APPWRITE_PROJECT_ID",
    "APPWRITE_DATABASE_ID",
    "APPWRITE_CUSTOMERS_TABLE_ID",
    "APPWRITE_API_KEY"
  ];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    return res.status(503).json({
      configured: false,
      connected: false,
      missing
    });
  }

  try {
    let endpoint = process.env.APPWRITE_ENDPOINT.trim();
    while (endpoint.endsWith("/")) endpoint = endpoint.slice(0, -1);
    if (!endpoint.toLowerCase().endsWith("/v1")) endpoint += "/v1";
    const databaseId = encodeURIComponent(process.env.APPWRITE_DATABASE_ID);
    const tableId = encodeURIComponent(process.env.APPWRITE_CUSTOMERS_TABLE_ID);
    const response = await fetch(
      `${endpoint}/tablesdb/${databaseId}/tables/${tableId}`,
      {
        method: "GET",
        headers: {
          "X-Appwrite-Project": process.env.APPWRITE_PROJECT_ID,
          "X-Appwrite-Key": process.env.APPWRITE_API_KEY
        },
        signal: AbortSignal.timeout(10000)
      }
    );
    if (!response.ok) {
      return res.status(502).json({
        configured: true,
        connected: false,
        httpStatus: response.status,
        error: response.status === 401 ? "unauthorized"
          : response.status === 403 ? "permission_denied"
          : response.status === 404 ? "database_or_table_not_found"
          : response.status === 429 ? "rate_limited"
          : "appwrite_error"
      });
    }
    return res.json({
      configured: true,
      connected: true,
      databaseAccess: true,
      customersTableAccess: true
    });
  } catch (error) {
    return res.status(502).json({
      configured: true,
      connected: false,
      error: error && error.name === "TimeoutError" ? "timeout" : "network_error"
    });
  }
});

app.get("/api/provider-check", async (_req, res) => {
  const result = {
    replicate: { configured: Boolean(process.env.REPLICATE_API_TOKEN), connected: false },
    elevenlabs: { configured: Boolean(process.env.ELEVENLABS_API_KEY), connected: false }
  };

  const check = async (provider, url, headers) => {
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(10000)
      });
      result[provider].connected = response.ok;
      result[provider].httpStatus = response.status;
      if (!response.ok) {
        result[provider].error = response.status === 401 ? "unauthorized"
          : response.status === 403 ? "forbidden_or_missing_permission"
          : response.status === 429 ? "rate_limited"
          : "provider_error";
      }
    } catch (error) {
      result[provider].error = error && error.name === "TimeoutError" ? "timeout" : "network_error";
    }
  };

  const checks = [];
  if (result.replicate.configured) {
    checks.push(check("replicate", "https://api.replicate.com/v1/account", {
      Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`
    }));
  }
  if (result.elevenlabs.configured) {
    checks.push(check("elevenlabs", "https://api.elevenlabs.io/v1/user", {
      "xi-api-key": process.env.ELEVENLABS_API_KEY
    }));
  }

  await Promise.all(checks);
  res.json({
    providers: result,
    allConnected: result.replicate.connected && result.elevenlabs.connected,
    generationEnabled: false,
    note: "Connection checks do not generate content or consume generation credits. Customer authentication, voice consent and usage controls are required before public generation."
  });
});

app.get("/reset-password.html", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "reset-password.html"));
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

ensureCustomerProfileTable();
ensureWalletTable();
ensureTrialDeviceTable().then((ready) => { trialDeviceTableReady = ready; if (ready) console.log("ICHA trial device checks ready."); });

app.listen(PORT, "0.0.0.0", () => {
  console.log("ICHA AI Studio listening on port " + PORT);
});
