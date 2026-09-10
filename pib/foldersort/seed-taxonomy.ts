// Seed taxonomy for the willow-secondary subfolders. Applied by the
// bootstrap CLI on first run. Existing descriptions/rules are preserved on
// subsequent runs; this is only a starting point.
//
// Folder names MUST match Fastmail's actual mailbox names exactly.

export interface SeedRule {
  field: "from_address" | "from_domain" | "subject" | "header" | "source_type";
  operator: "equals" | "contains" | "starts_with" | "ends_with" | "regex" | "exists" | "gte";
  value: string;
  header_name?: string;
  priority?: number;
}

export interface SeedProfile {
  name: string;
  enabled: boolean;
  description: string;
  llm_hint?: string;
  example_senders?: string[];
  rules?: SeedRule[];
}

export const SEED_PROFILES: SeedProfile[] = [
  {
    name: "uninteresting",
    enabled: true,
    description:
      "repeated transactional emails, marketing from companies the user does not care about, generic notifications, mundane stuff",
    llm_hint:
      "Catch-all bucket for noise that isn't quite spam. Shipping notifications, order confirmations from unfamiliar stores, automated 'your account...' notices, low-stakes marketing.",
  },
  {
    name: "marketing-interesting",
    enabled: true,
    description:
      "marketing about things the user might care about — concerts, AI lab updates, music/movie festivals, books, niche commerce",
    llm_hint:
      "Marketing that's worth glancing at later but not now. Spotify concert announcements, Anthropic/OpenAI product updates, music & film festival programs, Amazon book recommendations, niche commerce (Zenni glasses, VISASQ expert calls).",
    rules: [
      { field: "from_domain", operator: "equals", value: "spotify.com", priority: 10 },
      { field: "from_domain", operator: "equals", value: "anthropic.com", priority: 10 },
      { field: "from_domain", operator: "equals", value: "openai.com", priority: 10 },
      { field: "from_domain", operator: "equals", value: "visasq.com", priority: 10 },
      { field: "from_domain", operator: "equals", value: "zenni.com", priority: 10 },
      { field: "subject", operator: "contains", value: "Top Kindle Books", priority: 12 },
    ],
  },
  {
    name: "zeph-college",
    enabled: true,
    description:
      "college and university outreach to Zeph (Zephyros) or to any high-school student in the household — admissions, campus visits, applications",
    llm_hint:
      "Look for .edu domains, admissions-office senders, and language about applications, campus visits, financial aid, info sessions, college fairs. The student's first name 'Zeph' or 'Zephyros' in the body is a strong signal.",
  },
  {
    name: "maybe-spam",
    enabled: true,
    description:
      "likely spam, political outreach, PAC and campaign mail",
    llm_hint:
      "Political campaigns, PACs, advocacy orgs asking for money, and obvious spam that survived triage. The user wants these visible (not silently discarded) so they can review.",
  },
  {
    name: "my-reading",
    enabled: true,
    description:
      "newsletters and reading-list content the user reads regularly — Substack, Business Insider, Alley Watch, NY Times",
    llm_hint:
      "Longer-form newsletter content the user wants to read at leisure. Many Substacks come from custom domains, so look for newsletter-style structure even when the domain doesn't say 'substack'.",
    rules: [
      { field: "from_domain", operator: "ends_with", value: "substack.com", priority: 10 },
      { field: "from_domain", operator: "equals", value: "businessinsider.com", priority: 10 },
      { field: "from_domain", operator: "equals", value: "alleywatch.com", priority: 10 },
    ],
  },
  {
    name: "people-i-dont-know",
    enabled: true,
    description:
      "mail from an actual individual person whom the user hasn't corresponded with recently",
    llm_hint:
      "The decide engine first checks: does the sender look like an individual (has a person-name, no List-Unsubscribe header, no automation cues)? AND is from_address NOT in app.correspondent? If both true, this is the target. If the sender IS in app.correspondent, keep in inbox.",
  },
  {
    name: "vineel-curated",
    enabled: false, // managed by a Fastmail rule on To: curate@vineel.com
    description:
      "(managed externally by a Fastmail rule on To: curate@vineel.com — never an LLM target)",
  },
];
