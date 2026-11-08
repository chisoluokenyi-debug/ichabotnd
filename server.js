"use strict";

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.APP_BASE_URL || "https://ichabotnd.onrender.com";
const GRAPH = process.env.META_GRAPH_VERSION;

const APP_ID = process.env.META_APP_ID;
const APP_SECRET = process.env.META_APP_SECRET;
const LOGIN_CONFIG_ID = process.env.META_LOGIN_CONFIG_ID;
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;
const SESSION_SECRET = process.env.SESSION_SECRET;
const ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY;

if (!process.env.DATABASE_URL || !SESSION_SECRET ||
    SESSION_SECRET.length < 32 || !VERIFY_TOKEN ||
    !APP_SECRET || !APP_ID || !LOGIN_CONFIG_ID ||
    !GRAPH || !/^[a-fA-F0-9]{64}$/.test(ENCRYPTION_KEY || "")) {
  console.error("Missing or invalid required environment variables.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true"
    ? { rejectUnauthorized: false }
    : false
});

app.disable("x-powered-by");

app.use(express.json({
  limit: "1mb",
  verify: (req, res, buffer) => {
    req.rawBody = buffer;
  }
}));

app.use(express.static(path.join(__dirname, "public")));

const COOKIE = "ichabot_session";
const DAY = 86400000;

function hash(value) {
  return crypto.createHmac("sha256", SESSION_SECRET)
    .update(value).digest("hex");
}

function equal(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cookie(req) {
  const parts = (req.headers.cookie || "").split(";");
  for (const part of parts) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return decodeURIComponent(value.join("="));
  }
  return null;
}

function setCookie(res, token) {
  res.setHeader("Set-Cookie",
    `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`);
}

