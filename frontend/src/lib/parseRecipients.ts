const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ParsedRecipients {
  valid: string[]; // unique, first-occurrence order
  invalid: string[]; // malformed entries, verbatim (never silently discarded)
  duplicates: string[]; // entries that repeat an already-seen valid address
}

/**
 * Splits on commas and newlines (CSV or plain-text paste both work the
 * same way), trims, validates each address, and — per the backend's actual
 * behavior (createCampaign.ts rejects a request containing duplicate
 * recipients with a 400, rather than silently deduping) — reports
 * duplicates as something the user must resolve, not something dropped
 * quietly.
 */
export function parseRecipients(raw: string): ParsedRecipients {
  const tokens = raw
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const valid: string[] = [];
  const invalid: string[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    if (!EMAIL_RE.test(token)) {
      invalid.push(token);
      continue;
    }
    const key = token.toLowerCase();
    if (seen.has(key)) {
      duplicates.push(token);
      continue;
    }
    seen.add(key);
    valid.push(token);
  }

  return { valid, invalid, duplicates };
}

export async function parseRecipientsFile(file: File): Promise<ParsedRecipients> {
  const text = await file.text();
  return parseRecipients(text);
}
