import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 8787);
const model = process.env.OPENAI_MODEL ?? "gpt-5.5";

function writeJsonLine(response: Parameters<Parameters<typeof createServer>[0]>[1], value: unknown) {
  response.write(`${JSON.stringify(value)}\n`);
}

const server = createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    });
    response.end();
    return;
  }

  if (request.method !== "POST" || request.url !== "/llm") {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    input: string;
    instructions: string;
  };

  response.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
  });

  if (!process.env.OPENAI_API_KEY) {
    const fallback = `I can help with that. For "${input.input}", I would check the relevant support tools and give the customer a concise next step.`;
    writeJsonLine(response, { type: "text_delta", text: fallback });
    writeJsonLine(response, { type: "done", text: fallback });
    response.end();
    return;
  }

  const openAIResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      stream: true,
      reasoning: { effort: "low" },
      text: { verbosity: "low" },
      input: [
        { role: "system", content: input.instructions },
        { role: "user", content: input.input },
      ],
    }),
  });

  if (!openAIResponse.body) {
    response.end();
    return;
  }

  const reader = openAIResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) {
        continue;
      }

      const payload = line.slice(6).trim();
      if (payload === "[DONE]") {
        continue;
      }

      const event = JSON.parse(payload) as { type?: string; delta?: string };
      if (event.type === "response.output_text.delta" && event.delta) {
        writeJsonLine(response, { type: "text_delta", text: event.delta });
      }
    }
  }

  writeJsonLine(response, { type: "done" });
  response.end();
});

server.listen(port, () => {
  console.log(`Swaram server bridge listening on http://localhost:${port}`);
});
