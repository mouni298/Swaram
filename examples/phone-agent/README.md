# Phone agent — outbound calls via Twilio ConversationRelay

Place an outbound phone call where the same Swaram agent (your Groq LLM + tools +
persona) talks to a real person. Twilio's **ConversationRelay** does the speech-to-text,
text-to-speech, and barge-in; this server runs only the LLM turn loop via the SDK's
`TextVoiceAgent` and exchanges **text** over a WebSocket.

> ⚠️ ConversationRelay uses Twilio's cloud STT/TTS (not the local whisper/Kokoro
> stack) and bills per minute. A Twilio **trial** account can only call numbers
> you've **verified** in the console, and must call *from* your Twilio number.
> Only call people who have consented to be called.

## How it works

```
curl / your app ──POST /call {to, greeting, instructions, model, voice}──▶ server
                  ◀──────────────── SSE /events (status + transcript) ───────┘
                                         │ twilio.calls.create({to, from, url})
                                         ▼
callee ☎ ◀─ PSTN ─ Twilio ─GET /voice ─▶ TwiML <Connect><ConversationRelay wss://…/relay>
                      │  Twilio does STT + TTS + barge-in
                      └─ WS /relay:  setup / prompt / interrupt  ⇄  text / end
                                         │
                              SDK TextVoiceAgent (Groq LLM + tools + transcript)
```

## Setup

1. **Install deps** (from the repo root): already covered by `npm install` (`ws`, `twilio`, `dotenv`).
2. **Build the SDK** so `dist/` is current: `npm run build`.
3. **Configure**: `cp examples/phone-agent/.env.example examples/phone-agent/.env` and fill in
   your Twilio SID/token/number and `GROQ_API_KEY`.
4. **Start the local LLM** — only Groq is needed here (Twilio handles STT/TTS), so no whisper/Kokoro required.

## Run it (local demo over ngrok)

```bash
# 1. Start the phone-agent server (port 5005)
node examples/phone-agent/server.mjs
#    or via ./start-services.sh (auto-starts it when this .env exists)

# 2. Expose it publicly so Twilio can reach it
ngrok http 5005
#    Either set PUBLIC_URL in .env to the https URL ngrok prints,
#    or leave it blank — the server auto-detects the running tunnel.

# 3. Place a call (verified number on a trial account)
curl -X POST http://127.0.0.1:5005/call \
  -H 'Content-Type: application/json' \
  -d '{"to":"+14155551234","greeting":"Hi! This is your assistant calling.","secret":""}'

# 4. Watch the live status + transcript (SSE) using the cfgId from the response
curl -N "http://127.0.0.1:5005/events?cfgId=<cfgId-from-step-3>"
```

The agent's **persona/instructions** and **LLM model** are passed in the `/call`
body, so it reuses the same Groq LLM, tools, and template as the browser agent.

## Test the bridge without a phone

No Twilio/ngrok needed — verify the Groq↔relay loop directly:

```bash
ALLOW_SIM=1 GROQ_API_KEY=gsk_... node examples/phone-agent/server.mjs   # terminal 1
node examples/phone-agent/simulate-relay.mjs "where is my order 12345?"  # terminal 2
```

It connects to `/relay`, sends `setup` + a `prompt`, and prints the streamed reply tokens.

## Endpoints

| Method | Path        | Purpose                                                        |
| ------ | ----------- | -------------------------------------------------------------- |
| POST   | `/call`     | Trigger an outbound call (curl/your app). Body: `{to, greeting, instructions?, model?, voice?, secret?}` |
| GET    | `/voice`    | Twilio webhook → returns ConversationRelay TwiML (`?cfgId=`)   |
| WS     | `/relay`    | ConversationRelay media/text WebSocket                         |
| POST   | `/status`   | Twilio call status callbacks                                   |
| GET    | `/events`   | SSE stream of status + transcript for a client (`?cfgId=`)     |
| GET    | `/health`   | `{ ok, configured }`                                           |

## Notes & limits

- **Auth**: set `CALL_SECRET` so a public ngrok URL can't be used to dial out; the caller must send the same secret. Optionally set `VALIDATE_TWILIO_SIGNATURE=1` (needs a stable `PUBLIC_URL`).
- **Cost guard**: `MAX_CALL_SECONDS` auto-ends a call.
- **Concurrent calls** are supported (one session per call SID).
- **Tools** run mid-turn; like the browser agent, a tool result informs the *next* turn (single-stream behavior).
- **Voices**: `CR_VOICE` (or the `voice` field in `/call`) selects a ConversationRelay (ElevenLabs/Google) voice — not Kokoro.
