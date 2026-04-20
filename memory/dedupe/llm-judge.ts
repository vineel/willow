// Haiku 4.5 judge for dedupe review-zone pairs.
// Prompt-cached system prompt so ~1000 pair calls cost ~$0.10 (see
// notes/person-dedupe-strategy.md §4).

import { getSecret } from "../../pib/config";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You are a deduplication judge for Vineel's personal memory system.

You will be shown two factoids. A factoid is a top-level entity record —
a person, place, organization, event, concept, product, account, or
something whose type is unknown. Your job is to decide whether the two
factoids refer to the same real-world entity.

Guidance:
- Same entity means: these two rows should become one row in the memory
  graph. Different titles, different spellings, different extraction
  sources are all fine — what matters is whether they point to the same
  thing in the world.
- If the two factoids have the same name but you cannot tell whether they
  are the same specific entity (e.g. two different Michael Spencers writing
  for different newsletters, two different restaurants both called "The
  Dover"), return same=null.
- Strong signals for same=true: shared context, overlapping biographical
  details, shared email address or display name, one factoid clearly
  referring to the other.
- Strong signals for same=false: contradictory details, clearly distinct
  roles / affiliations / locations, different types of entity.
- A typo in a name is still the same person if other content agrees.
- Respond with valid JSON only. No prose before or after.`;

export interface JudgeInput {
  titleA: string;
  typeA: string | null;
  contentA: string;
  keywordsA: string[];
  titleB: string;
  typeB: string | null;
  contentB: string;
  keywordsB: string[];
}

export interface JudgeVerdict {
  same: boolean | null;
  confidence: number;
  reason: string;
}

export async function judgePair(input: JudgeInput): Promise<JudgeVerdict> {
  const apiKey = await getSecret("ANTHRO_API_KEY");

  const userMessage = `Factoid A:
  title: ${input.titleA}
  type: ${input.typeA ?? "(null)"}
  keywords: ${input.keywordsA.join(", ") || "(none)"}
  content: ${truncate(input.contentA, 600)}

Factoid B:
  title: ${input.titleB}
  type: ${input.typeB ?? "(null)"}
  keywords: ${input.keywordsB.join(", ") || "(none)"}
  content: ${truncate(input.contentB, 600)}

Respond with JSON only:
{"same": true|false|null, "confidence": 0-1, "reason": "<one sentence>"}`;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 256,
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: userMessage }],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Haiku judge error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as {
    content: { type: string; text: string }[];
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
    };
  };

  const text = data.content.find((c) => c.type === "text")?.text ?? "";
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/, "$1")
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as JudgeVerdict;
    return parsed;
  } catch {
    return {
      same: null,
      confidence: 0,
      reason: `parse failed: ${cleaned.slice(0, 100)}`,
    };
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}
