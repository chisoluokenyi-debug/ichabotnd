const express = require("express");
const helmet = require("helmet");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
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
      console.error("Appwrite profile table creation failed with HTTP " + created.status + ".");
      return;
    }
    console.log("Appwrite customer profile table created.");
  } catch (error) {
    console.error("Appwrite profile table setup failed: " +
      (error && error.name === "TimeoutError" ? "timeout" : "network error"));
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", app: "ICHA AI Studio" });
});

app.get("/api/status", (_req, res) => {
  res.json({
    videoProviderConfigured: Boolean(process.env.REPLICATE_API_TOKEN),
    voiceProviderConfigured: Boolean(process.env.ELEVENLABS_API_KEY),
    generationEnabled: false,
    note: "Provider credentials are stored server-side. Generation will be enabled after customer sign-in, consent and usage limits are in place."
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

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

ensureCustomerProfileTable();

app.listen(PORT, "0.0.0.0", () => {
  console.log("ICHA AI Studio listening on port " + PORT);
});
