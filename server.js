require("dotenv").config();

const express = require("express");
const axios = require("axios");
const path = require("path");
const crypto = require("crypto");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const helmet = require("helmet");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

const APP_BASE_URL = (
  process.env.APP_BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  "https://ichabotnd.onrender.com"
).replace(/\/+$/, "");

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const META_LOGIN_CONFIG_ID = process.env.META_LOGIN_CONFIG_ID;
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;
const SESSION_SECRET = process.env.SESSION_SECRET;

let GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v25.0";
GRAPH_VERSION = GRAPH_VERSION.replace(/^\/+|\/+$/g, "");
if (!GRAPH_VERSION.startsWith("v")) GRAPH_VERSION = `v${GRAPH_VERSION}`;

const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is missing.");
if (!META_APP_ID || !META_APP_SECRET) throw new Error("META_APP_ID or META_APP_SECRET is missing.");
if (!META_LOGIN_CONFIG_ID) throw new Error("META_LOGIN_CONFIG_ID is missing.");
if (!VERIFY_TOKEN) throw new Error("META_WEBHOOK_VERIFY_TOKEN is missing.");
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  throw new Error("SESSION_SECRET must be at least 32 characters.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true"
    ? { rejectUnauthorized: false }
    : undefined
});

pool.on("error", (error) => {
  console.error("Database error:", error.message);
});

/* TOKEN ENCRYPTION */

const encryptionSecret =
  process.env.TOKEN_ENCRYPTION_KEY || SESSION_SECRET;

const ENCRYPTION_KEY = /^[a-fA-F0-9]{64}$/.test(encryptionSecret)
  ? Buffer.from(encryptionSecret, "hex")
  : crypto.createHash("sha256").update(encryptionSecret).digest();

function encryptToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final()
  ]);

  return [
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    encrypted.toString("hex")
  ].join(":");
}

function decryptToken(value) {
  const parts = String(value || "").split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted Page token.");

  const [ivHex, tagHex, encryptedHex] = parts;
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    ENCRYPTION_KEY,
    Buffer.from(ivHex, "hex")
  );

  decipher.setAuthTag(Buffer.from(tagHex, "hex"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final()
  ]).toString("utf8");
}

