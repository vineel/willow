#!/usr/bin/env bun
/**
 * MCP server exposing web search (Brave Search API) and web fetch.
 * Used by claude -p during interest action execution for enrichment.
 *
 * Must use stderr for all logging — stdout is MCP stdio.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getSecret } from "../../pib/config";

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

let cachedApiKey: string | null = null;

async function getApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  cachedApiKey = await getSecret("brave-api-key");
  return cachedApiKey;
}

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

async function braveSearch(query: string, count: number = 5): Promise<BraveSearchResult[]> {
  const apiKey = await getApiKey();
  const params = new URLSearchParams({ q: query, count: String(count) });
  const response = await fetch(`${BRAVE_SEARCH_URL}?${params}`, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Brave Search failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as any;
  const results = (data.web?.results ?? []) as any[];

  return results.map((r: any) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    description: r.description ?? "",
  }));
}

async function webFetch(url: string, maxLength: number = 10000): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": "Willow/0.1 (personal assistant)" },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Fetch failed (${response.status}): ${url}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();

  if (contentType.includes("html")) {
    const stripped = text
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return stripped.slice(0, maxLength);
  }

  return text.slice(0, maxLength);
}

const server = new McpServer(
  { name: "willow-web", version: "0.1.0" },
  {
    instructions: [
      "Use web_search to find URLs, verify information, or enrich notifications with links.",
      "Use web_fetch to read a specific page for details not available in search snippets.",
      "Prefer search results from authoritative sources (official sites, known platforms).",
    ].join(" "),
  }
);

server.tool(
  "web_search",
  "Search the web using Brave Search. Returns titles, URLs, and descriptions. Use this to find URLs, verify information, or enrich notifications with links.",
  {
    query: z.string().describe("Search query"),
    count: z.number().optional().default(5).describe("Number of results to return (default: 5, max: 10)"),
  },
  async ({ query, count }) => {
    const results = await braveSearch(query, Math.min(count, 10));
    const formatted = results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`)
      .join("\n\n");

    return {
      content: [{
        type: "text",
        text: results.length > 0
          ? `Found ${results.length} results:\n\n${formatted}`
          : "No results found.",
      }],
    };
  }
);

server.tool(
  "web_fetch",
  "Fetch a web page and return its text content. Use this to read a specific page for details not available in search snippets.",
  {
    url: z.string().describe("URL to fetch"),
    max_length: z.number().optional().default(10000).describe("Max characters to return (default: 10000)"),
  },
  async ({ url, max_length }) => {
    const text = await webFetch(url, max_length);
    return {
      content: [{ type: "text", text }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
