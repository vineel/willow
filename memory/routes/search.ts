import { Hono } from "hono";
import { sql } from "../db";
import { generateEmbedding } from "../lmstudio/client";

const search = new Hono();

search.post("/api/facts/search", async (c) => {
  const body = await c.req.json<{
    query: string;
    startts?: string;
    endts?: string;
    limit?: number;
    output?: "json" | "llm";
    mode?: "semantic" | "keyword";
  }>();

  if (!body.query || typeof body.query !== "string") {
    return c.json({ error: "query is required" }, 400);
  }

  const query = body.query.trim();
  const startTs = parseTimestamp(body.startts);
  const endTs = parseTimestamp(body.endts);
  const limit = body.limit ?? 20;
  const output = body.output ?? "json";
  const mode = body.mode ?? "semantic";

  let facts;

  if (mode === "semantic") {
    const { embedding } = await generateEmbedding(query);
    const vecLiteral = `[${embedding.join(",")}]`;

    facts = await sql`
      SELECT
        f.fact_id,
        f.source_note_id,
        f.title,
        f.content,
        f.keywords,
        f.is_factoid,
        f.factoid_type,
        f.confidence,
        f.memory_type,
        f.expires_type,
        f.created_at,
        sn.filename,
        sn.title AS source_title,
        sn.summary AS source_summary,
        (f.embedding <=> ${vecLiteral}::vector) AS distance
      FROM app.fact f
      LEFT JOIN app.source_note sn ON f.source_note_id = sn.source_note_id
      WHERE f.is_active = true
        ${startTs ? sql`AND f.created_at >= ${startTs}` : sql``}
        ${endTs ? sql`AND f.created_at <= ${endTs}` : sql``}
      ORDER BY distance ASC
      LIMIT ${limit}
    `;
  } else {
    const pattern = `%${query}%`;
    facts = await sql`
      SELECT
        f.fact_id,
        f.source_note_id,
        f.title,
        f.content,
        f.keywords,
        f.is_factoid,
        f.factoid_type,
        f.confidence,
        f.memory_type,
        f.expires_type,
        f.created_at,
        sn.filename,
        sn.title AS source_title,
        sn.summary AS source_summary
      FROM app.fact f
      LEFT JOIN app.source_note sn ON f.source_note_id = sn.source_note_id
      WHERE f.is_active = true
        AND (
          f.content ILIKE ${pattern}
          OR f.title ILIKE ${pattern}
          OR f.qe_text ILIKE ${pattern}
          OR EXISTS (SELECT 1 FROM unnest(f.keywords) k WHERE k ILIKE ${pattern})
        )
        ${startTs ? sql`AND f.created_at >= ${startTs}` : sql``}
        ${endTs ? sql`AND f.created_at <= ${endTs}` : sql``}
      ORDER BY f.created_at ASC
      LIMIT ${limit}
    `;
  }

  // Group facts by source note
  const grouped = new Map<string, { summary: string | null; source: string; facts: typeof facts }>();
  for (const f of facts) {
    const key = f.source_note_id ?? "unknown";
    if (!grouped.has(key)) {
      grouped.set(key, {
        summary: f.source_summary,
        source: f.filename ?? f.source_title ?? "unknown",
        facts: [],
      });
    }
    grouped.get(key)!.facts.push(f);
  }

  if (output === "llm") {
    const sections: string[] = [];
    for (const [, group] of grouped) {
      const lines: string[] = [];
      lines.push(`## ${group.source}`);
      if (group.summary) lines.push(group.summary);
      lines.push("");
      for (const f of group.facts) {
        const date = new Date(f.created_at).toISOString().slice(0, 10);
        const dist = f.distance != null ? ` (relevance: ${(1 - f.distance).toFixed(2)})` : "";
        lines.push(`- [${date}] ${f.title}: ${f.content}${dist}`);
      }
      sections.push(lines.join("\n"));
    }
    return c.text(sections.join("\n\n"));
  }

  const sources = [...grouped.entries()].map(([sourceNoteId, group]) => ({
    source_note_id: sourceNoteId,
    source: group.source,
    summary: group.summary,
    facts: group.facts.map((f) => ({
      fact_id: f.fact_id,
      title: f.title,
      content: f.content,
      keywords: f.keywords,
      is_factoid: f.is_factoid,
      factoid_type: f.factoid_type,
      confidence: f.confidence,
      memory_type: f.memory_type,
      expires_type: f.expires_type,
      created_at: f.created_at,
      ...(f.distance != null ? { distance: f.distance } : {}),
    })),
  }));

  return c.json({
    query,
    count: facts.length,
    sources,
  });
});