/* DATABASE */

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      facebook_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      email TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pages (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      page_id TEXT NOT NULL,
      page_name TEXT NOT NULL,
      encrypted_token TEXT NOT NULL,
      connected_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, page_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      page_id TEXT PRIMARY KEY,
      welcome_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      welcome_message TEXT NOT NULL DEFAULT
        'Hello! Thanks for messaging us. How can we help you today?',
      default_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      default_reply TEXT NOT NULL DEFAULT
        'Thanks for your message. We will get back to you shortly.',
      comment_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      comment_reply TEXT NOT NULL DEFAULT
        'Thanks for your comment! We have sent you a private message.',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      page_id TEXT NOT NULL,
      psid TEXT NOT NULL,
      last_interaction TIMESTAMPTZ DEFAULT NOW(),
      first_message BOOLEAN NOT NULL DEFAULT TRUE,
      welcome_claimed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY(page_id, psid)
    )
  `);

  await pool.query(`
    ALTER TABLE contacts
    ADD COLUMN IF NOT EXISTS first_message BOOLEAN NOT NULL DEFAULT TRUE
  `);

  await pool.query(`
    ALTER TABLE contacts
    ADD COLUMN IF NOT EXISTS welcome_claimed_at TIMESTAMPTZ
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS broadcasts (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      page_id TEXT NOT NULL,
      message TEXT NOT NULL,
      scheduled_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'scheduled',
      sent_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    ALTER TABLE broadcasts
    ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_events (
      event_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'processing',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE processed_events
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'processing'
  `);

  await pool.query(`
    ALTER TABLE processed_events
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS contacts_activity_idx
    ON contacts(page_id, last_interaction)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS broadcasts_due_idx
    ON broadcasts(status, scheduled_at)
  `);

  console.log("IchaBot database is ready.");
}

/* EXPRESS */

app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: false
}));

app.use(express.json({
  limit: "1mb",
  verify: (req, res, buffer) => {
    if (req.path === "/webhook") {
      req.rawBody = Buffer.from(buffer);
    }
  }
}));

app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new PgSession({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: true
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.SESSION_COOKIE_SECURE === "false"
      ? false
      : process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use(express.static(path.join(__dirname, "public")));

/* HELPERS */

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({
      error: "Please log in with Facebook first."
    });
  }
  next();
}

async function graphGet(endpoint, params = {}) {
  const response = await axios.get(`${GRAPH_BASE}/${endpoint}`, {
    params,
    timeout: 20000
  });
  return response.data;
}

async function graphPost(endpoint, data, accessToken) {
  const response = await axios.post(`${GRAPH_BASE}/${endpoint}`, data, {
    params: { access_token: accessToken },
    timeout: 20000
  });
  return response.data;
}

async function getUserPages(userId) {
  const result = await pool.query(
    `SELECT page_id, page_name
     FROM pages
     WHERE user_id = $1
     ORDER BY page_name`,
    [userId]
  );
  return result.rows;
}

async function getSelectedPage(req) {
  if (req.session.selectedPageId) {
    const selected = await pool.query(
      `SELECT *
       FROM pages
       WHERE user_id = $1 AND page_id = $2
       LIMIT 1`,
      [req.session.userId, req.session.selectedPageId]
    );

    if (selected.rows.length) return selected.rows[0];
  }

  const result = await pool.query(
    `SELECT *
     FROM pages
     WHERE user_id = $1
     ORDER BY page_name
     LIMIT 1`,
    [req.session.userId]
  );

  if (!result.rows.length) return null;

  req.session.selectedPageId = result.rows[0].page_id;
  return result.rows[0];
}

async function getPageById(pageId, userId = null) {
  const result = userId
    ? await pool.query(
        `SELECT * FROM pages
         WHERE page_id = $1 AND user_id = $2
         ORDER BY connected_at DESC LIMIT 1`,
        [String(pageId), userId]
      )
    : await pool.query(
        `SELECT * FROM pages
         WHERE page_id = $1
         ORDER BY connected_at DESC LIMIT 1`,
        [String(pageId)]
      );

  return result.rows[0] || null;
}

async function getPageSettings(pageId) {
  await pool.query(
    `INSERT INTO settings(page_id)
     VALUES($1)
     ON CONFLICT(page_id) DO NOTHING`,
    [pageId]
  );

  const result = await pool.query(
    `SELECT * FROM settings WHERE page_id = $1`,
    [pageId]
  );

  return result.rows[0];
}

/* FACEBOOK LOGIN */

app.get("/auth/facebook", (req, res) => {
  const state = crypto.randomBytes(32).toString("hex");
  req.session.oauthState = state;

  const redirectUri = `${APP_BASE_URL}/auth/facebook/callback`;

  const loginUrl = new URL(
    `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`
  );

  loginUrl.searchParams.set("client_id", META_APP_ID);
  loginUrl.searchParams.set("redirect_uri", redirectUri);
  loginUrl.searchParams.set("config_id", META_LOGIN_CONFIG_ID);
  loginUrl.searchParams.set("state", state);
  loginUrl.searchParams.set("response_type", "code");
  loginUrl.searchParams.set("override_default_response_type", "true");

  req.session.save((error) => {
    if (error) {
      console.error("Login session error:", error.message);
      return res.status(500).send("Could not start Facebook login.");
    }
    res.redirect(loginUrl.toString());
  });
});

app.get("/auth/facebook/callback", asyncRoute(async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send("Facebook login was cancelled or denied.");
  }

  if (
    !code ||
    !state ||
    !req.session.oauthState ||
    state !== req.session.oauthState
  ) {
    return res.status(400).send(
      "Facebook login security check failed. Please try again."
    );
  }

  delete req.session.oauthState;

  const redirectUri = `${APP_BASE_URL}/auth/facebook/callback`;

  const tokenData = await graphGet("oauth/access_token", {
    client_id: META_APP_ID,
    client_secret: META_APP_SECRET,
    redirect_uri: redirectUri,
    code
  });

  const userAccessToken = tokenData.access_token;
  if (!userAccessToken) {
    throw new Error("Facebook did not return an access token.");
  }

  const profile = await graphGet("me", {
    fields: "id,name,email",
    access_token: userAccessToken
  });

  const userResult = await pool.query(
    `INSERT INTO users(facebook_id, name, email)
     VALUES($1,$2,$3)
     ON CONFLICT(facebook_id)
     DO UPDATE SET
       name = EXCLUDED.name,
       email = EXCLUDED.email
     RETURNING id, facebook_id, name, email`,
    [
      profile.id,
      profile.name || "Facebook User",
      profile.email || null
    ]
  );

  const user = userResult.rows[0];

  /*
    Fetch all Pages using pagination.
  */

  let after = null;
  let pageCount = 0;

  do {
    const params = {
      fields: "id,name,access_token,tasks",
      limit: 100,
      access_token: userAccessToken
    };

    if (after) params.after = after;

    const accounts = await graphGet("me/accounts", params);
    const pageList = accounts.data || [];

    for (const page of pageList) {
      if (!page.id || !page.access_token) continue;

      await pool.query(
        `INSERT INTO pages(
           user_id, page_id, page_name, encrypted_token
         )
         VALUES($1,$2,$3,$4)
         ON CONFLICT(user_id,page_id)
         DO UPDATE SET
           page_name = EXCLUDED.page_name,
           encrypted_token = EXCLUDED.encrypted_token`,
        [
          user.id,
          page.id,
          page.name || "Facebook Page",
          encryptToken(page.access_token)
        ]
      );

      try {
        await axios.post(
          `${GRAPH_BASE}/${page.id}/subscribed_apps`,
          null,
          {
            params: {
              subscribed_fields: "messages,messaging_postbacks,feed",
              access_token: page.access_token
            },
            timeout: 20000
          }
        );
      } catch (subscriptionError) {
        console.error(
          "Page webhook subscription failed:",
          subscriptionError.response?.data || subscriptionError.message
        );
      }

      pageCount++;
    }

    after = accounts.paging?.cursors?.after || null;
  } while (after && pageCount < 1000);

  req.session.userId = user.id;
  req.session.userName = user.name;

  const savedPages = await getUserPages(user.id);
  req.session.selectedPageId =
    savedPages.length ? savedPages[0].page_id : null;

  req.session.save((saveError) => {
    if (saveError) {
      console.error("Session save failed:", saveError.message);
      return res.status(500).send("Could not save your login.");
    }
    res.redirect("/");
  });
}));

/* LOGOUT */

app.get("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect("/");
  });
});

/* ACCOUNT AND PAGE API */

app.get("/api/me", asyncRoute(async (req, res) => {
  if (!req.session.userId) {
    return res.json({ loggedIn: false });
  }

  const pages = await getUserPages(req.session.userId);

  res.json({
    loggedIn: true,
    user: { name: req.session.userName || "Facebook User" },
    pages,
    selectedPageId: req.session.selectedPageId || null
  });
}));

app.post("/api/pages/select", requireLogin, asyncRoute(async (req, res) => {
  const pageId = String(req.body.pageId || "");

  const result = await pool.query(
    `SELECT page_id, page_name
     FROM pages
     WHERE user_id = $1 AND page_id = $2`,
    [req.session.userId, pageId]
  );

  if (!result.rows.length) {
    return res.status(404).json({
      error: "This Page is not connected to your account."
    });
  }

  req.session.selectedPageId = pageId;

  res.json({
    success: true,
    page: result.rows[0]
  });
}));

/* CHATBOT SETTINGS */

app.get("/api/settings", requireLogin, asyncRoute(async (req, res) => {
  const page = await getSelectedPage(req);

  if (!page) {
    return res.status(400).json({
      error: "Connect a Facebook Page first."
    });
  }

  res.json(await getPageSettings(page.page_id));
}));

app.post("/api/settings", requireLogin, asyncRoute(async (req, res) => {
  const page = await getSelectedPage(req);

  if (!page) {
    return res.status(400).json({
      error: "Connect a Facebook Page first."
    });
  }

  const welcomeMessage = String(req.body.welcome_message || "").trim();
  const defaultReply = String(req.body.default_reply || "").trim();
  const commentReply = String(req.body.comment_reply || "").trim();

  if (
    welcomeMessage.length > 2000 ||
    defaultReply.length > 2000 ||
    commentReply.length > 2000
  ) {
    return res.status(400).json({
      error: "Each reply must be 2000 characters or less."
    });
  }

  await pool.query(
    `INSERT INTO settings(
       page_id,
       welcome_enabled,
       welcome_message,
       default_enabled,
       default_reply,
       comment_enabled,
       comment_reply,
       updated_at
     )
     VALUES($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT(page_id)
     DO UPDATE SET
       welcome_enabled = EXCLUDED.welcome_enabled,
       welcome_message = EXCLUDED.welcome_message,
       default_enabled = EXCLUDED.default_enabled,
       default_reply = EXCLUDED.default_reply,
       comment_enabled = EXCLUDED.comment_enabled,
       comment_reply = EXCLUDED.comment_reply,
       updated_at = NOW()`,
    [
      page.page_id,
      req.body.welcome_enabled === true,
      welcomeMessage,
      req.body.default_enabled === true,
      defaultReply,
      req.body.comment_enabled === true,
      commentReply
    ]
  );

  res.json({
    success: true,
    message: "Chatbot settings saved successfully."
  });
}));

/* MESSENGER SENDING */

async function sendMessengerMessage(pageId, token, psid, message) {
  return graphPost(
    `${pageId}/messages`,
    {
      recipient: { id: psid },
      messaging_type: "RESPONSE",
      message: { text: message }
    },
    token
  );
}

/* EVENT DEDUPLICATION */

async function claimEvent(eventId) {
  const result = await pool.query(
    `INSERT INTO processed_events(event_id, status, updated_at)
     VALUES($1, 'processing', NOW())
     ON CONFLICT(event_id)
     DO UPDATE SET
       status = 'processing',
       updated_at = NOW()
     WHERE processed_events.status = 'failed'
        OR (
          processed_events.status = 'processing'
          AND processed_events.updated_at < NOW() - INTERVAL '5 minutes'
        )
     RETURNING event_id`,
    [eventId]
  );

  return result.rowCount > 0;
}

async function finishEvent(eventId, success) {
  await pool.query(
    `UPDATE processed_events
     SET status = $2, updated_at = NOW()
     WHERE event_id = $1`,
    [eventId, success ? "processed" : "failed"]
  );
}

/* INCOMING MESSENGER MESSAGES */

async function processMessage(pageId, event) {
  if (!event.sender?.id || event.message?.is_echo) return;

  const psid = String(event.sender.id);
  const messageId = event.message?.mid;
  const eventId = messageId
    ? `message:${pageId}:${messageId}`
    : null;

  if (eventId && !(await claimEvent(eventId))) return;

  try {
    const page = await getPageById(pageId);
    if (!page) return;

    const token = decryptToken(page.encrypted_token);
    const settings = await getPageSettings(pageId);

    await pool.query(
      `INSERT INTO contacts(page_id, psid, last_interaction, first_message)
       VALUES($1,$2,NOW(),TRUE)
       ON CONFLICT(page_id,psid)
       DO UPDATE SET last_interaction = NOW()`,
      [pageId, psid]
    );

    /*
      Claim the first welcome reply safely.
      If sending fails, release the claim so it can be tried again.
    */

    const claim = await pool.query(
      `UPDATE contacts
       SET welcome_claimed_at = NOW()
       WHERE page_id = $1
         AND psid = $2
         AND first_message = TRUE
         AND (
           welcome_claimed_at IS NULL
           OR welcome_claimed_at < NOW() - INTERVAL '5 minutes'
         )
       RETURNING psid`,
      [pageId, psid]
    );

    const isFirstMessage = claim.rowCount > 0;

    let reply = "";

    if (isFirstMessage && settings.welcome_enabled && settings.welcome_message) {
      reply = settings.welcome_message;
    } else if (settings.default_enabled && settings.default_reply) {
      reply = settings.default_reply;
    }

    if (!reply) {
      if (isFirstMessage) {
        await pool.query(
          `UPDATE contacts
           SET first_message = FALSE, welcome_claimed_at = NULL
           WHERE page_id = $1 AND psid = $2`,
          [pageId, psid]
        );
      }

      if (eventId) await finishEvent(eventId, true);
      return;
    }

    try {
      await sendMessengerMessage(pageId, token, psid, reply);

      if (isFirstMessage) {
        await pool.query(
          `UPDATE contacts
           SET first_message = FALSE, welcome_claimed_at = NULL
           WHERE page_id = $1 AND psid = $2`,
          [pageId, psid]
        );
      }

      if (eventId) await finishEvent(eventId, true);
    } catch (error) {
      if (isFirstMessage) {
        await pool.query(
          `UPDATE contacts
           SET welcome_claimed_at = NULL
           WHERE page_id = $1 AND psid = $2`,
          [pageId, psid]
        );
      }

      throw error;
    }
  } catch (error) {
    if (eventId) await finishEvent(eventId, false);
    throw error;
  }
}

/* AUTOMATIC COMMENT PRIVATE REPLY */

async function processComment(pageId, value) {
  if (
    !value ||
    value.item !== "comment" ||
    value.verb !== "add"
  ) return;

  const commentId = value.comment_id || value.id;
  if (!commentId) return;

  if (value.from && String(value.from.id) === String(pageId)) return;

  const eventId = `comment:${pageId}:${commentId}`;
  if (!(await claimEvent(eventId))) return;

  try {
    const page = await getPageById(pageId);
    if (!page) {
      await finishEvent(eventId, true);
      return;
    }

    const settings = await getPageSettings(pageId);

    if (!settings.comment_enabled || !settings.comment_reply) {
      await finishEvent(eventId, true);
      return;
    }

    const token = decryptToken(page.encrypted_token);

    await graphPost(
      `${commentId}/private_replies`,
      { message: settings.comment_reply },
      token
    );

    await finishEvent(eventId, true);
    console.log("Comment private reply sent:", commentId);
  } catch (error) {
    await finishEvent(eventId, false);
    throw error;
  }
}

/* WEBHOOK EVENT PROCESSING */

async function processWebhookPayload(payload) {
  if (!payload || !Array.isArray(payload.entry)) return;

  for (const entry of payload.entry) {
    const pageId = String(entry.id || "");
    if (!pageId) continue;

    if (Array.isArray(entry.messaging)) {
      for (const event of entry.messaging) {
        try {
          await processMessage(pageId, event);
        } catch (error) {
          console.error(
            "Message event failed:",
            error.response?.data || error.message
          );
        }
      }
    }

    if (Array.isArray(entry.changes)) {
      for (const change of entry.changes) {
        if (change.field === "feed") {
          try {
            await processComment(pageId, change.value);
          } catch (error) {
            console.error(
              "Comment event failed:",
              error.response?.data || error.message
            );
          }
        }
      }
    }
  }
}

/* FACEBOOK WEBHOOK */

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Facebook webhook verified.");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook", (req, res) => {
  const signature = req.headers["x-hub-signature-256"];
  const rawBody = req.rawBody;

  if (!signature || !Buffer.isBuffer(rawBody)) {
    return res.sendStatus(401);
  }

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", META_APP_SECRET)
      .update(rawBody)
      .digest("hex");

  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
  ) {
    return res.sendStatus(401);
  }

  let payload;

  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.sendStatus(400);
  }

  res.sendStatus(200);

  processWebhookPayload(payload).catch((error) => {
    console.error("Webhook processing failed:", error);
  });
});

/* BROADCASTING */

async function sendBroadcast(broadcast) {
  const page = await getPageById(broadcast.page_id, broadcast.user_id);

  if (!page) {
    throw new Error("Connected Facebook Page was not found.");
  }

  const token = decryptToken(page.encrypted_token);

  const contacts = await pool.query(
    `SELECT psid
     FROM contacts
     WHERE page_id = $1
       AND last_interaction > NOW() - INTERVAL '24 hours'
     ORDER BY last_interaction DESC
     LIMIT 5000`,
    [broadcast.page_id]
  );

  let sent = 0;
  let failed = 0;

  for (const contact of contacts.rows) {
    try {
      await sendMessengerMessage(
        broadcast.page_id,
        token,
        contact.psid,
        broadcast.message
      );
      sent++;
    } catch (error) {
      failed++;
      console.error(
        "Broadcast delivery failed:",
        error.response?.data || error.message
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return {
    sent,
    failed,
    eligible: contacts.rowCount
  };
}

/* CREATE OR SCHEDULE BROADCAST */

app.post("/api/broadcasts", requireLogin, asyncRoute(async (req, res) => {
  const page = await getSelectedPage(req);

  if (!page) {
    return res.status(400).json({
      error: "Connect a Facebook Page first."
    });
  }

  const message = String(req.body.message || "").trim();

  if (!message) {
    return res.status(400).json({
      error: "Enter a broadcast message."
    });
  }

  if (message.length > 2000) {
    return res.status(400).json({
      error: "Message must be 2000 characters or less."
    });
  }

  let scheduleDate = null;

  if (req.body.scheduledAt) {
    scheduleDate = new Date(req.body.scheduledAt);

    if (Number.isNaN(scheduleDate.getTime())) {
      return res.status(400).json({
        error: "Invalid scheduled date and time."
      });
    }

    if (scheduleDate.getTime() <= Date.now()) {
      return res.status(400).json({
        error: "Choose a future date and time."
      });
    }
  }

  const status = scheduleDate ? "scheduled" : "sending";

  const created = await pool.query(
    `INSERT INTO broadcasts(
       user_id, page_id, message, scheduled_at, status, locked_at
     )
     VALUES($1,$2,$3,$4,$5,CASE WHEN $5 = 'sending' THEN NOW() ELSE NULL END)
     RETURNING *`,
    [
      req.session.userId,
      page.page_id,
      message,
      scheduleDate,
      status
    ]
  );

  const broadcast = created.rows[0];

  if (scheduleDate) {
    return res.json({
      success: true,
      message: "Broadcast scheduled successfully.",
      broadcast
    });
  }

  try {
    const result = await sendBroadcast(broadcast);

    await pool.query(
      `UPDATE broadcasts
       SET status = 'completed',
           sent_count = $1,
           failed_count = $2,
           completed_at = NOW(),
           locked_at = NULL
       WHERE id = $3 AND user_id = $4`,
      [result.sent, result.failed, broadcast.id, req.session.userId]
    );

    return res.json({
      success: true,
      message: "Broadcast completed.",
      sent: result.sent,
      failed: result.failed,
      eligible: result.eligible
    });
  } catch (error) {
    await pool.query(
      `UPDATE broadcasts
       SET status = 'failed',
           completed_at = NOW(),
           locked_at = NULL
       WHERE id = $1 AND user_id = $2`,
      [broadcast.id, req.session.userId]
    );

    throw error;
  }
}));

/* BROADCAST HISTORY */

app.get("/api/broadcasts", requireLogin, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT
       id, page_id, message, scheduled_at, status,
       sent_count, failed_count, created_at, completed_at
     FROM broadcasts
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [req.session.userId]
  );

  res.json(result.rows);
}));

/* SCHEDULED BROADCAST WORKER */

let workerRunning = false;

async function processDueBroadcasts() {
  if (workerRunning) return;

  workerRunning = true;

  try {
    /*
      Recover jobs left in sending state after a server crash.
      This may retry a job that had partially sent before the crash.
    */

    await pool.query(
      `UPDATE broadcasts
       SET status = 'scheduled', locked_at = NULL
       WHERE status = 'sending'
         AND locked_at < NOW() - INTERVAL '30 minutes'`
    );

    for (let count = 0; count < 3; count++) {
      const client = await pool.connect();
      let broadcast = null;

      try {
        await client.query("BEGIN");

        const result = await client.query(`
          WITH next_job AS (
            SELECT id
            FROM broadcasts
            WHERE status = 'scheduled'
              AND scheduled_at <= NOW()
            ORDER BY scheduled_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE broadcasts AS b
          SET status = 'sending',
              locked_at = NOW()
          FROM next_job
          WHERE b.id = next_job.id
          RETURNING b.*
        `);

        broadcast = result.rows[0] || null;
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      if (!broadcast) break;

      try {
        const result = await sendBroadcast(broadcast);

        await pool.query(
          `UPDATE broadcasts
           SET status = 'completed',
               sent_count = $1,
               failed_count = $2,
               completed_at = NOW(),
               locked_at = NULL
           WHERE id = $3`,
          [result.sent, result.failed, broadcast.id]
        );

        console.log(`Scheduled broadcast ${broadcast.id} completed.`);
      } catch (error) {
        console.error(
          "Scheduled broadcast failed:",
          error.response?.data || error.message
        );

        await pool.query(
          `UPDATE broadcasts
           SET status = 'failed',
               completed_at = NOW(),
               locked_at = NULL
           WHERE id = $1`,
          [broadcast.id]
        );
      }
    }
  } catch (error) {
    console.error("Broadcast worker error:", error.message);
  } finally {
    workerRunning = false;
  }
}

/* HEALTH CHECK */

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    app: "IchaBot"
  });
});

/* HOME PAGE */

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ERROR HANDLER */

app.use((error, req, res, next) => {
  console.error(
    "Application error:",
    error.response?.data || error.stack || error.message
  );

  if (res.headersSent) return next(error);

  res.status(500).json({
    error: "Something went wrong. Check the Render logs."
  });
});

/* START SERVER */

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`IchaBot is running on port ${PORT}`);
      console.log(`App URL: ${APP_BASE_URL}`);
      console.log(`Graph API: ${GRAPH_VERSION}`);

      processDueBroadcasts();
      setInterval(processDueBroadcasts, 15000);
    });
  })
  .catch((error) => {
    console.error("IchaBot could not start:", error);
    process.exit(1);
  });
