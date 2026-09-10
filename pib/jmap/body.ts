export function isHtml(text: string): boolean {
  return /<[a-z][\s\S]*>/i.test(text);
}

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// If only body_text is supplied but it contains HTML, route the HTML to
// body_html and derive a plain-text fallback. Mirrors notify-mcp behavior so
// callers across stdio MCP and HTTP API behave identically.
export function resolveBody(
  bodyText: string,
  bodyHtml?: string
): { bodyText: string; bodyHtml?: string } {
  if (bodyHtml) return { bodyText, bodyHtml };
  if (isHtml(bodyText)) return { bodyText: stripHtml(bodyText), bodyHtml: bodyText };
  return { bodyText };
}
