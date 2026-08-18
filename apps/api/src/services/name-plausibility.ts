// Words that mark a string as an outlet/company/section name rather than a
// person, seen in real Day 5 extraction output ("Maplebear Inc. dba
// Instacart") and anticipated from similar press-release/wire bylines.
const COMPANY_WORDS = new Set([
  "inc",
  "llc",
  "corp",
  "corporation",
  "company",
  "co",
  "dba",
  "news",
  "staff",
  "times",
  "post",
  "media",
  "group",
  "team",
  "editorial",
  "newsroom",
  "press",
  "wire",
  "network",
  "communications",
  "holdings",
  "ltd",
]);

// A single capitalized word token, allowing internal hyphens/apostrophes/
// periods (e.g. "Jean-Paul", "O'Brien", "J.").
const NAME_TOKEN_PATTERN = /^[A-Z][a-zA-Z'.-]*$/;

/**
 * A coarse plausibility check for whether `name` looks like a real person's
 * name, as opposed to an outlet/company self-attribution or a byline-parsing
 * artifact. Structural only — no AI, no external lookups. Gates whether
 * pattern-guessing or name-matched contact-page scanning is even attempted
 * for a given author (see contact-discovery.ts).
 */
export function looksLikePersonName(name: string | null | undefined): boolean {
  if (!name) return false;

  const trimmed = name.trim();
  if (trimmed.length === 0) return false;

  const tokens = trimmed.split(/\s+/);

  // A single token ("RT") or more than 4 ("A New Byline Reads Like This")
  // doesn't read as an ordinary person name.
  if (tokens.length < 2 || tokens.length > 4) return false;

  // All-uppercase multi-word strings ("AP NEWS") read as an outlet/wire
  // service, not a person.
  if (trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)) return false;

  const normalizedTokens = tokens.map((token) => token.toLowerCase().replace(/[.,]/g, ""));
  if (normalizedTokens.some((token) => COMPANY_WORDS.has(token))) return false;

  // Every token must look like a capitalized word — rejects stray numbers or
  // date fragments (e.g. the "7" in "MarketBeat August 7") and all-lowercase
  // filler words.
  return tokens.every((token) => NAME_TOKEN_PATTERN.test(token));
}
