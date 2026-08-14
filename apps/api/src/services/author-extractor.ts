import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

export type AuthorExtractionMethod =
  "JSON_LD" | "META_TAG" | "BYLINE_PATTERN" | "AUTHOR_BIO_PAGE" | "STAFF_PAGE" | "NONE";

export interface AuthorExtractionResult {
  method: AuthorExtractionMethod;
  name: string | null;
  confidence: number;
  profileUrl: string | null;
}

const NONE_RESULT: AuthorExtractionResult = {
  method: "NONE",
  name: null,
  confidence: 0,
  profileUrl: null,
};

// "By Jane Doe" — 2 to 4 capitalized words following "By ", anchored to the
// start of a single element's own text so it only matches short byline-shaped
// nodes near the top of the article rather than anywhere in a long paragraph.
const BYLINE_TEXT_PATTERN = /^By\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/;

const BYLINE_SELECTOR = [
  '[class*="byline" i]',
  '[id*="byline" i]',
  '[class*="author-name" i]',
  '[id*="author-name" i]',
  '[class*="article-author" i]',
  '[id*="article-author" i]',
  '[class*="post-author" i]',
  '[id*="post-author" i]',
  '[rel="author"]',
].join(", ");

const AUTHOR_LINK_SELECTOR = [
  'a[href*="/author/"]',
  'a[href*="/staff/"]',
  'a[href*="/contributor/"]',
].join(", ");

function resolveUrl(value: string, baseUrl?: string): string {
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return value;
  }
}

// A profile-URL check, not a strict validator — article:author sometimes
// holds an absolute URL, sometimes a site-relative path.
function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || value.startsWith("/");
}

// Like `.text()`, but joins each text node with a space instead of
// concatenating raw. Real byline markup often nests unrelated sibling
// elements with no whitespace text node between them in the source (e.g. a
// name <div> immediately followed by a date <div>) — plain `.text()` mashes
// those into one word ("MarketBeatAugust 7") instead of "MarketBeat August 7".
function spacedText($: CheerioAPI, $node: Cheerio<AnyNode>): string {
  const parts: string[] = [];
  $node.contents().each((_, child) => {
    if (child.type === "text") {
      parts.push($(child).text());
    } else if (child.type === "tag") {
      parts.push(spacedText($, $(child)));
    }
  });
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function cleanName(raw: string): string | null {
  const name = raw
    .split(/[\n,|•·–—]/)[0]! // drop trailing "· Aug 10, 2026" / "| Staff Writer" / co-author lists
    .replace(/\s+/g, " ")
    .replace(/^(?:written\s+)?by\s+/i, "")
    .trim();
  return name.length > 0 && name.length <= 100 ? name : null;
}

// --- Strategy 1: JSON-LD schema.org Article/NewsArticle author ---

function namesFromAuthorField(author: unknown): string[] {
  if (typeof author === "string") {
    const name = cleanName(author);
    return name ? [name] : [];
  }
  if (Array.isArray(author)) {
    return author.flatMap(namesFromAuthorField);
  }
  if (
    author &&
    typeof author === "object" &&
    typeof (author as { name?: unknown }).name === "string"
  ) {
    const name = cleanName((author as { name: string }).name);
    return name ? [name] : [];
  }
  return [];
}

function isArticleType(type: unknown): boolean {
  if (typeof type === "string") return type.includes("Article");
  if (Array.isArray(type)) return type.some((t) => typeof t === "string" && t.includes("Article"));
  return false;
}

function extractJsonLd($: CheerioAPI): AuthorExtractionResult | null {
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse($(el).text());
    } catch {
      continue;
    }

    const topLevel = Array.isArray(parsed) ? parsed : [parsed];
    // Some sites wrap multiple entities in a top-level `@graph` array rather
    // than emitting the Article node directly.
    const nodes = topLevel.flatMap((entry) =>
      entry &&
      typeof entry === "object" &&
      Array.isArray((entry as { "@graph"?: unknown })["@graph"])
        ? (entry as { "@graph": unknown[] })["@graph"]
        : [entry],
    );

    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const { "@type": type, author } = node as { "@type"?: unknown; author?: unknown };
      if (!isArticleType(type)) continue;

      const names = namesFromAuthorField(author);
      if (names.length > 0) {
        return { method: "JSON_LD", name: names[0]!, confidence: 0.95, profileUrl: null };
      }
    }
  }

  return null;
}

