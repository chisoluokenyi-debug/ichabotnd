
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const VERIFY_TOKEN =
  process.env.META_WEBHOOK_VERIFY_TOKEN ||
  process.env.VERIFY_TOKEN;

const APP_SECRET =
  process.env.META_APP_SECRET ||
  process.env.APP_SECRET;

const PAGE_ACCESS_TOKEN =
  process.env.PAGE_ACCESS_TOKEN;

const GRAPH_VERSION =
  process.env.META_GRAPH_VERSION || "v26.0";

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    app: "IchaBot"
  });
});

// Verify Facebook webhook
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (
    mode === "subscribe" &&
    token === VERIFY_TOKEN &&
    VERIFY_TOKEN
  ) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// Preserve raw body for signature verification
app.use(express.json({
  verify: (req, res, buffer) => {
    req.rawBody = buffer;
  }
}));

function verifySignature(req) {
  if (!APP_SECRET) return false;

  const signature = req.headers["x-hub-signature-256"];

  if (!signature || !signature.startsWith("sha256=")) {
    return false;
  }

  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", APP_SECRET)
      .update(req.rawBody || Buffer.from(""))
      .digest("hex");

  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  return (
    receivedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

// Send Messenger reply
async function sendMessage(recipientId, message) {
  if (!PAGE_ACCESS_TOKEN) {
    throw new Error("PAGE_ACCESS_TOKEN is not configured");
  }

  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/me/messages`;

  await axios.post(
    url,
    {
      recipient: { id: recipientId },
      messaging_type: "RESPONSE",
      message: { text: message }
    },
    {
      params: {
        access_token: PAGE_ACCESS_TOKEN
      },
      timeout: 15000
    }
  );
}

// Receive Facebook webhook events
app.post("/webhook", async (req, res) => {
  if (!verifySignature(req)) {
    return res.sendStatus(401);
  }

  // Acknowledge Facebook immediately
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body.object !== "page") return;

    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        if (
          !event.message ||
          event.message.is_echo ||
          !event.sender ||
          !event.sender.id
        ) {
          continue;
        }

        const message = (event.message.text || "").trim();

        if (!message) continue;

        console.log("Incoming message:", message);

        const reply =
          "Welcome to IchaBot! Thank you for contacting us. How can we help you?";

        try {
          await sendMessage(event.sender.id, reply);
          console.log("Reply sent successfully");
        } catch (error) {
          console.error(
            "Messenger error:",
            error.response?.data || error.message
          );
        }
      }
    }
  } catch (error) {
    console.error("Webhook processing error:", error.message);
  }
});

app.listen(PORT, () => {
  console.log(`IchaBot running on port ${PORT}`);
});




        
