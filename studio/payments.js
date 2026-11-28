const crypto = require("crypto");

const PAYMENTS_TABLE_ID = "icha_wallet_transactions";
const MIN_DEPOSIT_NGN = 5000;
const MAX_DEPOSIT_NGN = 1000000;
const CALLBACK_URL = "https://studio.tanphat.shop/payment/callback";
let walletTableReady = false;

function appwriteHeaders() {
  return {
    "X-Appwrite-Project": process.env.APPWRITE_PROJECT_ID,
    "X-Appwrite-Key": process.env.APPWRITE_API_KEY,
    "Content-Type": "application/json"
  };
}
async function aw(pathname, options = {}) {
  const response = await fetch(appwriteBase() + pathname, {
    ...options,
    headers: { ...appwriteHeaders(), ...(options.headers || {}) },
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || "Appwrite request failed");
    error.status = response.status;
    throw error;
  }
  return body;
}
async function ensurePaymentsTable() {
  const db = encodeURIComponent(process.env.APPWRITE_DATABASE_ID || "");
  if (!db || !process.env.APPWRITE_API_KEY) return false;
  try {
    await aw("/tablesdb/" + db + "/tables/" + PAYMENTS_TABLE_ID);
    walletTableReady = true;
    return true;
  } catch (error) {
    if (error.status !== 404) {
      console.error("Wallet table check failed: HTTP " + (error.status || "network"));
      return false;
    }
  }
  try {
    await aw("/tablesdb/" + db + "/tables", {
      method: "POST",
      body: JSON.stringify({
        tableId: PAYMENTS_TABLE_ID,
        name: "ICHA Wallet Transactions",
        permissions: [],
        rowSecurity: true,
        enabled: true,
        columns: [
          { key: "user_id", type: "string", size: 36, required: true },
          { key: "amount_kobo", type: "integer", required: true },
          { key: "currency", type: "string", size: 3, required: true },
          { key: "status", type: "string", size: 16, required: true },
          { key: "channel", type: "string", size: 32, required: false },
          { key: "created_at", type: "datetime", required: true },
          { key: "paid_at", type: "datetime", required: false }
        ],
        indexes: [
          { key: "user_id_idx", type: "key", attributes: ["user_id"] }
        ]
      })
    });
    console.log("ICHA wallet transactions table created.");
    walletTableReady = true;
    return true;
  } catch (error) {
    console.error("Wallet table creation failed: HTTP " + (error.status || "network"));
    return false;
  }
}
function paystackConfigured() {
  return Boolean(process.env.PAYSTACK_SECRET_KEY && process.env.PAYSTACK_SECRET_KEY.startsWith("sk_test_"));
}
async function paystackRequest(pathname, body) {
  const response = await fetch("https://api.paystack.co" + pathname, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + process.env.PAYSTACK_SECRET_KEY,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.status === false) {
    throw new Error("Paystack request failed with HTTP " + response.status);
  }
  return result.data || {};
}
async function getWalletProfile(userId) {
  const db = encodeURIComponent(process.env.APPWRITE_DATABASE_ID);
  return aw("/tablesdb/" + db + "/tables/icha_customer_profiles/rows/" + encodeURIComponent(userId));
}
async function getPayment(reference) {
  const db = encodeURIComponent(process.env.APPWRITE_DATABASE_ID);
  return aw("/tablesdb/" + db + "/tables/" + PAYMENTS_TABLE_ID + "/rows/" + encodeURIComponent(reference));
}
async function setPaymentFailed(reference) {
  try {
    const db = encodeURIComponent(process.env.APPWRITE_DATABASE_ID);
    await aw("/tablesdb/" + db + "/tables/" + PAYMENTS_TABLE_ID + "/rows/" + encodeURIComponent(reference), {
      method: "PATCH", body: JSON.stringify({ data: { status: "failed" } })
    });
  } catch (_) {}
}
async function verifyPaystack(reference) {
  return paystackRequest("/transaction/verify/" + encodeURIComponent(reference));
}
async function creditVerifiedPayment(reference, expectedUserId) {
  const payment = await getPayment(reference);
  if (payment.status === "paid") return { credited: true, alreadyCredited: true };
  if (payment.status !== "pending") throw new Error("This payment is not pending.");
  if (expectedUserId && payment.user_id !== expectedUserId) throw new Error("Payment does not belong to this account.");

  const verified = await verifyPaystack(reference);
  const expectedKobo = Number(payment.amount_kobo);
  if (verified.status !== "success" ||
      Number(verified.amount) !== expectedKobo ||
      String(verified.currency).toUpperCase() !== "NGN" ||
      String(verified.reference) !== reference ||
      (verified.metadata && verified.metadata.user_id && verified.metadata.user_id !== payment.user_id)) {
    throw new Error("Paystack verification did not match the pending payment.");
  }

  const db = encodeURIComponent(process.env.APPWRITE_DATABASE_ID);
  const tx = await aw("/tablesdb/transactions", {
    method: "POST",
    body: JSON.stringify({ ttl: 60 })
  });
  try {
    await aw("/tablesdb/transactions/" + encodeURIComponent(tx.$id) + "/operations", {
      method: "POST",
      body: JSON.stringify({
        operations: [
          {
            action: "increment",
            databaseId: process.env.APPWRITE_DATABASE_ID,
            tableId: "icha_customer_profiles",
            rowId: payment.user_id,
            data: { column: "credits", value: expectedKobo / 100, min: 0 }
          },
          {
            action: "update",
            databaseId: process.env.APPWRITE_DATABASE_ID,
            tableId: PAYMENTS_TABLE_ID,
            rowId: reference,
            data: {
              status: "paid",
              channel: String(verified.channel || "unknown").slice(0, 32),
              paid_at: new Date().toISOString()
            }
          }
        ]
      })
    });
    await aw("/tablesdb/transactions/" + encodeURIComponent(tx.$id), {
      method: "PATCH", body: JSON.stringify({ commit: true })
    });
    return { credited: true, alreadyCredited: false };
  } catch (error) {
    try {
      await aw("/tablesdb/transactions/" + encodeURIComponent(tx.$id), {
        method: "PATCH", body: JSON.stringify({ rollback: true })
      });
    } catch (_) {}
    const latest = await getPayment(reference).catch(() => null);
    if (latest && latest.status === "paid") return { credited: true, alreadyCredited: true };
    throw error;
  }
}

