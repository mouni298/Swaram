# Telephony (Phone Calls)

Run the agent over a real phone call using **Twilio ConversationRelay**. Twilio
handles the call audio — speech-to-text, text-to-speech, and barge-in — and
exchanges plain text with your server over a WebSocket. Your server runs the
**`TextVoiceAgent`** (LLM + tools + transcript) and the SDK's dependency-free
telephony helpers.

> New here? Read the [SDK Guide](./README.md) first for concepts (tools, events,
> errors).

---

## How it fits together

```
caller ⇄ Twilio ── STT / TTS / barge-in ──⇄ WebSocket ⇄ your server
                                                         └─ TextVoiceAgent (LLM + tools)
```

- Twilio dials/answers the call and converts speech ⇄ text.
- On connect, Twilio fetches **TwiML** from your voice webhook that starts a
  ConversationRelay session pointed at your WebSocket.
- Over the socket, Twilio sends the caller's transcribed speech; you send back
  text tokens for Twilio to speak.

Because Twilio owns the audio, you use `TextVoiceAgent` (text-in/text-out), **not**
`StreamingVoiceSupportAgent`.

---

## What the SDK gives you

All in `swaram-ai`, all pure functions / classes (no `ws`/`twilio` import inside
the SDK — you bring those):

| Export | Purpose |
|--------|---------|
| `buildConversationRelayTwiML(options)` | Render the `<Connect><ConversationRelay/>` TwiML that starts a session. |
| `parseRelayMessage(raw)` | Parse an inbound WebSocket frame into a typed message. |
| `textMessage(token, last?, lang?)` | Build a `text` frame for Twilio to speak. |
| `endSession(handoffData?)` | Build an `end` frame to hang up. |
| `switchLanguage(transcription, tts?)` | Build a `language` frame to switch mid-call. |
| `TextVoiceAgent` | The headless turn engine that produces the replies. |

---

## TextVoiceAgent

```ts
import { TextVoiceAgent, GroqStreamingLLMProvider, ecommerceSupportTemplate } from "swaram-ai";

const agent = new TextVoiceAgent({
  instructions: ecommerceSupportTemplate.instructions,
  tools: ecommerceSupportTemplate.tools,
  llm: new GroqStreamingLLMProvider({ apiKey: process.env.GROQ_API_KEY, model: "llama-3.1-8b-instant" }),
});

agent.on("token", ({ text }) => {/* stream to Twilio TTS */});
agent.on("turnEnd", ({ text }) => {/* full reply for this turn */});
agent.on("toolCall", ({ toolCall }) => {/* a tool ran */});
agent.on("error", ({ error }) => {/* a SwaramError */});

const reply = await agent.handlePrompt("Where is my order 12345?");
```

| Member | Description |
|--------|-------------|
| `handlePrompt(text)` | Run one user turn; streams `token`s, runs tools, returns the full reply. |
| `interrupt()` | Abort the in-flight reply (caller barged in). |
| `isResponding()` | Whether a turn is in flight. |
| `getTranscript()` / `getToolCalls()` | Conversation state. |
| `on(event, handler)` | Subscribe (`token`, `transcript`, `toolCall`, `turnEnd`, `error`). |

Config: `{ instructions?, template?, llm, tools? }`. The same tool loop as the
browser agent applies — tool results are fed back and the model re-prompted so the
spoken answer is grounded.

---

## 1. Serve the TwiML (voice webhook)

When the call connects, Twilio requests your voice URL. Return TwiML that connects
to your WebSocket. Pass per-call data through `parameters` — it arrives back in the
`setup` message.

```ts
import { buildConversationRelayTwiML } from "swaram-ai";

const twiml = buildConversationRelayTwiML({
  wsUrl: "wss://your-host/relay",          // must be wss://
  welcomeGreeting: "Hi, this is support. How can I help?",
  voice: "…",                              // optional TTS voice id
  transcriptionProvider: "Deepgram",       // default
  ttsProvider: "ElevenLabs",               // default
  language: "en-US",
  interruptible: "speech",                 // none | dtmf | speech | any
  parameters: { cfgId: "abc123" },         // echoed in setup.customParameters
});
// respond with Content-Type: text/xml
```

---

## 2. Bridge the WebSocket to the agent

Use any WebSocket server (`ws` shown). Parse each frame, build a `TextVoiceAgent`
on `setup`, and stream replies back. The wire format for a spoken reply is a flat
`{ type: "text", token, last }`: send `last: false` tokens as the LLM streams, then
a final `last: true` (empty token is fine) to close the turn.

