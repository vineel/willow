const FINANCIAL_INSTITUTIONS = [
  "bank of america",
  "chase",
  "etrade",
  "e-trade",
  "e\\*trade",
  "schwab",
  "fidelity",
  "apple card",
  "apple cash",
  "merrill lynch",
  "merrill",
];

// Build one regex for all institutions
const institutionPattern = new RegExp(
  FINANCIAL_INSTITUTIONS.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "i",
);

// SSN patterns: 123-45-6789, 123 45 6789, 123456789 (9 digits)
const ssnPattern = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/;

// Credit card patterns: 13-19 digits, possibly with spaces/dashes
const ccPattern = /\b(?:\d[-\s]?){13,19}\b/;

// Password/credential indicators near values
const credentialPattern = /\b(?:password|passwd|pwd|pin|passcode|secret[_\s]?key|api[_\s]?key|access[_\s]?key)\s*[:=]\s*\S+/i;

export interface SensitivityResult {
  isSensitive: boolean;
  reasons: string[];
}

export function checkSensitivity(text: string): SensitivityResult {
  const reasons: string[] = [];

  if (institutionPattern.test(text)) {
    reasons.push("Contains financial institution name");
  }

  if (ssnPattern.test(text)) {
    reasons.push("Contains possible SSN pattern");
  }

  if (ccPattern.test(text)) {
    reasons.push("Contains possible credit card number");
  }

  if (credentialPattern.test(text)) {
    reasons.push("Contains credential/password pattern");
  }

  return {
    isSensitive: reasons.length > 0,
    reasons,
  };
}
