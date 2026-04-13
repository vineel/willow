import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const MEMORY_BASE_URL = process.env.MEMORY_URL ?? "http://localhost:8789";

async function memoryFetch(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${MEMORY_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Memory API ${path} returned ${res.status}: ${text}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return JSON.parse(text);
  }
  return text;
}

const server = new McpServer({
  name: "willow-memory",
  version: "1.0.0",
}, {
  instructions: [
    "You have access to Willow's Second Brain — a personal knowledge graph.",
    "Use memory_search to look up facts before answering questions about people, events, or personal context.",
    "Use memory_add to store new facts you learn during conversation that the user would want remembered.",
    "When adding facts, be specific and atomic — one distinct piece of information per fact.",
    "Set is_factoid=true and factoid_type for root entities. Use Person ONLY for actual humans. Use Organization for companies/newsletters/venues-run-as-orgs, Place for physical locations, Account for logins/credentials grouped per service, Unknown when you can't tell yet (prefer this over guessing Person).",
    "Always search before adding to avoid duplicates.",
    "If memory_search doesn't return the right results, try memory_search_keywords to search by extracted keyword tags instead.",
  ].join(" "),
});

// --- memory_search tool ---

server.tool(
  "memory_search",
  "Search Willow's Second Brain for facts. Use semantic mode (default) for natural language queries, keyword mode for exact matches. Returns facts grouped by source with relevance scores.",
  {
    query: z.string().describe("Natural language search query"),
    mode: z.enum(["semantic", "keyword"]).default("semantic").describe("Search mode: semantic (vector similarity) or keyword (text match)"),
    limit: z.number().int().min(1).max(100).default(20).describe("Max number of facts to return"),
    start_date: z.string().optional().describe("Filter: only facts created after this date (YYYY-MM-DD or ISO)"),
    end_date: z.string().optional().describe("Filter: only facts created before this date (YYYY-MM-DD or ISO)"),
  },
  async ({ query, mode, limit, start_date, end_date }) => {
    const body: Record<string, unknown> = {
      query,
      mode,
      limit,
      output: "llm",
    };
    if (start_date) body.startts = start_date;
    if (end_date) body.endts = end_date;

    const result = await memoryFetch("/api/facts/search", body);

    // LLM output mode returns plain text
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);

    return {
      content: [{ type: "text" as const, text: text || "No facts found." }],
    };
  },
);

// --- memory_add tool ---

const FactSchema = z.object({
  title: z.string().describe("Short label for the fact"),
  content: z.string().describe("The fact itself — one atomic piece of information"),
  keywords: z.array(z.string()).optional().describe("Keywords for search (e.g. names, topics)"),
  qe_text: z.string().optional().describe("Alternate phrasings/synonyms to improve search recall"),
  confidence: z.number().min(0).max(1).optional().describe("How confident you are (0-1, default 0.8)"),
  is_factoid: z.boolean().optional().describe("True if this is a root entity (person, place, org, account, etc.)"),
  factoid_type: z.enum([
    "Person", "Place", "Organization", "Event", "Concept", "Product",
    "Account", "Unknown",
  ]).optional()
    .describe("Entity type. Person=human only. Account=login/credentials for a service. Unknown=unresolved sender, to be promoted later. Only set when is_factoid is true."),
  expires_type: z.enum(["never", "weighted", "date"]).optional().describe("Expiry strategy (default: never)"),
  action: z.enum(["remember", "verify_world", "verify_human"]).optional()
    .describe("Pipeline action: remember (store), verify_world (fact-check), verify_human (ask user)"),
});

server.tool(
  "memory_add",
  "Add one or more facts to Willow's Second Brain. Each fact should be atomic — one distinct piece of information. Search first to avoid duplicates. Set is_factoid=true for root entities like people or organizations.",
  {
    facts: z.array(FactSchema).min(1).describe("Array of facts to add"),
    source_type: z.string().default("conversation").describe("Where these facts came from (conversation, agent, cli)"),
    source_title: z.string().optional().describe("Description of the source context"),
  },
  async ({ facts, source_type, source_title }) => {
    const body = {
      facts,
      source: {
        type: source_type,
        title: source_title ?? "Added via Claude Code MCP",
      },
    };

    const result = await memoryFetch("/api/facts/add", body) as {
      ok: boolean;
      fact_ids: string[];
      count: number;
      source_note_id: string;
    };

    return {
      content: [{
        type: "text" as const,
        text: `Added ${result.count} fact(s). IDs: ${result.fact_ids.join(", ")}`,
      }],
    };
  },
);

// --- memory_search_keywords tool ---

server.tool(
  "memory_search_keywords",
  "Search facts by their extracted keyword tags. Use this as a fallback when memory_search (semantic) doesn't return the right results. Matches against the keywords array that was assigned to each fact during extraction.",
  {
    keywords: z.array(z.string()).min(1).describe("Keywords to search for (e.g. [\"vineel\", \"birthday\"])"),
    match: z.enum(["any", "all"]).default("any").describe("Match mode: 'any' = fact has at least one keyword, 'all' = fact has every keyword"),
    limit: z.number().int().min(1).max(100).default(20).describe("Max number of facts to return"),
    start_date: z.string().optional().describe("Filter: only facts created after this date (YYYY-MM-DD or ISO)"),
    end_date: z.string().optional().describe("Filter: only facts created before this date (YYYY-MM-DD or ISO)"),
  },
  async ({ keywords, match, limit, start_date, end_date }) => {
    const body: Record<string, unknown> = { keywords, match, limit };
    if (start_date) body.startts = start_date;
    if (end_date) body.endts = end_date;

    const result = await memoryFetch("/api/facts/search-keywords", body);
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);

    return {
      content: [{ type: "text" as const, text: text || "No facts found matching those keywords." }],
    };
  },
);

// --- Start server ---

const transport = new StdioServerTransport();
await server.connect(transport);