```ts
import { WebSocketServer } from "ws";
import {
  TextVoiceAgent,
  GroqStreamingLLMProvider,
  ecommerceSupportTemplate,
  parseRelayMessage,
  textMessage,
  endSession,
} from "swaram-ai";

const wss = new WebSocketServer({ server, path: "/relay" });

wss.on("connection", (ws) => {
  let agent = null;

  ws.on("message", async (raw) => {
    const msg = parseRelayMessage(raw);   // setup | prompt | dtmf | interrupt | error | unknown

    if (msg.type === "setup") {
      const cfgId = msg.customParameters.cfgId;   // from the TwiML `parameters`
      agent = new TextVoiceAgent({
        instructions: ecommerceSupportTemplate.instructions,
        tools: ecommerceSupportTemplate.tools,
        llm: new GroqStreamingLLMProvider({ apiKey: process.env.GROQ_API_KEY }),
      });
      // Stream each human-facing token to Twilio to speak.
      agent.on("token", ({ text }) => ws.send(JSON.stringify(textMessage(text, false))));
      return;
    }

    if (!agent) return;

    // A finalized caller utterance — run a turn, then close it with last:true.
    if (msg.type === "prompt" && msg.last && msg.text.trim()) {
      try {
        await agent.handlePrompt(msg.text);
        ws.send(JSON.stringify(textMessage("", true)));   // end of agent turn
      } catch (error) {
        ws.send(JSON.stringify(textMessage("Sorry, I'm having trouble. Goodbye.", true)));
        ws.send(JSON.stringify(endSession({ reason: "agent-error" })));
      }
      return;
    }

    // Caller barged in — abort the in-flight reply.
    if (msg.type === "interrupt") {
      agent.interrupt();
    }
  });

  ws.on("close", () => agent?.interrupt());
});
```

### Inbound message types (`parseRelayMessage`)

| `type` | Fields | Meaning |
|--------|--------|---------|
| `setup` | `sessionId`, `callSid`, `customParameters` | Session start; `customParameters` carries your TwiML `parameters`. |
| `prompt` | `text`, `last`, `lang?` | Transcribed caller speech; act on `last: true`. |
| `dtmf` | `digit` | A keypad press. |
| `interrupt` | `utteranceUntilInterrupt?` | The caller barged in over the agent. |
| `error` | `errorCode?`, `errorMessage?` | A Twilio-side error (also returned for malformed frames). |
| `unknown` | `raw` | Any frame the SDK doesn't model. |

`parseRelayMessage` never throws — malformed JSON comes back as an `error` message.

### Outbound frames

- `textMessage(token, last?, lang?)` → `{ type: "text", token, last, lang? }`
- `endSession(handoffData?)` → `{ type: "end", handoffData? }` (hang up)
- `switchLanguage(transcriptionLanguage, ttsLanguage?)` → `{ type: "language", … }`

Send them with `ws.send(JSON.stringify(frame))`.

---

## 3. Place / receive the call

- **Inbound**: point your Twilio number's Voice webhook at your `/voice` URL.
- **Outbound**: create a call with the Twilio SDK, pointing `url` at your `/voice`:

```ts
import twilio from "twilio";
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

await client.calls.create({
  to: "+14155551234",
  from: process.env.TWILIO_NUMBER,
  url: `${publicUrl}/voice?cfgId=${cfgId}`,
  statusCallback: `${publicUrl}/status?cfgId=${cfgId}`,
  statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
});
```

Twilio must be able to reach your server over HTTPS/WSS. In development, expose it
with a tunnel (e.g. `ngrok http 5005`) and use the public URL as `PUBLIC_URL`.

---

## Production notes

- **Validate Twilio signatures** on the voice/status webhooks
  (`twilio.validateRequest`) so only Twilio can trigger calls.
- **Cap call duration** with a timer that sends `endSession` — runaway calls cost
  money.
- **Authorize outbound calls** (a shared secret on your `/call` endpoint) and
  validate the `to` number is E.164.
- **One agent per call**: key sessions by `callSid` and clean up on `close`/`error`
  and on the `completed` status callback.
- **Tool latency matters** on a phone call — keep tool `run` handlers fast; the
  caller hears silence while a tool runs.

---

## Full working example

`examples/phone-agent/server.mjs` is a complete outbound-calling server:
`POST /call` (trigger), `GET /voice` (TwiML), `WS /relay` (bridge), `POST /status`
(lifecycle), and `GET /events` (SSE to a browser panel). It includes signature
validation, a max-duration guard, a call secret, and ngrok auto-detection. See
`examples/phone-agent/README.md` for setup and `.env` configuration.
