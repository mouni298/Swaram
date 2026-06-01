import { WebSocket } from "ws";

// No-phone test of the ConversationRelay bridge. Pretends to be Twilio: opens the
// /relay WebSocket, sends `setup` + a `prompt`, and prints the `text` tokens the
// server streams back. Verifies the Groq<->relay loop end-to-end with no call.
//
// Run the server with ALLOW_SIM=1 and a GROQ_API_KEY, then:
//   node examples/phone-agent/simulate-relay.mjs "where is my order 12345?"

const PORT = Number(process.env.PORT ?? 5005);
const prompt = process.argv[2] ?? "Hi, I want to check on my order 12345.";
const instructions =
  process.env.SIM_INSTRUCTIONS ??
  "You are a concise, friendly support agent. Keep replies to one or two sentences.";

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/relay`);

ws.on("open", () => {
  console.log(`▶ connected; sending setup + prompt: "${prompt}"\n`);
  ws.send(
    JSON.stringify({
      type: "setup",
      sessionId: "VXsim",
      callSid: "CAsim",
      customParameters: { cfgId: "sim", simInstructions: instructions, simModel: process.env.GROQ_MODEL ?? "" },
    }),
  );
  ws.send(JSON.stringify({ type: "prompt", payload: { text: prompt, last: true, lang: "en-US" } }));
});

let reply = "";
ws.on("message", (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (msg.type === "text") {
    for (const t of msg.tokens ?? []) {
      if (t.token) {
        process.stdout.write(t.token);
        reply += t.token;
      }
      if (t.last) {
        console.log(`\n\n✓ turn complete (${reply.length} chars). Closing.`);
        ws.close();
      }
    }
  } else if (msg.type === "end") {
    console.log(`\n■ session ended: ${msg.handoffData ?? ""}`);
    ws.close();
  }
});

ws.on("error", (err) => {
  console.error("WebSocket error:", err.message);
  process.exit(1);
});
ws.on("close", () => process.exit(0));

setTimeout(() => {
  console.error("\nTimed out waiting for a reply (is GROQ_API_KEY set and the server running with ALLOW_SIM=1?).");
  process.exit(1);
}, 30000);
