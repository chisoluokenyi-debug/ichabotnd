const express = require("express");
const axios = require("axios");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const APP_SECRET = process.env.APP_SECRET;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL
        ? { rejectUnauthorized: false }
        : false
});

// Temporary dashboard sessions.
// Sessions expire when the server restarts.
const sessions = new Map();

app.use(express.static(path.join(__dirname, "public")));

app.use(express.json({
    verify: (req, res, buffer) => {
        req.rawBody = buffer;
    }
}));

// -------------------------
// DATABASE
// -------------------------

async function setupDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chatbot_users (
            id SERIAL PRIMARY KEY,
            page_id TEXT NOT NULL,
            facebook_user_id TEXT NOT NULL,
            last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(page_id, facebook_user_id)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS keyword_replies (
            id SERIAL PRIMARY KEY,
            page_id TEXT,
            keyword TEXT NOT NULL,
            reply TEXT NOT NULL,
            active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS scheduled_messages (
            id SERIAL PRIMARY KEY,
            page_id TEXT NOT NULL,
            facebook_user_id TEXT NOT NULL,
            message TEXT NOT NULL,
            scheduled_for TIMESTAMP NOT NULL,
            sent BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS broadcasts (
            id SERIAL PRIMARY KEY,
            page_id TEXT NOT NULL,
            message TEXT NOT NULL,
            status TEXT DEFAULT 'draft',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        ALTER TABLE broadcasts
        ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft'
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS comment_rules (
            id SERIAL PRIMARY KEY,
            page_id TEXT,
            keyword TEXT NOT NULL,
            reply TEXT NOT NULL,
            active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    console.log("IchaBot database tables ready");
}

// -------------------------
// DASHBOARD
// -------------------------

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/health", (req, res) => {
    res.json({
        status: "online",
        application: "IchaBot Professional"
    });
});

// -------------------------
// DASHBOARD LOGIN
// -------------------------

app.post("/api/login", (req, res) => {
    if (!DASHBOARD_PASSWORD) {
        return res.status(503).json({
            error: "Dashboard password is not configured"
        });
    }

    const password = String(req.body.password || "");

    const supplied = Buffer.from(password);
    const expected = Buffer.from(DASHBOARD_PASSWORD);

    if (
        supplied.length !== expected.length ||
        !crypto.timingSafeEqual(supplied, expected)
    ) {
        return res.status(401).json({
            error: "Incorrect password"
        });
    }

    const token = crypto.randomBytes(32).toString("hex");

    sessions.set(token, Date.now() + 8 * 60 * 60 * 1000);

    res.json({
        success: true,
        token: token
    });
});

function requireLogin(req, res, next) {
    const authorization = req.headers.authorization || "";
    const token = authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";

    const expires = sessions.get(token);

    if (!expires || expires < Date.now()) {
        sessions.delete(token);

        return res.status(401).json({
            error: "Please log in again"
        });
    }

    next();
}

app.post("/api/logout", requireLogin, (req, res) => {
    const token = req.headers.authorization.slice(7);
    sessions.delete(token);

    res.json({ success: true });
});

// -------------------------
// KEYWORD REPLY MANAGEMENT
// -------------------------

app.get("/api/keyword-replies", requireLogin, async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM keyword_replies ORDER BY id DESC"
        );

        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: "Could not load keyword rules" });
    }
});

app.post("/api/keyword-replies", requireLogin, async (req, res) => {
    const { page_id, keyword, reply } = req.body;

    if (!keyword || !reply) {
        return res.status(400).json({
            error: "Keyword and reply are required"
        });
    }

    try {
        const result = await pool.query(
            `INSERT INTO keyword_replies
             (page_id, keyword, reply)
             VALUES ($1, $2, $3)
             RETURNING *`,
            [page_id || null, keyword.trim(), reply.trim()]
        );

        res.json({
            success: true,
            rule: result.rows[0]
        });
    } catch (error) {
        res.status(500).json({ error: "Could not save keyword rule" });
    }
});

app.delete("/api/keyword-replies/:id", requireLogin, async (req, res) => {
    try {
        await pool.query(
            "DELETE FROM keyword_replies WHERE id = $1",
            [req.params.id]
        );

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Could not delete keyword rule" });
    }
});

// -------------------------
// COMMENT RULE MANAGEMENT
// -------------------------

app.get("/api/comment-rules", requireLogin, async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM comment_rules ORDER BY id DESC"
        );

        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: "Could not load comment rules" });
    }
});

