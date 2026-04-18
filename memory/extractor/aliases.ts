// Personal alias table — maps informal/kinship/nickname references to the
// canonical Person entity name to use at extraction time. The extraction
// prompt is built at runtime and injects this block, so editing this file
// changes extractor behavior immediately without touching prompts.ts.
//
// Add new aliases as you discover them. Keep canonical names as full names.

export interface Alias {
  aliases: string[];    // ways Vineel refers to this person in notes
  canonical: string;    // canonical full name to use for the Person entity
  note?: string;        // optional description (not sent to the LLM)
}

export const PERSONAL_ALIASES: Alias[] = [
  {
    aliases: ["Dad", "my dad", "Father", "Vinod", "Pops"],
    canonical: "Vinod Shah",
    note: "Vineel's father",
  },
  {
    aliases: ["Mom", "my mom", "Mother", "Neela"],
    canonical: "Neela Shah",
    note: "Vineel's mother",
  },
  {
    aliases: ["Stephanie", "my wife", "Steph", "Stef"],
    canonical: "Stephanie Shah",
    note: "Vineel's wife",
  },
  {
    aliases: ["Zeph", "my son"],
    canonical: "Zeph Shah",
    note: "Vineel's son (15)",
  },
  {
    aliases: ["Ele", "my daughter"],
    canonical: "Ele Shah",
    note: "Vineel's daughter (13, they/them)",
  },
];

/** Render the alias block for injection into the extraction system prompt. */
export function renderAliasBlock(): string {
  if (PERSONAL_ALIASES.length === 0) return "";
  const lines = [
    "PERSONAL ALIASES (when these terms appear in a note, use the canonical name as the Person entity title, NEVER the alias):",
  ];
  for (const a of PERSONAL_ALIASES) {
    const aliasList = a.aliases.map((x) => `"${x}"`).join(", ");
    lines.push(`- ${aliasList} → ${a.canonical}`);
  }
  return lines.join("\n");
}
