# ICHA AI Studio

A separate Node.js web application hosted from the `studio/` folder of the ICHA BOT repository. It does not change the existing bot application.

## Render setup
- Runtime: Node
- Build command: `npm install --prefix studio`
- Start command: `npm start --prefix studio`
- Branch: `icha-ai-studio`

## Environment variables (add later in Render)
- `REPLICATE_API_TOKEN` — video generation provider token
- `ELEVENLABS_API_KEY` — voice generation / cloning provider token

The first deployment is a safe public preview. Generation is intentionally disabled until authentication, consent checks, usage limits, and provider integrations are implemented.
