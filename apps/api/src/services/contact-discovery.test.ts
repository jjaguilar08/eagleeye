import { describe, expect, it, vi } from "vitest";
import { discoverContacts, type FetchPageFn } from "./contact-discovery.js";

function page(html: string): { html: string } {
  return { html };
}

const NO_MAILTO_PAGE = page(`<html><body><p>Get in touch via our form.</p></body></html>`);

describe("discoverContacts", () => {
  it("finds a name-matched email via the author's profileUrl (CONTACT_PAGE_SCAN)", async () => {
    const fetchPage: FetchPageFn = vi.fn(async (url: string) => {
      expect(url).toBe("https://news.example.test/author/jane-doe");
      return page(`
        <div class="staff-card">
          <h3>Jane Doe</h3>
          <a href="mailto:jane.doe@example.test">Email Jane</a>
        </div>
      `);
    });

    const results = await discoverContacts(
      { name: "Jane Doe", profileUrl: "https://news.example.test/author/jane-doe" },
      "news.example.test",
      fetchPage,
    );

    expect(results).toEqual([
      {
        method: "CONTACT_PAGE_SCAN",
        status: "FOUND",
        confidence: 0.7,
        emailCandidate: "jane.doe@example.test",
      },
    ]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("falls back to the outlet's /contact or /about page when there's no profileUrl", async () => {
    const fetchPage: FetchPageFn = vi.fn(async (url: string) => {
      if (url === "https://news.example.test/contact") return NO_MAILTO_PAGE;
      if (url === "https://news.example.test/about") {
        return page(
          `<p>Reach reporter Jane Doe at <a href="mailto:jdoe@example.test">jdoe@example.test</a></p>`,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const results = await discoverContacts(
      { name: "Jane Doe", profileUrl: null },
      "news.example.test",
      fetchPage,
    );

    expect(results[0]).toEqual({
      method: "CONTACT_PAGE_SCAN",
      status: "FOUND",
      confidence: 0.7,
      emailCandidate: "jdoe@example.test",
    });
  });

  it("falls through to EMAIL_PATTERN_GUESS when CONTACT_PAGE_SCAN finds nothing, for a plausible name", async () => {
    const fetchPage: FetchPageFn = vi.fn(async () => NO_MAILTO_PAGE);

    const results = await discoverContacts(
      { name: "Jane Doe", profileUrl: "https://news.example.test/author/jane-doe" },
      "news.example.test",
      fetchPage,
    );

    expect(results).toEqual([
      { method: "CONTACT_PAGE_SCAN", status: "FAILED", confidence: 0, emailCandidate: null },
      {
        method: "EMAIL_PATTERN_GUESS",
        status: "NEEDS_REVIEW",
        confidence: 0.3,
        emailCandidate: "jane.doe@news.example.test",
      },
      { method: "OUTLET_FALLBACK", status: "FAILED", confidence: 0, emailCandidate: null },
    ]);
  });

  it("finds a preferred local-part via OUTLET_FALLBACK when nothing was FOUND", async () => {
    const fetchPage: FetchPageFn = vi.fn(async (url: string) => {
      if (url === "https://news.example.test/contact") {
        return page(`
          <a href="mailto:webmaster@example.test">Webmaster</a>
          <a href="mailto:editor@example.test">Editor</a>
        `);
      }
      return NO_MAILTO_PAGE;
    });

    const results = await discoverContacts(
      { name: "Jane Doe", profileUrl: null },
      "news.example.test",
      fetchPage,
    );

    const outletResult = results.find((r) => r.method === "OUTLET_FALLBACK");
    expect(outletResult).toEqual({
      method: "OUTLET_FALLBACK",
      status: "OUTLET_FALLBACK",
      confidence: 0.5,
      emailCandidate: "editor@example.test",
    });
  });

  it("terminates as FAILED everywhere when nothing is found at all", async () => {
    const fetchPage: FetchPageFn = vi.fn(async () => NO_MAILTO_PAGE);

    const results = await discoverContacts(
      { name: "Jane Doe", profileUrl: null },
      "news.example.test",
      fetchPage,
    );

    expect(results).toEqual([
      { method: "CONTACT_PAGE_SCAN", status: "FAILED", confidence: 0, emailCandidate: null },
      {
        method: "EMAIL_PATTERN_GUESS",
        status: "NEEDS_REVIEW",
        confidence: 0.3,
        emailCandidate: "jane.doe@news.example.test",
      },
      { method: "OUTLET_FALLBACK", status: "FAILED", confidence: 0, emailCandidate: null },
    ]);
  });

  it("skips CONTACT_PAGE_SCAN and EMAIL_PATTERN_GUESS for an implausible name (RT) and only attempts OUTLET_FALLBACK", async () => {
    const fetchPage: FetchPageFn = vi.fn(async () => NO_MAILTO_PAGE);

    const results = await discoverContacts({ name: "RT", profileUrl: null }, "rt.com", fetchPage);

    expect(results).toEqual([
      { method: "OUTLET_FALLBACK", status: "FAILED", confidence: 0, emailCandidate: null },
    ]);
    // Only the outlet /contact and /about pages should have been fetched —
    // no pattern-guessed email like "rt@rt.com" was ever generated.
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("skips pattern-guessing for a company self-attribution (Maplebear Inc. dba Instacart)", async () => {
    const fetchPage: FetchPageFn = vi.fn(async () => NO_MAILTO_PAGE);

    const results = await discoverContacts(
      { name: "Maplebear Inc. dba Instacart", profileUrl: null },
      "instacart.com",
      fetchPage,
    );

    expect(results).toEqual([
      { method: "OUTLET_FALLBACK", status: "FAILED", confidence: 0, emailCandidate: null },
    ]);
  });

  it("skips pattern-guessing for a byline-bleed date artifact (MarketBeat August 7)", async () => {
    const fetchPage: FetchPageFn = vi.fn(async () => NO_MAILTO_PAGE);

    const results = await discoverContacts(
      { name: "MarketBeat August 7", profileUrl: null },
      "marketbeat.com",
      fetchPage,
    );

    expect(results).toEqual([
      { method: "OUTLET_FALLBACK", status: "FAILED", confidence: 0, emailCandidate: null },
    ]);
  });

  it("does not re-fetch the same outlet URL twice within one discovery run", async () => {
    const fetchPage: FetchPageFn = vi.fn(async (url: string) => {
      if (url === "https://news.example.test/contact") return NO_MAILTO_PAGE;
      return NO_MAILTO_PAGE;
    });

    // No profileUrl and an implausible name still only attempts OUTLET_FALLBACK,
    // so this mainly guards the cache path for the plausible-name case below.
    await discoverContacts({ name: "Jane Doe", profileUrl: null }, "news.example.test", fetchPage);

    const contactCalls = (fetchPage as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]) => url === "https://news.example.test/contact",
    );
    expect(contactCalls).toHaveLength(1);
  });
});