// --- Strategy 2: meta tags ---

interface MetaTagOutcome {
  result: AuthorExtractionResult | null;
  // article:author sometimes holds a profile URL instead of a name — captured
  // here so a later strategy in the waterfall that does find a name can still
  // carry this genuinely-known profile URL forward.
  fallbackProfileUrl: string | null;
}

function extractMetaTags($: CheerioAPI, baseUrl?: string): MetaTagOutcome {
  const nameContent = $('meta[name="author"]').attr("content");
  const nameCandidate = nameContent ? cleanName(nameContent) : null;
  if (nameCandidate) {
    return {
      result: { method: "META_TAG", name: nameCandidate, confidence: 0.75, profileUrl: null },
      fallbackProfileUrl: null,
    };
  }

  const articleAuthorContent = $('meta[property="article:author"]').attr("content");
  if (articleAuthorContent) {
    if (looksLikeUrl(articleAuthorContent)) {
      return { result: null, fallbackProfileUrl: resolveUrl(articleAuthorContent, baseUrl) };
    }
    const candidate = cleanName(articleAuthorContent);
    if (candidate) {
      return {
        result: { method: "META_TAG", name: candidate, confidence: 0.75, profileUrl: null },
        fallbackProfileUrl: null,
      };
    }
  }

  return { result: null, fallbackProfileUrl: null };
}

// --- Strategy 3: common byline markup, with a text-pattern fallback ---

function extractByline($: CheerioAPI): AuthorExtractionResult | null {
  for (const el of $(BYLINE_SELECTOR).toArray()) {
    const name = cleanName(spacedText($, $(el)));
    if (name) {
      return { method: "BYLINE_PATTERN", name, confidence: 0.55, profileUrl: null };
    }
  }

  // Fallback: scan element text near the top of the article body for a
  // "By <Name>" pattern, in case there's no dedicated byline markup at all.
  const container = $("article").first().length ? $("article").first() : $("body");
  for (const el of container
    .find("p, span, div, h1, h2, h3, li, time, strong, em, a")
    .slice(0, 80)
    .toArray()) {
    const match = spacedText($, $(el)).match(BYLINE_TEXT_PATTERN);
    if (match?.[1]) {
      return { method: "BYLINE_PATTERN", name: match[1], confidence: 0.55, profileUrl: null };
    }
  }

  return null;
}

// --- Strategy 4: author bio / staff / contributor page links ---

function extractAuthorLink($: CheerioAPI, baseUrl?: string): AuthorExtractionResult | null {
  for (const el of $(AUTHOR_LINK_SELECTOR).toArray()) {
    const href = $(el).attr("href");
    if (!href) continue;

    const name = cleanName(spacedText($, $(el)));
    if (!name) continue;

    // The enum splits this strategy's brief-described "/author/, /staff/,
    // /contributor/" href patterns into two DB values; /staff/ maps to
    // STAFF_PAGE, the other two (bio and contributor pages are the same
    // concept — a person's profile page) map to AUTHOR_BIO_PAGE.
    const method: AuthorExtractionMethod = href.includes("/staff/")
      ? "STAFF_PAGE"
      : "AUTHOR_BIO_PAGE";
    return { method, name, confidence: 0.4, profileUrl: resolveUrl(href, baseUrl) };
  }

  return null;
}

/**
 * Runs the extraction waterfall against already-fetched article HTML, in
 * fixed priority order, stopping at the first strategy that finds a name.
 * `baseUrl` (the article's own URL) is used only to resolve relative href/
 * meta-content values into absolute profile URLs.
 */
export function extractAuthor(html: string, baseUrl?: string): AuthorExtractionResult {
  const $ = cheerio.load(html);

  const jsonLd = extractJsonLd($);
  if (jsonLd) return jsonLd;

  const meta = extractMetaTags($, baseUrl);
  if (meta.result) return meta.result;

  const byline = extractByline($);
  if (byline) return { ...byline, profileUrl: meta.fallbackProfileUrl };

  const authorLink = extractAuthorLink($, baseUrl);
  if (authorLink)
    return { ...authorLink, profileUrl: authorLink.profileUrl ?? meta.fallbackProfileUrl };

  // Nothing matched anywhere — a legitimate outcome, not an error. Any
  // fallback profile URL captured along the way is discarded rather than
  // attached to a NONE result, so NONE consistently means "found nothing at
  // all" rather than a partial, name-less result.
  return NONE_RESULT;
}
