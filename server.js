const express = require("express");
const axios = require("axios");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const APP_SECRET = process.env.APP_SECRET;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

// PostgreSQL connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL
        ? { rejectUnauthorized: false }
        : false
});

// Serve dashboard files
app.use(express.static(path.join(__dirname, "public")));

// Facebook webhook needs the original request body
app.use(express.json({
    verify: (req, res, buffer) => {
        req.rawBody = buffer;
    }
}));

// -------------------------------
// DATABASE SETUP
// -------------------------------

async function setupDatabase() {
    try {
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
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

        console.log("Database tables ready");

    } catch (error) {
        console.error("Database setup error:", error.message);
    }
}

// -------------------------------
// DASHBOARD
// -------------------------------

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Health check
app.get("/health", (req, res) => {
    res.json({
        status: "online",
        application: "IchaBot Professional",
        database: "configured"
    });
});

// -------------------------------
// FACEBOOK WEBHOOK VERIFICATION
// -------------------------------

app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("Facebook webhook verified");
        return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
});

// -------------------------------
// VERIFY FACEBOOK SIGNATURE
// -------------------------------

function verifySignature(req) {
    // Allows local testing when APP_SECRET is not configured
    if (!APP_SECRET) {
        return true;
    }

    if (!req.rawBody) {
        return false;
    }

    const signature = req.headers["x-hub-signature-256"];

    if (!signature) {
        return false;
    }

    const expected =
        "sha256=" +
        crypto
            .createHmac("sha256", APP_SECRET)
            .update(req.rawBody)
            .digest("hex");

    const receivedBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);

    if (receivedBuffer.length !== expectedBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(
        receivedBuffer,
        expectedBuffer
    );
}

// -------------------------------
// SAVE OR UPDATE USER
// -------------------------------

async function saveUser(pageId, userId) {
    try {
        await pool.query(
            `
            INSERT INTO chatbot_users
            (page_id, facebook_user_id, last_message_at)
            VALUES ($1, $2, CURRENT_TIMESTAMP)

            ON CONFLICT (page_id, facebook_user_id)
            DO UPDATE SET
            last_message_at = CURRENT_TIMESTAMP
            `,
            [pageId, userId]
        );

    } catch (error) {
        console.error("Save user error:", error.message);
    }
}

// -------------------------------
// SEND MESSENGER MESSAGE
// -------------------------------

async function sendMessage(userId, message) {

    if (!PAGE_ACCESS_TOKEN) {
        console.error("PAGE_ACCESS_TOKEN is missing");
        return false;
    }

    try {
        await axios.post(
            "https://graph.facebook.com/v23.0/me/messages",
            {
                recipient: {
                    id: userId
                },
                message: {
                    text: message
                }
            },
            {
                params: {
                    access_token: PAGE_ACCESS_TOKEN
                }
            }
        );

        console.log("Message sent successfully");
        return true;

    } catch (error) {

        console.error(
            "Messenger error:",
            error.response?.data || error.message
        );

        return false;
    }
}

// -------------------------------
// KEYWORD AUTO REPLY
// -------------------------------

async function getKeywordReply(pageId, message) {

    try {

        const result = await pool.query(
            `
            SELECT reply
            FROM keyword_replies
            WHERE active = TRUE
            AND (page_id = $1 OR page_id IS NULL)
            `,
            [pageId]
        );

        const lowerMessage = message.toLowerCase();

        for (const rule of result.rows) {

            const keyword = rule.keyword.toLowerCase();

            if (lowerMessage.includes(keyword)) {
                return rule.reply;
            }
        }

        return null;

    } catch (error) {

        console.error(
            "Keyword reply error:",
            error.message
        );

        return null;
    }
}

// -------------------------------
// COMMENT REPLY
// -------------------------------

