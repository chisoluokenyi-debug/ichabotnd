
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const APP_SECRET = process.env.APP_SECRET;

app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

// Dashboard homepage
app.get("/", (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>IchaBot Professional</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body {
                margin: 0;
                background: #101827;
                color: white;
                font-family: Arial, sans-serif;
            }
            header {
                background: #17243a;
                padding: 22px;
                font-size: 25px;
                font-weight: bold;
            }
            main {
                padding: 25px;
                max-width: 900px;
                margin: auto;
            }
            .card {
                background: #1d2b43;
                padding: 22px;
                border-radius: 12px;
                margin: 15px 0;
            }
            .status {
                color: #22c55e;
                font-weight: bold;
            }
        </style>
    </head>
    <body>
        <header>IchaBot</header>
        <main>
            <h1>Professional Dashboard</h1>
            <p>Manage your Facebook Messenger automation.</p>

            <div class="card">
                <h3>System Status</h3>
                <p class="status">● Server Online</p>
            </div>

            <div class="card">
                <h3>Facebook Pages</h3>
                <p>Multi-page management setup</p>
                <p>Coming in the next setup stage.</p>
            </div>

            <div class="card">
                <h3>Messenger Automation</h3>
                <p>Webhook service ready for configuration.</p>
            </div>

            <div class="card">
                <h3>Comment Automation</h3>
                <p>Comment management setup coming next.</p>
            </div>
        </main>
    </body>
    </html>
    `);
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

// Verify Meta webhook signature
function verifySignature(req) {
    if (!APP_SECRET) {
        console.error("Missing APP_SECRET");
        return false;
    }

    const signature = req.headers["x-hub-signature-256"];

    if (!signature || !req.rawBody) {
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

// Receive Facebook webhook events
app.post("/webhook", async (req, res) => {
    if (!verifySignature(req)) {
        console.error("Invalid webhook signature");
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
            for (const event of entry.messaging || []) {
                if (event.message && !event.message.is_echo) {
                    console.log("Incoming Messenger message");

                    const senderId = event.sender.id;
                    const message = event.message.text || "";

                    if (message) {
                        console.log("Message:", message);

                        // Multi-page token routing will be added
                        // after the Page connection system is ready.
                    }
                }
            }
        }
    } catch (error) {
        console.error("Webhook processing error:", error.message);
    }
});

// Start server
app.listen(PORT, () => {
    console.log("IchaBot Professional running on port " + PORT);
});
