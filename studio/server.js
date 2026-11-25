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
    note: "Generation remains locked until provider keys, user authentication, and usage limits are configured."
  });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("ICHA AI Studio listening on port " + PORT);
});