app.post("/api/comment-rules", requireLogin, async (req, res) => {
    const { page_id, keyword, reply } = req.body;

    if (!keyword || !reply) {
        return res.status(400).json({
            error: "Keyword and reply are required"
        });
    }

    try {
        const result = await pool.query(
            `INSERT INTO comment_rules
             (page_id, keyword, reply)
             VALUES ($1, $2, $3)
             RETURNING *`,
            [page_id || null, keyword.trim(), reply.trim()]
        );

        res.json({
            success: true,
            rule: result.rows[0]
        });
    } catch (error) {
        res.status(500).json({ error: "Could not save comment rule" });
    }
});

app.delete("/api/comment-rules/:id", requireLogin, async (req, res) => {
    try {
        await pool.query(
            "DELETE FROM comment_rules WHERE id = $1",
            [req.params.id]
        );

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Could not delete comment rule" });
    }
});

// -------------------------
// SCHEDULED MESSAGE MANAGEMENT
// -------------------------

app.get("/api/scheduled-messages", requireLogin, async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM scheduled_messages ORDER BY scheduled_for DESC"
        );

        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: "Could not load scheduled messages" });
    }
});

app.post("/api/scheduled-messages", requireLogin, async (req, res) => {
    const { page_id, facebook_user_id, message, scheduled_for } = req.body;

    if (!page_id || !facebook_user_id || !message || !scheduled_for) {
        return res.status(400).json({
            error: "Page ID, recipient ID, message and schedule are required"
        });
    }

    const date = new Date(scheduled_for);

    if (Number.isNaN(date.getTime()) || date <= new Date()) {
        return res.status(400).json({
            error: "Choose a valid future date and time"
        });
    }

    try {
        const result = await pool.query(
            `INSERT INTO scheduled_messages
             (page_id, facebook_user_id, message, scheduled_for)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [page_id, facebook_user_id, message.trim(), date]
        );

        res.json({
            success: true,
            scheduled: result.rows[0]
        });
    } catch (error) {
        res.status(500).json({ error: "Could not schedule message" });
    }
});

// -------------------------
// BROADCAST DRAFTS
// -------------------------

app.get("/api/broadcasts", requireLogin, async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM broadcasts ORDER BY id DESC"
        );

        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: "Could not load broadcasts" });
    }
});

app.post("/api/broadcasts", requireLogin, async (req, res) => {
    const { page_id, message } = req.body;

    if (!page_id || !message) {
        return res.status(400).json({
            error: "Page ID and message are required"
        });
    }

    try {
        const result = await pool.query(
            `INSERT INTO broadcasts (page_id, message, status)
             VALUES ($1, $2, 'draft')
             RETURNING *`,
            [page_id, message.trim()]
        );

        res.json({
            success: true,
            broadcast: result.rows[0],
            notice: "Saved as a draft. Delivery is not enabled."
        });
    } catch (error) {
        res.status(500).json({ error: "Could not save broadcast" });
    }
});

// -------------------------
// FACEBOOK PAGE TOKENS
// -------------------------

function getPageToken(pageId) {
    try {
        const tokens = JSON.parse(
            process.env.PAGE_TOKENS_JSON || "{}"
        );

        return tokens[pageId] || process.env.PAGE_ACCESS_TOKEN;
    } catch (error) {
        return process.env.PAGE_ACCESS_TOKEN;
    }
}

// -------------------------
// SEND MESSENGER MESSAGE
// -------------------------

async function sendMessage(pageId, userId, message) {
    const pageToken = getPageToken(pageId);

    if (!pageToken) {
        console.error("No access token for Page:", pageId);
        return false;
    }

    try {
        await axios.post(
            "https://graph.facebook.com/v23.0/me/messages",
            {
                recipient: { id: userId },
                message: { text: message }
            },
            {
                params: { access_token: pageToken }
            }
        );

        return true;
    } catch (error) {
        console.error(
            "Messenger error:",
            error.response?.data || error.message
        );

        return false;
    }
}

// -------------------------
// WEBHOOK SIGNATURE CHECK
// -------------------------

function verifySignature(req) {
    if (!APP_SECRET || !req.rawBody) {
        return false;
    }

    const signature = req.headers["x-hub-signature-256"];

    if (!signature) return false;

    const expected = "sha256=" + crypto
        .createHmac("sha256", APP_SECRET)
        .update(req.rawBody)
        .digest("hex");

    const receivedBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);

    return receivedBuffer.length === expectedBuffer.length &&
        crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

// -------------------------
// FACEBOOK WEBHOOK VERIFY
// -------------------------

app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }

    res.sendStatus(403);
});

// -------------------------
// SAVE MESSENGER USER
// -------------------------

async function saveUser(pageId, userId) {
    await pool.query(
        `INSERT INTO chatbot_users
         (page_id, facebook_user_id, last_message_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (page_id, facebook_user_id)
         DO UPDATE SET last_message_at = CURRENT_TIMESTAMP`,
        [pageId, userId]
    );
}

// -------------------------
// FIND KEYWORD REPLY
// -------------------------

async function getKeywordReply(pageId, message) {
    const result = await pool.query(
        `SELECT keyword, reply
         FROM keyword_replies
         WHERE active = TRUE
         AND (page_id = $1 OR page_id IS NULL)
         ORDER BY id DESC`,
        [pageId]
    );

    const text = message.toLowerCase();

    const rule = result.rows.find(item =>
        text.includes(item.keyword.toLowerCase())
    );

    return rule ? rule.reply : null;
}

// -------------------------
// COMMENT AUTOMATION
// -------------------------

async function processComment(pageId, commentId, message) {
    const result = await pool.query(
        `SELECT keyword, reply
         FROM comment_rules
         WHERE active = TRUE
         AND (page_id = $1 OR page_id IS NULL)`,
        [pageId]
    );

    const text = message.toLowerCase();

    const rule = result.rows.find(item =>
        text.includes(item.keyword.toLowerCase())
    );

    if (!rule) return;

    const pageToken = getPageToken(pageId);

    if (!pageToken) return;

    try {
        await axios.post(
            `https://graph.facebook.com/v23.0/${commentId}/comments`,
            { message: rule.reply },
            { params: { access_token: pageToken } }
        );
    } catch (error) {
        console.error(
            "Comment reply error:",
            error.response?.data || error.message
        );
    }
}

// -------------------------
// FACEBOOK WEBHOOK EVENTS
// -------------------------

app.post("/webhook", async (req, res) => {
    if (!verifySignature(req)) {
        return res.sendStatus(401);
    }

    res.sendStatus(200);

    try {
        const body = req.body;

        if (body.object !== "page") return;

        for (const entry of body.entry || []) {
            const pageId = entry.id;

            for (const event of entry.messaging || []) {
                if (event.message && !event.message.is_echo) {
                    const userId = event.sender.id;
                    const message = (event.message.text || "").trim();

                    await saveUser(pageId, userId);

                    if (!message) continue;

                    const reply = await getKeywordReply(pageId, message);

                    if (reply) {
                        await sendMessage(pageId, userId, reply);
                    } else {
                        await sendMessage(
                            pageId,
                            userId,
                            "Welcome to IchaBot! Thanks for contacting us. How can we help you?"
                        );
                    }
                }
            }

            for (const change of entry.changes || []) {
                if (
                    change.field === "feed" &&
                    change.value?.item === "comment" &&
                    change.value.comment_id &&
                    change.value.message
                ) {
                    await processComment(
                        pageId,
                        change.value.comment_id,
                        change.value.message
                    );
                }
            }
        }
    } catch (error) {
        console.error("Webhook processing error:", error.message);
    }
});

// -------------------------
// SCHEDULED MESSAGE WORKER
// -------------------------

async function processScheduledMessages() {
    try {
        const result = await pool.query(
            `SELECT *
             FROM scheduled_messages
             WHERE sent = FALSE
             AND scheduled_for <= CURRENT_TIMESTAMP
             ORDER BY scheduled_for ASC
             LIMIT 20`
        );

        for (const item of result.rows) {
            const success = await sendMessage(
                item.page_id,
                item.facebook_user_id,
                item.message
            );

            if (success) {
                await pool.query(
                    "UPDATE scheduled_messages SET sent = TRUE WHERE id = $1",
                    [item.id]
                );
            }
        }
    } catch (error) {
        console.error("Schedule worker error:", error.message);
    }
}

setInterval(processScheduledMessages, 60 * 1000);

// -------------------------
// START SERVER
// -------------------------

async function startServer() {
    try {
        await setupDatabase();

        app.listen(PORT, () => {
            console.log("IchaBot Professional running on port " + PORT);
        });
    } catch (error) {
        console.error("Could not start IchaBot:", error.message);
        process.exit(1);
    }
}

startServer();



        