search.post("/api/facts/search-keywords", async (c) => {
  const body = await c.req.json<{
    keywords: string[];
    match?: "any" | "all";
    limit?: number;
    startts?: string;
    endts?: string;
  }>();

  if (!body.keywords || !Array.isArray(body.keywords) || body.keywords.length === 0) {
    return c.json({ error: "keywords array is required and must be non-empty" }, 400);
  }

  const keywords = body.keywords.map((k) => k.toLowerCase().trim()).filter(Boolean);
  const matchMode = body.match ?? "any";
  const limit = body.limit ?? 20;
  const startTs = parseTimestamp(body.startts);
  const endTs = parseTimestamp(body.endts);

  // Search the keywords[] array column using case-insensitive matching
  // "any" = fact has at least one of the given keywords
  // "all" = fact has all of the given keywords
  const facts = await sql`
    SELECT
      f.fact_id,
      f.source_note_id,
      f.title,
      f.content,
      f.keywords,
      f.is_factoid,
      f.factoid_type,
      f.confidence,
      f.memory_type,
      f.expires_type,
      f.created_at,
      sn.filename,
      sn.title AS source_title,
      sn.summary AS source_summary
    FROM app.fact f
    LEFT JOIN app.source_note sn ON f.source_note_id = sn.source_note_id
    WHERE f.is_active = true
      AND ${
        matchMode === "all"
          ? sql`(
              SELECT count(DISTINCT kw)
              FROM unnest(f.keywords) AS fk,
                   unnest(${keywords}::text[]) AS kw
              WHERE lower(fk) = kw
            ) = ${keywords.length}`
          : sql`EXISTS (
              SELECT 1
              FROM unnest(f.keywords) AS fk,
                   unnest(${keywords}::text[]) AS kw
              WHERE lower(fk) = kw
            )`
      }
      ${startTs ? sql`AND f.created_at >= ${startTs}` : sql``}
      ${endTs ? sql`AND f.created_at <= ${endTs}` : sql``}
    ORDER BY f.created_at DESC
    LIMIT ${limit}
  `;

  // Format as LLM-readable text (same grouped style as search)
  const grouped = new Map<string, { summary: string | null; source: string; facts: typeof facts }>();
  for (const f of facts) {
    const key = f.source_note_id ?? "unknown";
    if (!grouped.has(key)) {
      grouped.set(key, {
        summary: f.source_summary,
        source: f.filename ?? f.source_title ?? "unknown",
        facts: [],
      });
    }
    grouped.get(key)!.facts.push(f);
  }

  const sections: string[] = [];
  for (const [, group] of grouped) {
    const lines: string[] = [];
    lines.push(`## ${group.source}`);
    if (group.summary) lines.push(group.summary);
    lines.push("");
    for (const f of group.facts) {
      const date = new Date(f.created_at).toISOString().slice(0, 10);
      lines.push(`- [${date}] ${f.title}: ${f.content} (keywords: ${f.keywords.join(", ")})`);
    }
    sections.push(lines.join("\n"));
  }

  return c.text(sections.join("\n\n") || "No facts found matching those keywords.");
});

function parseTimestamp(val?: string): Date | null {
  if (!val) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
    return new Date(`${val}T00:00:00`);
  }
  const d = new Date(val);
  if (isNaN(d.getTime())) return null;
  return d;
}

export { search };
