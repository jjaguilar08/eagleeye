import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { spacedText } from "./author-extractor.js";
import { looksLikePersonName } from "./name-plausibility.js";

export type ContactAttemptMethod = "CONTACT_PAGE_SCAN" | "EMAIL_PATTERN_GUESS" | "OUTLET_FALLBACK";
export type ContactAttemptStatus = "FOUND" | "OUTLET_FALLBACK" | "NEEDS_REVIEW" | "FAILED";

export interface ContactAttemptResult {
  method: ContactAttemptMethod;
  status: ContactAttemptStatus;
  confidence: number;
  emailCandidate: string | null;
}

export interface ContactDiscoveryAuthor {
  name: string | null;
  profileUrl: string | null;
}

export interface FetchPageFn {
  (url: string): Promise<{ html: string } | { error: string }>;
}

// Local-parts an outlet's general contact/about page is likely to publish for
// press/reader inquiries, preferred over whatever other mailto happens to be
// on the page first.
const PREFERRED_OUTLET_LOCAL_PARTS = ["editor", "news", "info", "contact", "tips"];

function outletCandidateUrls(sourceDomain: string): string[] {
  const domain = sourceDomain.replace(/^www\./i, "");
  return [`https://${domain}/contact`, `https://${domain}/about`];
}

function emailFromMailtoHref(href: string): string | null {
  const email = href
    .replace(/^mailto:/i, "")
    .split("?")[0]
    ?.trim();
  return email ? email : null;
}

function findMailtoMatchingName($: CheerioAPI, name: string): string | null {
  const tokens = name.toLowerCase().split(/\s+/).filter(Boolean);
  const lastName = tokens[tokens.length - 1];

  for (const el of $('a[href^="mailto:" i]').toArray()) {
    const href = $(el).attr("href");
    if (!href) continue;
    const email = emailFromMailtoHref(href);
    if (!email) continue;

    const label = `${spacedText($, $(el))} ${spacedText($, $(el).parent())}`.toLowerCase();
    const lastNamePattern = lastName ? new RegExp(`\\b${escapeRegExp(lastName)}\\b`) : null;

    if (tokens.every((token) => label.includes(token)) || lastNamePattern?.test(label)) {
      return email;
    }
  }

  return null;
}

function findGeneralMailto($: CheerioAPI): string | null {
  const emails: string[] = [];
  for (const el of $('a[href^="mailto:" i]').toArray()) {
    const href = $(el).attr("href");
    if (!href) continue;
    const email = emailFromMailtoHref(href);
    if (email) emails.push(email);
  }

  if (emails.length === 0) return null;

  const preferred = emails.find((email) =>
    PREFERRED_OUTLET_LOCAL_PARTS.some((localPart) =>
      email.toLowerCase().split("@")[0]!.includes(localPart),
    ),
  );
  return preferred ?? emails[0]!;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// first.last@domain, lowercased with non-alphanumeric characters stripped
// from each name part — the single most common real-world pattern. Always
// unverified (see the NEEDS_REVIEW status this is logged under).
function generateEmailPatternGuess(name: string, sourceDomain: string): string {
  const tokens = name.trim().split(/\s+/);
  const first = tokens[0]!.toLowerCase().replace(/[^a-z0-9]/g, "");
  const last = tokens[tokens.length - 1]!.toLowerCase().replace(/[^a-z0-9]/g, "");
  const domain = sourceDomain.replace(/^www\./i, "");
  return `${first}.${last}@${domain}`;
}

/**
 * Runs the CONTACT_PAGE_SCAN → EMAIL_PATTERN_GUESS → OUTLET_FALLBACK
 * waterfall for one author, returning every method actually attempted (not
 * just the winner) as a full log, matching the ContactAttempt schema. Fetches
 * go through `fetchPage` (the caller wires in CrawlerService.fetchPage) so
 * every new request gets the same robots.txt + rate-limit treatment as
 * article crawling. Pages fetched here are scanned transiently and never
 * persisted.
 */
export async function discoverContacts(
  author: ContactDiscoveryAuthor,
  sourceDomain: string,
  fetchPage: FetchPageFn,
): Promise<ContactAttemptResult[]> {
  const results: ContactAttemptResult[] = [];
  const pageCache = new Map<string, { html: string } | { error: string }>();

  async function fetchCached(url: string) {
    const cached = pageCache.get(url);
    if (cached) return cached;
    const result = await fetchPage(url);
    pageCache.set(url, result);
    return result;
  }

  let foundEmail = false;
  const plausible = looksLikePersonName(author.name);

  if (plausible) {
    const candidateUrls = author.profileUrl
      ? [author.profileUrl]
      : outletCandidateUrls(sourceDomain);

    let matchedEmail: string | null = null;
    for (const url of candidateUrls) {
      const page = await fetchCached(url);
      if ("html" in page) {
        matchedEmail = findMailtoMatchingName(cheerio.load(page.html), author.name!);
        if (matchedEmail) break;
      }
    }

    results.push({
      method: "CONTACT_PAGE_SCAN",
      status: matchedEmail ? "FOUND" : "FAILED",
      confidence: matchedEmail ? 0.7 : 0,
      emailCandidate: matchedEmail,
    });

    if (matchedEmail) {
      foundEmail = true;
    } else {
      results.push({
        method: "EMAIL_PATTERN_GUESS",
        status: "NEEDS_REVIEW",
        confidence: 0.3,
        emailCandidate: generateEmailPatternGuess(author.name!, sourceDomain),
      });
    }
  }

  if (!foundEmail) {
    let outletEmail: string | null = null;
    for (const url of outletCandidateUrls(sourceDomain)) {
      const page = await fetchCached(url);
      if ("html" in page) {
        outletEmail = findGeneralMailto(cheerio.load(page.html));
        if (outletEmail) break;
      }
    }

    results.push({
      method: "OUTLET_FALLBACK",
      status: outletEmail ? "OUTLET_FALLBACK" : "FAILED",
      confidence: outletEmail ? 0.5 : 0,
      emailCandidate: outletEmail,
    });
  }

  return results;
}
