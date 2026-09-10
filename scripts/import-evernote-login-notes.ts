import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";

const SOURCE_ROOT =
  "/Users/vineel/Dropbox/VineelerNotes/from-evernote/Logins, Accts, Serials";
const DEST_ROOT =
  "/Users/vineel/Dropbox/VineelerNotes/inbox/accounts-and-logins/from-evernote-login-pass";

type SourceNote = {
  path: string;
  relativePath: string;
  title: string;
  created: string | null;
  updated: string | null;
  tags: string[];
  body: string;
};

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "untitled";
}

function parseFrontmatter(text: string): {
  attrs: Record<string, string>;
  body: string;
} {
  if (!text.startsWith("---\n")) return { attrs: {}, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return { attrs: {}, body: text };
  const raw = text.slice(4, end);
  const attrs: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match) attrs[match[1]] = match[2].trim();
  }
  return { attrs, body: text.slice(end + "\n---\n".length).trimStart() };
}

function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  const jsonish = raw.trim();
  if (!jsonish.startsWith("[")) return [];
  try {
    const parsed = JSON.parse(jsonish);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function unquote(raw: string | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    const s = await stat(path);
    if (s.isDirectory()) {
      out.push(...await walk(path));
    } else {
      out.push(path);
    }
  }
  return out;
}

function noteFromSource(path: string, text: string): SourceNote {
  const parsed = parseFrontmatter(text);
  const title = unquote(parsed.attrs.title) ?? basename(path, extname(path));
  return {
    path,
    relativePath: relative(SOURCE_ROOT, path),
    title,
    created: unquote(parsed.attrs.created),
    updated: unquote(parsed.attrs.updated),
    tags: parseTags(parsed.attrs.tags),
    body: parsed.body.trimEnd(),
  };
}

function renderImportedNote(note: SourceNote, now: string): string {
  const tags = Array.from(new Set(["account", "login", "from-evernote", ...note.tags]));
  const sourceLine = `Source file: ${note.relativePath}`;
  const sourceCreated = note.created ? `Original created: ${note.created}\n` : "";
  const sourceUpdated = note.updated ? `Original updated: ${note.updated}\n` : "";

  return `---\n` +
    `id: ${randomUUID()}\n` +
    `title: ${yamlString(`evernote login import: ${note.title}`)}\n` +
    `created: ${now}\n` +
    `updated: ${now}\n` +
    `tags: ${JSON.stringify(tags)}\n` +
    `keywords: []\n` +
    `facets: {}\n` +
    `---\n\n` +
    `# evernote login import: ${note.title}\n\n` +
    `${sourceLine}\n` +
    `${sourceCreated}` +
    `${sourceUpdated}` +
    `Imported by local Evernote login pass on ${now}.\n\n` +
    `---\n\n` +
    `${note.body}\n`;
}

function credentialSnippets(note: SourceNote): string[] {
  const lines = note.body.split(/\r?\n/);
  const interesting =
    /\b(user(name)?|login|e-?mail|email|pass(word)?|pwd|pin|token|secret|access key|api key|recovery code|backup code)\b/i;
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!interesting.test(lines[i])) continue;
    const start = Math.max(0, i - 2);
    const end = Math.min(lines.length - 1, i + 3);
    const prev = ranges[ranges.length - 1];
    if (prev && start <= prev[1] + 1) {
      prev[1] = Math.max(prev[1], end);
    } else {
      ranges.push([start, end]);
    }
  }
  return ranges.map(([start, end]) => {
    const snippet = lines.slice(start, end + 1).join("\n").trim();
    return snippet;
  }).filter(Boolean);
}

