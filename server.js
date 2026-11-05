const express = require("express");
const axios = require("axios");
const path = require("path");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const APP_SECRET = process.env.APP_SECRET;

// Get Facebook Page access tokens
function getPageTokens() {
    try {
        return JSON.parse(process.env.PAGE_TOKENS_JSON || "{}");
    } catch (error) {
        console.error("Invalid PAGE_TOKENS_JSON");
        return {};
    }
}

// Serve dashboard files
app.use(express.static(path.join(__dirname, "public")));

// Capture original request body
app.use(express.json({
    verify: (req, res, buffer) => {
        req.rawBody = buffer;
    }
}));

// Dashboard
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Health check
app.get("/health", (req, res) => {
    res.json({
        status: "online",
        application: "IchaBot Professional"
    });
});

// Facebook webhook verification
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

// Verify Facebook webhook signature
function verifySignature(req) {
    if (!APP_SECRET || !req.rawBody) {
        return false;
    }

    const signature = req.headers["x-hub-signature-256"];

    if (!signature) {
        return false;
    }

    const expected = "sha256=" + crypto
        .createHmac("sha256", APP_SECRET)
        .update(req.rawBody)
        .digest("hex");

    const receivedBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);

    return receivedBuffer.length === expectedBuffer.length &&
        crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

// Send Messenger reply
async function sendMessage(pageId, userId, message) {
    const tokens = getPageTokens();

    const pageToken =
        tokens[pageId] || process.env.PAGE_ACCESS_TOKEN;

    if (!pageToken) {
        console.error("No token configured for Page:", pageId);
        return;
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
                    access_token: pageToken
                }
            }
        );

        console.log("Messenger reply sent successfully");

    } catch (error) {
        console.error(
            "Messenger error:",
            error.response?.data || error.message
        );
    }
}

// Receive Facebook webhook events
app.post("/webhook", async (req, res) => {

    if (!verifySignature(req)) {
        console.error("Webhook signature verification failed");
        return res.sendStatus(401);
    }

    res.sendStatus(200);

    console.log("Facebook webhook received");

    try {
        const body = req.body;

        if (body.object !== "page") {
            return;
        }

        for (const entry of body.entry || []) {
            const pageId = entry.id;

            for (const event of entry.messaging || []) {

                if (event.message && !event.message.is_echo) {
                    const senderId = event.sender.id;
                    const message =
                        (event.message.text || "").trim();

                    console.log("Incoming message:", message);

                    if (!message) {
                        continue;
                    }

                    const reply =
                        "Welcome to IchaBot! Thanks for contacting us. How can we help you?";

                    await sendMessage(
                        pageId,
                        senderId,
                        reply
                    );
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

// Start application
app.listen(PORT, () => {
    console.log(
        "IchaBot Professional running on port " + PORT
    );
});
