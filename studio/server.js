const express = require("express");
const helmet = require("helmet");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

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
// Never return API keys or provider account identifiers to the browser.
app.get("/api/provider-check", async (_req, res) => {
  const result = {
    replicate: { configured: Boolean(process.env.REPLICATE_API_TOKEN), connected: false },
    elevenlabs: { configured: Boolean(process.env.ELEVENLABS_API_KEY), connected: false }
  };

  const checks = [];
  if (result.replicate.configured) {
    checks.push(fetch("https://api.replicate.com/v1/account", {
      headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}` },
      signal: AbortSignal.timeout(10000)
    }).then(r => { result.replicate.connected = r.ok; }).catch(() => {}));
  }
  if (result.elevenlabs.configured) {
    checks.push(fetch("https://api.elevenlabs.io/v1/user", {
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
      signal: AbortSignal.timeout(10000)
    }).then(r => { result.elevenlabs.connected = r.ok; }).catch(() => {}));
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

app.listen(PORT, "0.0.0.0", () => {
  console.log("ICHA AI Studio listening on port " + PORT);
});