async function replyToComment(commentId, message) {

    if (!PAGE_ACCESS_TOKEN) {
        return false;
    }

    try {

        await axios.post(
            `https://graph.facebook.com/v23.0/${commentId}/comments`,
            {
                message: message
            },
            {
                params: {
                    access_token: PAGE_ACCESS_TOKEN
                }
            }
        );

        console.log("Comment reply sent");
        return true;

    } catch (error) {

        console.error(
            "Comment reply error:",
            error.response?.data || error.message
        );

        return false;
    }
}

// -------------------------------
// COMMENT AUTOMATION
// -------------------------------

async function processComment(pageId, commentId, message) {

    try {

        const result = await pool.query(
            `
            SELECT keyword, reply
            FROM comment_rules
            WHERE active = TRUE
            AND (page_id = $1 OR page_id IS NULL)
            `,
            [pageId]
        );

        const lowerMessage =
            (message || "").toLowerCase();

        for (const rule of result.rows) {

            if (
                lowerMessage.includes(
                    rule.keyword.toLowerCase()
                )
            ) {

                await replyToComment(
                    commentId,
                    rule.reply
                );

                break;
            }
        }

    } catch (error) {

        console.error(
            "Comment automation error:",
            error.message
        );
    }
}

// -------------------------------
// FACEBOOK WEBHOOK EVENTS
// -------------------------------

app.post("/webhook", async (req, res) => {

    if (!verifySignature(req)) {
        console.error(
            "Webhook signature verification failed"
        );

        return res.sendStatus(401);
    }

    // Respond quickly to Facebook
    res.sendStatus(200);

    try {

        const body = req.body;

        if (body.object !== "page") {
            return;
        }

        for (const entry of body.entry || []) {

            const pageId = entry.id;

            // MESSENGER EVENTS
            for (const event of entry.messaging || []) {

                if (
                    event.message &&
                    !event.message.is_echo
                ) {

                    const userId = event.sender.id;

                    const incomingMessage =
                        (event.message.text || "").trim();

                    await saveUser(
                        pageId,
                        userId
                    );

                    if (!incomingMessage) {
                        continue;
                    }

                    console.log(
                        "Incoming message:",
                        incomingMessage
                    );

                    // Check keyword replies first
                    let reply =
                        await getKeywordReply(
                            pageId,
                            incomingMessage
                        );

                    // Default reply
                    if (!reply) {
                        reply =
                            "Welcome to IchaBot! Thanks for contacting us. How can we help you?";
                    }

                    await sendMessage(
                        userId,
                        reply
                    );
                }
            }

            // COMMENT EVENTS
            for (const change of entry.changes || []) {

                if (
                    change.field === "feed" &&
                    change.value
                ) {

                    const value = change.value;

                    if (
                        value.item === "comment" &&
                        value.comment_id &&
                        value.message
                    ) {

                        await processComment(
                            pageId,
                            value.comment_id,
                            value.message
                        );
                    }
                }
            }
        }

    } catch (error) {

        console.error(
            "Webhook processing error:",
            error.message
        );
    }
});

// -------------------------------
// SCHEDULED MESSAGES
// -------------------------------

async function processScheduledMessages() {

    try {

        const result = await pool.query(
            `
            SELECT *
            FROM scheduled_messages
            WHERE sent = FALSE
            AND scheduled_for <= CURRENT_TIMESTAMP
            `
        );

        for (const scheduled of result.rows) {

            const success = await sendMessage(
                scheduled.facebook_user_id,
                scheduled.message
            );

            if (success) {

                await pool.query(
                    `
                    UPDATE scheduled_messages
                    SET sent = TRUE
                    WHERE id = $1
                    `,
                    [scheduled.id]
                );
            }
        }

    } catch (error) {

        console.error(
            "Scheduled message error:",
            error.message
        );
    }
}

// Check scheduled messages every minute
setInterval(
    processScheduledMessages,
    60 * 1000
);

// -------------------------------
// START SERVER
// -------------------------------

setupDatabase().then(() => {

    app.listen(PORT, () => {

        console.log(
            `IchaBot Professional running on port ${PORT}`
        );

    });

});

        