function registerPaymentRoutes(app, requireAccount, appwriteBase) {
  app.get("/api/payments/status", (_req, res) => {
    res.json({
      configured: paystackConfigured(),
      minimumDepositNgn: MIN_DEPOSIT_NGN,
      maximumDepositNgn: MAX_DEPOSIT_NGN,
      currency: "NGN",
      paymentsEnabled: walletTableReady && paystackConfigured(),
      walletTableReady,
      mode: "test",
      note: "Paystack test mode only. Complete a small test checkout before switching to live credentials."
    });
  });

  app.get("/api/wallet", async (req, res) => {
    const current = await requireAccount(req).catch(() => null);
    if (!current) return res.status(401).json({ error: "Please sign in." });
    try {
      const profile = await getWalletProfile(current.account.$id);
      return res.json({ balanceNgn: Number(profile.credits || 0) });
    } catch (_) {
      return res.status(503).json({ error: "Wallet is not ready yet." });
    }
  });

  app.post("/api/payments/initialize", async (req, res) => {
    const current = await requireAccount(req).catch(() => null);
    if (!current) return res.status(401).json({ error: "Please sign in before funding your wallet." });
    if (!walletTableReady) return res.status(503).json({ error: "Wallet database is not ready yet." });
    if (!paystackConfigured()) return res.status(503).json({ error: "Paystack test secret key is not configured." });
    const amount = Number(req.body && req.body.amountNgn);
    if (!Number.isSafeInteger(amount) || amount < MIN_DEPOSIT_NGN || amount > MAX_DEPOSIT_NGN) {
      return res.status(400).json({ error: "Deposit must be between ₦5,000 and ₦1,000,000." });
    }
    const reference = "ICHA_" + Date.now().toString(36) + "_" + crypto.randomBytes(8).toString("hex");
    const db = encodeURIComponent(process.env.APPWRITE_DATABASE_ID);
    try {
      await aw("/tablesdb/" + db + "/tables/" + PAYMENTS_TABLE_ID + "/rows", {
        method: "POST",
        body: JSON.stringify({
          rowId: reference,
          data: {
            user_id: current.account.$id,
            amount_kobo: amount * 100,
            currency: "NGN",
            status: "pending",
            created_at: new Date().toISOString()
          },
          permissions: []
        })
      });
      const initialized = await paystackRequest("/transaction/initialize", {
        email: current.account.email,
        amount: amount * 100,
        currency: "NGN",
        reference,
        callback_url: CALLBACK_URL,
        metadata: { user_id: current.account.$id, product: "ICHA AI Studio wallet funding" }
      });
      if (!initialized.authorization_url) throw new Error("Paystack did not return a checkout URL.");
      return res.json({ authorizationUrl: initialized.authorization_url, reference });
    } catch (error) {
      await setPaymentFailed(reference);
      console.error("Paystack initialization failed: " + String(error.message || "unknown").slice(0, 160));
      return res.status(502).json({ error: "Could not start checkout. Please try again." });
    }
  });

  app.get("/api/payments/verify", async (req, res) => {
    const current = await requireAccount(req).catch(() => null);
    if (!current) return res.status(401).json({ error: "Sign in again to confirm your wallet deposit." });
    const reference = String(req.query.reference || "").slice(0, 100);
    if (!/^ICHA_[a-z0-9]+_[a-f0-9]{16}$/i.test(reference)) return res.status(400).json({ error: "Invalid payment reference." });
    try {
      const result = await creditVerifiedPayment(reference, current.account.$id);
      return res.json({ ok: true, ...result, message: result.alreadyCredited ? "This deposit was already added." : "Wallet funded successfully." });
    } catch (error) {
      return res.status(400).json({ error: "Payment is not yet confirmed. If you were charged, contact support with your payment reference." });
    }
  });

  app.post("/api/paystack/webhook", async (req, res) => {
    const signature = req.headers["x-paystack-signature"];
    const raw = req.rawBody;
    if (!signature || !raw || !process.env.PAYSTACK_SECRET_KEY) return res.sendStatus(401);
    const expected = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY).update(raw).digest("hex");
    const a = Buffer.from(String(signature));
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(401);
    const event = req.body || {};
    if (event.event !== "charge.success" || !event.data || !event.data.reference) return res.sendStatus(200);
    const reference = String(event.data.reference);
    if (!/^ICHA_[a-z0-9]+_[a-f0-9]{16}$/i.test(reference)) return res.sendStatus(200);
    try {
      await creditVerifiedPayment(reference);
      return res.sendStatus(200);
    } catch (error) {
      console.error("Paystack webhook processing deferred: " + String(error.message || "unknown").slice(0, 160));
      return res.sendStatus(500);
    }
  });

  return ensurePaymentsTable;
}

module.exports = { registerPaymentRoutes };
