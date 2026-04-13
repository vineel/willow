import { EXTRACTION_SYSTEM_PROMPT, buildUserPrompt } from "./prompts";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

interface AnthropicResponse {
  content: { type: string; text: string }[];
  usage?: { input_tokens: number; output_tokens: number };
}

export async function extractWithHaiku(
  rawText: string,
  filePath?: string,
): Promise<{ parsed: unknown; usage?: { input_tokens: number; output_tokens: number } }> {
  const apiKey = process.env.ANTHRO_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHRO_API_KEY not set — cannot use Haiku fallback");
  }

  const userMessage = buildUserPrompt(rawText, filePath);

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 8192,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }] as AnthropicMessage[],
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Haiku API error: ${res.status} ${body}`);
  }

  const data: AnthropicResponse = await res.json();
  const text = data.content.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("Haiku returned empty response");

  // Strip markdown fences if present
  const cleaned = text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/, "$1").trim();
  const parsed = JSON.parse(cleaned);

  console.log(`[haiku] Extraction complete (${data.usage?.input_tokens ?? "?"}in/${data.usage?.output_tokens ?? "?"}out tokens)`);

  return { parsed, usage: data.usage };
}
