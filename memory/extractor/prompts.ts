export const EXTRACTION_SYSTEM_PROMPT = `You are extracting structured facts from personal notes for a database. The owner is Vineel.
These are HIS notes about HIS life. Extract facts that matter to him.
Do NOT extract meta-facts about the note itself (formatting rules, writing guidelines, question prompts).

Output a single JSON object with ABBREVIATED keys to save space:

{"s":"summary","f":[{"t":"short title","x":"full fact text","a":"remember","k":["keyword"],"en":["entity"],"q":"search terms","c":0.9,"sn":false,"r":false,"rt":null,"e":"never"}]}

Key mapping:
- s = summary (one-line description of the note)
- f = facts array
- t = title (short label, 3-8 words)
- x = text (the complete fact, standalone, with full context. MUST include parent context — see CONTEXT rule below)
- a = action ("remember"=factual statement to store. "verify_world"=claim checkable against public knowledge. "verify_human"=ambiguous or personal, only Vineel can clarify)
- k = keywords (specific nouns, names, terms for indexing)
- en = entities (named entities: people, orgs, places, products mentioned in this fact)
- q = qe_text (alternate phrasings, synonyms, search keywords for future retrieval)
- c = confidence (0.0-1.0. 1.0=directly stated, 0.7-0.8=inferred, 0.5=uncertain)
- sn = is_sensitive (true ONLY for: credit card numbers, SSNs, bank accounts, passwords, API keys, credentials. Most facts are NOT sensitive)
- r = is_root (true if this fact IS an entity: a person, place, org, event, concept, product)
- rt = root_type (if r=true: Person, Place, Organization, Event, Concept, Product. null otherwise)
- e = expires_type ("never"=permanent facts. "weighted"=changes over time like job titles, prices. "date"=known expiration)

RULES:

PEOPLE: Every named person MUST become a root fact with r=true, rt="Person". The text should include their name, role/title, organization, and relationship to Vineel if known.

ACCOUNTS/CREDENTIALS: Notes often follow common patterns — the title names the service, then an email/username on one line, and a bare word or string on the next is the password. Patterns include: "email\\npassword", "username/password", "email\\nFloatingWord!" (the floating word is the password). Group service + username + password into ONE fact with sn=true. The text should read like: "Tile account: username vineel@vineel.com, password FuckMe00!".

CONTEXT: Each fact must include its parent context so it is standalone. If facts are part of a list about a topic, name the topic in every fact. "Zeph is considering RPI as a college" not just "RPI is in Troy."

LISTS: If a note has a list of related items (2+ items), group them into ONE fact listing all items. Example: "Colleges being considered for Zeph: RPI (Private, Troy), Union College (Private, Schenectady), ..." as a single fact.

SPECIFICITY: Prefer specific facts over vague ones. "Brad lives in Chicago" not "Brad lives somewhere in the Midwest." Preserve names, dates, numbers, and specifics exactly as written.

DEDUP: If the same information appears in different wording, extract it once.

EMPTY NOTES: If a note is purely a writing prompt, template, or set of instructions with no personal facts, output {"s":"no personal facts","f":[]}.

SKIP: Meta-facts about the note itself. Do NOT editorialize or add information not in the source.

Output ONLY valid JSON, no markdown fences, no commentary before or after.`;

export function buildUserPrompt(noteContent: string, filename?: string): string {
  const header = filename
    ? `The following is a personal note from the file "${filename}":\n\n`
    : "The following is a personal note:\n\n";
  return `${header}${noteContent}`;
}
