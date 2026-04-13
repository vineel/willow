// Shared title normalization for the cleanup scripts and (future) on-insert
// dedupe hooks. See notes/person-dedupe-strategy.md §1 Block A for the full
// pipeline.
//
// Returns both the normalized string and any stripped "attribution tail"
// (the `Y` from "X from Y") as a separate signal, since the dedupe engine
// uses it independently.

export interface NormalizedTitle {
  normalized: string;
  attributionTail: string | null;
}

const SUFFIXES = [
  " role and team structure",
  " interview preparation",
  " via messenger",
  " via facebook",
  " on facebook",
  " on linkedin",
  " background",
  " background and role",
  " contacts",
  " contact",
  " account",
  " login",
  " info",
  " details",
  " role",
];

const ATTRIBUTION_TAIL_RE = /\s+(?:from|via|at|on)\s+(.+)$/i;
const PARENTHETICAL_RE = /\s*\(([^)]*)\)\s*$/;

export function normalizeTitle(raw: string | null | undefined): NormalizedTitle {
  if (!raw) return { normalized: "", attributionTail: null };

  let s = raw.trim().toLowerCase();

  // 1. Strip parenthetical tails: "(AKA foo)", "(old)"
  while (PARENTHETICAL_RE.test(s)) {
    s = s.replace(PARENTHETICAL_RE, "").trim();
  }

  // 2. Strip attribution tail ("X from Y") but remember Y.
  let attributionTail: string | null = null;
  const attrMatch = s.match(ATTRIBUTION_TAIL_RE);
  if (attrMatch) {
    attributionTail = attrMatch[1].trim();
    s = s.slice(0, attrMatch.index).trim();
  }

  // 3. Strip possessive 's / trailing '
  s = s.replace(/'s\b/g, "").replace(/'$/, "");

  // 4. Strip known suffixes (longest first — we sorted at module load).
  for (const suffix of SUFFIXES_SORTED) {
    if (s.endsWith(suffix)) {
      s = s.slice(0, -suffix.length).trim();
      break;
    }
  }

  // 5. Strip punctuation except inner hyphens (keeping names like Jean-Luc).
  //    Replace with space, collapse.
  s = s.replace(/[^\p{L}\p{N}\s-]/gu, " ");

  // 6. Collapse whitespace.
  s = s.replace(/\s+/g, " ").trim();

  // 7. Normalize attribution tail the same way (recursively, 1 level deep).
  if (attributionTail) {
    attributionTail = attributionTail
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  return { normalized: s, attributionTail };
}

const SUFFIXES_SORTED = [...SUFFIXES].sort((a, b) => b.length - a.length);

export function firstToken(normalized: string): string {
  const m = normalized.match(/^\S+/);
  return m ? m[0] : "";
}