function renderCandidateIndex(notes: SourceNote[], now: string): string {
  const sections: string[] = [];
  let snippetCount = 0;
  for (const note of notes) {
    const snippets = credentialSnippets(note);
    if (snippets.length === 0) continue;
    snippetCount += snippets.length;
    sections.push(
      `## ${note.title}`,
      "",
      `Source file: ${note.relativePath}`,
      "",
      ...snippets.flatMap((snippet) => ["```", snippet, "```", ""])
    );
  }

  return `---\n` +
    `id: ${randomUUID()}\n` +
    `title: "Evernote login credential candidate index"\n` +
    `created: ${now}\n` +
    `updated: ${now}\n` +
    `tags: ["account","login","from-evernote","audit"]\n` +
    `keywords: []\n` +
    `facets: {}\n` +
    `---\n\n` +
    `# Evernote login credential candidate index\n\n` +
    `Generated by local Evernote login pass on ${now}.\n\n` +
    `Source notes with candidates: ${sections.filter((s) => s.startsWith("## ")).length}\n` +
    `Credential-adjacent snippets: ${snippetCount}\n\n` +
    `${sections.join("\n")}\n`;
}

async function main() {
  await mkdir(DEST_ROOT, { recursive: true });
  const now = new Date().toISOString();
  const files = (await walk(SOURCE_ROOT)).sort();
  const markdown = files.filter((path) => extname(path).toLowerCase() === ".md");
  const textAttachments = files.filter((path) => [".txt", ".csv"].includes(extname(path).toLowerCase()));
  const attachments = files.filter((path) => {
    const ext = extname(path).toLowerCase();
    return ext !== ".md" && ![".txt", ".csv"].includes(ext);
  });

  let written = 0;
  const outputs: string[] = [];
  const importedNotes: SourceNote[] = [];
  for (const path of [...markdown, ...textAttachments]) {
    const text = await readFile(path, "utf8");
    const note = extname(path).toLowerCase() === ".md"
      ? noteFromSource(path, text)
      : {
          path,
          relativePath: relative(SOURCE_ROOT, path),
          title: basename(path, extname(path)),
          created: null,
          updated: null,
          tags: ["attachment"],
          body: text.trimEnd(),
        };
    const datePrefix = /^(\d{4}-\d{2}-\d{2})/.exec(basename(path))?.[1] ?? now.slice(0, 10);
    const outName = `${datePrefix}-evernote-login-${slugify(note.title)}.md`;
    const outPath = join(DEST_ROOT, outName);
    await writeFile(outPath, renderImportedNote(note, now), "utf8");
    written++;
    outputs.push(outPath);
    importedNotes.push(note);
  }

  const candidateIndexPath = join(DEST_ROOT, "_credential-candidates.md");
  await writeFile(candidateIndexPath, renderCandidateIndex(importedNotes, now), "utf8");

  const auditPath = join(DEST_ROOT, "_import-audit.md");
  const audit = [
    "---",
    `id: ${randomUUID()}`,
    `title: "Evernote login import audit"`,
    `created: ${now}`,
    `updated: ${now}`,
    `tags: ["account","login","from-evernote","audit"]`,
    "keywords: []",
    "facets: {}",
    "---",
    "",
    "# Evernote login import audit",
    "",
    `Source root: ${SOURCE_ROOT}`,
    `Destination root: ${DEST_ROOT}`,
    `Markdown notes imported: ${markdown.length}`,
    `Text attachments imported: ${textAttachments.length}`,
    `Attachments skipped: ${attachments.length}`,
    `Credential candidate index: ${basename(candidateIndexPath)}`,
    "",
    "## Imported notes",
    ...outputs.map((path) => `- ${basename(path)}`),
    "",
    "## Attachments skipped",
    ...attachments.map((path) => `- ${relative(SOURCE_ROOT, path)}`),
    "",
  ].join("\n");
  await writeFile(auditPath, audit, "utf8");

  console.log(JSON.stringify({
    sourceRoot: SOURCE_ROOT,
    destRoot: DEST_ROOT,
    notesWritten: written,
    markdownImported: markdown.length,
    textAttachmentsImported: textAttachments.length,
    attachmentsSkipped: attachments.length,
    auditPath,
    candidateIndexPath,
  }, null, 2));
}

await main();