function clearCookie(res) {
  res.setHeader("Set-Cookie",
    `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm", Buffer.from(ENCRYPTION_KEY, "hex"), iv
  );
  const data = Buffer.concat([
    cipher.update(text, "utf8"), cipher.final()
  ]);
  return [
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    data.toString("hex")
  ].join(":");
}

function decrypt(value) {
  const [iv, tag, data] = value.split(":");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm", Buffer.from(ENCRYPTION_KEY, "hex"),
    Buffer.from(iv, "hex")
  );
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "hex")),
    decipher.final()
  ]).toString("utf8");
}

function passwordHash(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(key.toString("hex"));
    });
  });
}

async function loginRequired(req, res, next) {
  try {
    const token = cookie(req);
    if (!token) return res.status(401).json({ error: "Please sign in." });

    const result = await pool.query(
      `SELECT u.id, u.email
       FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.expires_at > NOW()`,
      [hash(token)]
    );

    if (!result.rows.length) {
      clearCookie(res);
      return res.status(401).json({ error: "Please sign in again." });
    }

    req.user = result.rows[0];
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login check failed." });
  }
}

async function graph(method, endpoint, token, data = {}) {
  const url = `https://graph.facebook.com/${GRAPH}/${endpoint}`;
  const options = {
    method,
    url,
    timeout: 20000
  };

  if (method === "GET") {
    options.params = { ...data, access_token: token };
  } else {
    options.data = { ...data, access_token: token };
  }

  const response = await axios(options);
  return response.data;
}

async function getPage(pageId) {
  const result = await pool.query(
    "SELECT * FROM pages WHERE page_id=$1", [String(pageId)]
  );
  if (!result.rows.length) return null;
  return result.rows[0];
}

async function sendMessenger(page, recipientId, message) {
  return graph("POST", `${page.page_id}/messages`, decrypt(page.access_token), {
    recipient: { id: String(recipientId) },
    messaging_type: "RESPONSE",
    message: { text: message }
  });
}

async function replyToComment(page, commentId, message) {
  return graph("POST", `${commentId}/comments`, decrypt(page.access_token), {
    message
  });
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pages (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      page_id TEXT UNIQUE NOT NULL,
      page_name TEXT NOT NULL,
      access_token TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id BIGSERIAL PRIMARY KEY,
      page_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      last_interaction TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      first_seen BOOLEAN NOT NULL DEFAULT TRUE,
      UNIQUE(page_id, sender_id)
    );

    CREATE TABLE IF NOT EXISTS messenger_rules (
      id BIGSERIAL PRIMARY KEY,
      page_id TEXT NOT NULL,
      keyword TEXT NOT NULL DEFAULT '',
      reply TEXT NOT NULL,
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      is_welcome BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS comment_rules (
      id BIGSERIAL PRIMARY KEY,
      page_id TEXT NOT NULL,
      keyword TEXT NOT NULL DEFAULT '',
      reply TEXT NOT NULL,
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS handled_comments (
      comment_id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      handled_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      page_id TEXT NOT NULL,
      message TEXT NOT NULL,
      scheduled_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      sent_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS campaign_logs (
      id BIGSERIAL PRIMARY KEY,
      campaign_id BIGINT REFERENCES campaigns(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS page_activity (
      id BIGSERIAL PRIMARY KEY,
      page_id TEXT NOT NULL,
      activity_type TEXT NOT NULL,
      object_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log("IchaBot database ready.");
}

app.get("/health", (req, res) => {
  res.json({ status: "ok", app: "IchaBot" });
});

/* CUSTOMER REGISTRATION */

app.post("/api/register", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: "Enter a valid email." });

    if (password.length < 10 || password.length > 128)
      return res.status(400).json({
        error: "Password must contain 10 to 128 characters."
      });

    const salt = crypto.randomBytes(16).toString("hex");
    const hashed = await passwordHash(password, salt);

    await pool.query(
      "INSERT INTO users(email,password_hash,salt) VALUES($1,$2,$3)",
      [email, hashed, salt]
    );

    res.json({ message: "Account created. Please sign in." });
  } catch (err) {
    if (err.code === "23505")
      return res.status(409).json({ error: "Email already registered." });

    console.error(err);
    res.status(500).json({ error: "Registration failed." });
  }
});

/* CUSTOMER LOGIN */

app.post("/api/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const result = await pool.query(
      "SELECT * FROM users WHERE email=$1", [email]
    );

    if (!result.rows.length)
      return res.status(401).json({ error: "Incorrect login details." });

    const user = result.rows[0];
    const check = await passwordHash(password, user.salt);

    if (!equal(check, user.password_hash))
      return res.status(401).json({ error: "Incorrect login details." });

    const token = crypto.randomBytes(32).toString("hex");

    await pool.query(
      `INSERT INTO sessions(user_id,token_hash,expires_at)
       VALUES($1,$2,NOW()+INTERVAL '7 days')`,
      [user.id, hash(token)]
    );

    setCookie(res, token);
    res.json({ message: "Signed in.", email: user.email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed." });
  }
});

app.get("/api/me", loginRequired, (req, res) => {
  res.json({ user: req.user });
});

app.post("/api/logout", async (req, res) => {
  const token = cookie(req);
  if (token) {
    await pool.query("DELETE FROM sessions WHERE token_hash=$1", [hash(token)]);
  }
  clearCookie(res);
  res.json({ message: "Signed out." });
});

/* FACEBOOK LOGIN FOR BUSINESS */

app.get("/api/facebook/start", loginRequired, async (req, res) => {
  const state = crypto.randomBytes(32).toString("hex");

  await pool.query(
    `INSERT INTO oauth_states(state,user_id,expires_at)
     VALUES($1,$2,NOW()+INTERVAL '10 minutes')`,
    [state, req.user.id]
  );

  const url = new URL("https://www.facebook.com/dialog/oauth");
  url.searchParams.set("client_id", APP_ID);
  url.searchParams.set("redirect_uri", `${BASE_URL}/api/facebook/callback`);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("config_id", LOGIN_CONFIG_ID);

  res.redirect(url.toString());
});

app.get("/api/facebook/callback", async (req, res) => {
  try {
    const state = String(req.query.state || "");
    const code = String(req.query.code || "");

    const saved = await pool.query(
      `DELETE FROM oauth_states
       WHERE state=$1 AND expires_at>NOW()
       RETURNING user_id`,
      [state]
    );

    if (!saved.rows.length || !code)
      return res.status(400).send("Facebook connection expired. Try again.");

    const userId = saved.rows[0].user_id;

    const tokenResponse = await axios.get(
      `https://graph.facebook.com/${GRAPH}/oauth/access_token`,
      {
        params: {
          client_id: APP_ID,
          client_secret: APP_SECRET,
          redirect_uri: `${BASE_URL}/api/facebook/callback`,
          code
        }
      }
    );

    const userToken = tokenResponse.data.access_token;

    const pagesResponse = await graph(
      "GET", "me/accounts", userToken,
      { fields: "id,name,access_token,tasks" }
    );

    let connected = 0;

    for (const page of pagesResponse.data || []) {
      if (!page.id || !page.access_token) continue;

      await pool.query(
        `INSERT INTO pages(user_id,page_id,page_name,access_token)
         VALUES($1,$2,$3,$4)
         ON CONFLICT(page_id) DO UPDATE SET
           user_id=EXCLUDED.user_id,
           page_name=EXCLUDED.page_name,
           access_token=EXCLUDED.access_token`,
        [userId, page.id, page.name || "Facebook Page", encrypt(page.access_token)]
      );

      try {
        await graph("POST", `${page.id}/subscribed_apps`, page.access_token, {
          subscribed_fields: "messages,messaging_postbacks,feed"
        });
      } catch (subscribeError) {
        console.error("Page subscription:", subscribeError.response?.data || subscribeError.message);
      }

      connected++;
    }

    res.redirect("/?facebook=connected&count=" + connected);
  } catch (err) {
    console.error("Facebook connection:", err.response?.data || err.message);
    res.status(500).send("Could not connect Facebook. Check Meta permissions and configuration.");
  }
});

/* CUSTOMER PAGES */

app.get("/api/pages", loginRequired, async (req, res) => {
  const result = await pool.query(
    "SELECT page_id,page_name,created_at FROM pages WHERE user_id=$1 ORDER BY id DESC",
    [req.user.id]
  );
  res.json({ pages: result.rows });
});

app.delete("/api/pages/:pageId", loginRequired, async (req, res) => {
  await pool.query(
    "DELETE FROM pages WHERE page_id=$1 AND user_id=$2",
    [req.params.pageId, req.user.id]
  );
  res.json({ message: "Page disconnected." });
});

/* MESSENGER AND COMMENT RULE SETTINGS */

app.get("/api/rules/:pageId", loginRequired, async (req, res) => {
  const page = await getPage(req.params.pageId);
  if (!page || String(page.user_id) !== String(req.user.id))
    return res.status(404).json({ error: "Page not found." });

  const messenger = await pool.query(
    "SELECT * FROM messenger_rules WHERE page_id=$1 ORDER BY id",
    [page.page_id]
  );
  const comments = await pool.query(
    "SELECT * FROM comment_rules WHERE page_id=$1 ORDER BY id",
    [page.page_id]
  );

  res.json({ messenger: messenger.rows, comments: comments.rows });
});

app.post("/api/rules/:pageId", loginRequired, async (req, res) => {
  const page = await getPage(req.params.pageId);
  if (!page || String(page.user_id) !== String(req.user.id))
    return res.status(404).json({ error: "Page not found." });

  const type = req.body.type;
  const keyword = String(req.body.keyword || "").trim().toLowerCase();
  const reply = String(req.body.reply || "").trim();

  if (!reply || reply.length > 2000)
    return res.status(400).json({ error: "Enter a reply under 2,000 characters." });

  if (!["messenger", "comment"].includes(type))
    return res.status(400).json({ error: "Invalid rule type." });

  const isDefault = req.body.isDefault === true;
  const isWelcome = req.body.isWelcome === true;

  if (type === "messenger") {
    if (isDefault || isWelcome) {
      await pool.query(
        `DELETE FROM messenger_rules
         WHERE page_id=$1 AND
         (($2=TRUE AND is_default=TRUE) OR ($3=TRUE AND is_welcome=TRUE))`,
        [page.page_id, isDefault, isWelcome]
      );
    }

    await pool.query(
      `INSERT INTO messenger_rules(page_id,keyword,reply,is_default,is_welcome)
       VALUES($1,$2,$3,$4,$5)`,
      [page.page_id, keyword, reply, isDefault, isWelcome]
    );
  } else {
    if (isDefault) {
      await pool.query(
        "DELETE FROM comment_rules WHERE page_id=$1 AND is_default=TRUE",
        [page.page_id]
      );
    }

    await pool.query(
      `INSERT INTO comment_rules(page_id,keyword,reply,is_default)
       VALUES($1,$2,$3,$4)`,
      [page.page_id, keyword, reply, isDefault]
    );
  }

  res.json({ message: "Reply rule saved." });
});

/* WEBHOOK VERIFICATION */

app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === VERIFY_TOKEN
  ) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

function validSignature(req) {
  const signature = req.headers["x-hub-signature-256"];
  if (!signature || !req.rawBody) return false;

  const expected = "sha256=" + crypto
    .createHmac("sha256", APP_SECRET)
    .update(req.rawBody)
    .digest("hex");

  return equal(signature, expected);
}

/* MESSENGER AUTO REPLIES */

async function handleMessage(page, event) {
  const sender = event.sender && event.sender.id;
  const text = String(event.message?.text || "").trim();

  if (!sender || !text || event.message?.is_echo) return;

  const contact = await pool.query(
    `INSERT INTO contacts(page_id,sender_id,last_interaction,first_seen)
     VALUES($1,$2,NOW(),TRUE)
     ON CONFLICT(page_id,sender_id) DO UPDATE SET
       last_interaction=NOW()
     RETURNING first_seen`,
    [page.page_id, String(sender)]
  );

  const rules = await pool.query(
    "SELECT * FROM messenger_rules WHERE page_id=$1 ORDER BY id",
    [page.page_id]
  );

  const lower = text.toLowerCase();
  const first = contact.rows[0].first_seen;

  let reply = null;

  if (first) {
    const welcome = rules.rows.find(r => r.is_welcome);
    if (welcome) reply = welcome.reply;

    await pool.query(
      "UPDATE contacts SET first_seen=FALSE WHERE page_id=$1 AND sender_id=$2",
      [page.page_id, String(sender)]
    );
  }

  if (!reply) {
    const match = rules.rows.find(
      r => !r.is_default && !r.is_welcome &&
      r.keyword && lower.includes(r.keyword.toLowerCase())
    );
    if (match) reply = match.reply;
  }

  if (!reply) {
    const fallback = rules.rows.find(r => r.is_default);
    reply = fallback?.reply ||
      "Thank you for contacting us. How can we help you?";
  }

  await sendMessenger(page, sender, reply);
}

/* FACEBOOK COMMENT AUTO REPLIES */

async function handleComment(page, value) {
  const item = value.item;
  const verb = value.verb;

  if (item !== "comment" || verb !== "add") return;

  const commentId = String(value.comment_id || value.post_id || "");
  const message = String(value.message || "").trim();

  if (!commentId || !message) return;

  const authorId = String(value.from?.id || "");
  if (authorId === String(page.page_id)) return;

  const claimed = await pool.query(
    `INSERT INTO handled_comments(comment_id,page_id)
     VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING comment_id`,
    [commentId, page.page_id]
  );

  if (!claimed.rows.length) return;

  const rules = await pool.query(
    `SELECT * FROM comment_rules
     WHERE page_id=$1 AND enabled=TRUE ORDER BY id`,
    [page.page_id]
  );

  const lower = message.toLowerCase();
  const match = rules.rows.find(
    r => !r.is_default && r.keyword &&
    lower.includes(r.keyword.toLowerCase())
  );

  const fallback = rules.rows.find(r => r.is_default);
  const reply = match?.reply || fallback?.reply;

  if (reply) {
    await replyToComment(page, commentId, reply);
  }
}

/* WEBHOOK EVENTS */

async function processWebhook(body) {
  if (!body || body.object !== "page") return;

  for (const entry of body.entry || []) {
    const page = await getPage(entry.id);
    if (!page) continue;

    for (const event of entry.messaging || []) {
      try {
        await handleMessage(page, event);
      } catch (err) {
        console.error("Messenger event:", err.response?.data || err.message);
      }
    }

    for (const change of entry.changes || []) {
      try {
        if (change.field === "feed") {
          const value = change.value || {};

          if (value.item === "comment") {
            await handleComment(page, value);
          } else if (value.verb === "add") {
            await pool.query(
              `INSERT INTO page_activity(page_id,activity_type,object_id)
               VALUES($1,$2,$3)`,
              [page.page_id, value.item || "feed_activity",
               String(value.post_id || "")]
            );
          }
        }
      } catch (err) {
        console.error("Page event:", err.response?.data || err.message);
      }
    }
  }
}

app.post("/webhook", (req, res) => {
  if (!validSignature(req)) return res.sendStatus(401);

  res.sendStatus(200);

  processWebhook(req.body).catch(err =>
    console.error("Webhook processing:", err)
  );
});

/* BROADCAST CAMPAIGNS */

app.post("/api/campaigns", loginRequired, async (req, res) => {
  try {
    const page = await getPage(req.body.pageId);

    if (!page || String(page.user_id) !== String(req.user.id))
      return res.status(404).json({ error: "Page not found." });

    const message = String(req.body.message || "").trim();
    const scheduledAt = new Date(req.body.scheduledAt);

    if (!message || message.length > 2000 || isNaN(scheduledAt.getTime()))
      return res.status(400).json({ error: "Enter a message and valid schedule time." });

    if (scheduledAt.getTime() < Date.now() - 60000)
      return res.status(400).json({ error: "Choose a future time." });

    const result = await pool.query(
      `INSERT INTO campaigns(user_id,page_id,message,scheduled_at)
       VALUES($1,$2,$3,$4) RETURNING *`,
      [req.user.id, page.page_id, message, scheduledAt]
    );

    res.json({ message: "Campaign scheduled.", campaign: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not schedule campaign." });
  }
});

app.get("/api/campaigns", loginRequired, async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM campaigns WHERE user_id=$1 ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json({ campaigns: result.rows });
});

async function runCampaigns() {
  const due = await pool.query(
    `SELECT * FROM campaigns
     WHERE status='scheduled' AND scheduled_at<=NOW()
     ORDER BY scheduled_at LIMIT 5`
  );

  for (const campaign of due.rows) {
    const locked = await pool.query(
      `UPDATE campaigns SET status='sending'
       WHERE id=$1 AND status='scheduled' RETURNING id`,
      [campaign.id]
    );
    if (!locked.rows.length) continue;

    const page = await getPage(campaign.page_id);
    if (!page) {
      await pool.query(
        "UPDATE campaigns SET status='failed' WHERE id=$1",
        [campaign.id]
      );
      continue;
    }

    const contacts = await pool.query(
      `SELECT sender_id FROM contacts
       WHERE page_id=$1 AND last_interaction>NOW()-INTERVAL '24 hours'`,
      [campaign.page_id]
    );

    let sent = 0;
    let failed = 0;

    for (const contact of contacts.rows) {
      try {
        await sendMessenger(page, contact.sender_id, campaign.message);
        sent++;

        await pool.query(
          `INSERT INTO campaign_logs(campaign_id,sender_id,status)
           VALUES($1,$2,'sent')`,
          [campaign.id, contact.sender_id]
        );
      } catch (err) {
        failed++;

        await pool.query(
          `INSERT INTO campaign_logs(campaign_id,sender_id,status,error)
           VALUES($1,$2,'failed',$3)`,
          [campaign.id, contact.sender_id,
           String(err.response?.data?.error?.message || err.message).slice(0,500)]
        );
      }
    }

    await pool.query(
      `UPDATE campaigns SET status='completed',
       sent_count=$2,failed_count=$3 WHERE id=$1`,
      [campaign.id, sent, failed]
    );
  }
}

setInterval(() => {
  runCampaigns().catch(err => console.error("Campaign scheduler:", err));
}, 30000);

/* DASHBOARD DATA */

app.get("/api/dashboard", loginRequired, async (req, res) => {
  const pages = await pool.query(
    "SELECT page_id,page_name FROM pages WHERE user_id=$1",
    [req.user.id]
  );

  const campaigns = await pool.query(
    `SELECT COUNT(*)::int AS total,
     COALESCE(SUM(sent_count),0)::int AS sent,
     COALESCE(SUM(failed_count),0)::int AS failed
     FROM campaigns WHERE user_id=$1`,
    [req.user.id]
  );

  res.json({
    pages: pages.rows,
    campaigns: campaigns.rows[0]
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function start() {
  try {
    await initializeDatabase();
    app.listen(PORT, () => console.log(`IchaBot running on ${PORT}`));
  } catch (err) {
    console.error("Startup failed:", err);
    process.exit(1);
  }
}

start();
