import { config } from "../config";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface JsonSchema {
  name: string;
  strict?: boolean;
  schema: Record<string, unknown>;
}

interface ChatCompletionOptions {
  model?: string;
  temperature?: number;
  maxRetries?: number;
  timeoutMs?: number;
  jsonSchema?: JsonSchema;
}

interface ChatCompletionResponse {
  choices: { message: { content: string } }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface EmbeddingResponse {
  data: { embedding: number[] }[];
  usage?: { prompt_tokens: number; total_tokens: number };
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — ministral can be slow

export async function chatCompletion(
  messages: ChatMessage[],
  options: ChatCompletionOptions = {},
): Promise<{ parsed: unknown; usage?: ChatCompletionResponse["usage"] }> {
  const {
    model = config.lmstudio.chatModel,
    temperature = 0.1,
    maxRetries = 1,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    jsonSchema,
  } = options;

  let lastError: Error | null = null;
  const allMessages = [...messages];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${config.lmstudio.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: allMessages,
          temperature,
          response_format: jsonSchema
            ? { type: "json_schema", json_schema: jsonSchema }
            : { type: "text" },
        }),
      });

      if (!res.ok) {
        throw new Error(`LM Studio chat error: ${res.status} ${await res.text()}`);
      }

      const data: ChatCompletionResponse = await res.json();
      const content = data.choices[0]?.message?.content;
      if (!content) throw new Error("LM Studio returned empty response");

      const cleaned = stripMarkdownFences(content);
      const parsed = JSON.parse(cleaned);
      return { parsed, usage: data.usage };
    } catch (err) {
      lastError = err as Error;

      if (lastError.name === "AbortError") {
        throw new Error(`LM Studio chat timed out after ${timeoutMs}ms`);
      }

      // On JSON parse failure, retry with a corrective message
      if (err instanceof SyntaxError && attempt < maxRetries) {
        console.error(`[lmstudio] JSON parse failed (attempt ${attempt + 1}), retrying...`);
        allMessages.push(
          { role: "assistant", content: "(invalid JSON)" },
          { role: "user", content: "Your response was not valid JSON. Please try again, returning only valid JSON." },
        );
        continue;
      }

      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

export async function generateEmbedding(
  text: string,
  options: { model?: string; timeoutMs?: number } = {},
): Promise<{ embedding: number[]; usage?: EmbeddingResponse["usage"] }> {
  const {
    model = config.lmstudio.embedModel,
    timeoutMs = 60_000,
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${config.lmstudio.baseUrl}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ model, input: text }),
    });

    if (!res.ok) {
      throw new Error(`LM Studio embedding error: ${res.status} ${await res.text()}`);
    }

    const data: EmbeddingResponse = await res.json();
    const embedding = data.data[0]?.embedding;
    if (!embedding) throw new Error("LM Studio returned empty embedding");

    return { embedding, usage: data.usage };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`LM Studio embedding timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Strip markdown code fences that small models often wrap around JSON */
function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  // Match ```json ... ``` or ``` ... ```
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  return match ? match[1].trim() : trimmed;
}

/** Ensure the chat model is loaded, loading it if needed */
export async function ensureModelLoaded(): Promise<void> {
  try {
    const res = await fetch(`${config.lmstudio.baseUrl}/models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;

    const data = await res.json() as { data?: { id: string }[] };
    const loaded = data.data?.some((m) => m.id === config.lmstudio.chatModel);
    if (loaded) return;

    console.log(`[lmstudio] Model not loaded, loading ${config.lmstudio.chatModel}...`);
    const loadRes = await fetch(`${config.lmstudio.baseUrl}/models/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.lmstudio.chatModel }),
      signal: AbortSignal.timeout(120_000), // loading can take a while
    });

    if (!loadRes.ok) {
      console.error(`[lmstudio] Failed to load model: ${loadRes.status} ${await loadRes.text()}`);
    } else {
      console.log(`[lmstudio] Model loaded`);
    }
  } catch (err) {
    console.error(`[lmstudio] ensureModelLoaded error:`, err);
  }
}

/** Quick health check — can we reach LM Studio? */
export async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${config.lmstudio.baseUrl}/models`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
