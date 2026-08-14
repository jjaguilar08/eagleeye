import { describe, expect, it } from "vitest";
import { extractAuthor } from "./author-extractor.js";

function page(head: string, body: string): string {
  return `<html><head>${head}</head><body>${body}</body></html>`;
}

describe("extractAuthor", () => {
  describe("strategy 1: JSON-LD", () => {
    it("extracts a name from a { name } author object", () => {
      const html = page(
        `<script type="application/ld+json">${JSON.stringify({
          "@context": "https://schema.org",
          "@type": "NewsArticle",
          author: { "@type": "Person", name: "Jane Doe" },
        })}</script>`,
        "<p>Some article text with no other author signals.</p>",
      );

      expect(extractAuthor(html)).toEqual({
        method: "JSON_LD",
        name: "Jane Doe",
        confidence: 0.95,
        profileUrl: null,
      });
    });

    it("extracts a name when author is a plain string", () => {
      const html = page(
        `<script type="application/ld+json">${JSON.stringify({
          "@type": "Article",
          author: "Alex Rivera",
        })}</script>`,
        "<p>Body</p>",
      );

      expect(extractAuthor(html).name).toBe("Alex Rivera");
      expect(extractAuthor(html).method).toBe("JSON_LD");
    });

    it("extracts the first name from an array of author objects", () => {
      const html = page(
        `<script type="application/ld+json">${JSON.stringify({
          "@type": "NewsArticle",
          author: [{ name: "Sam Okafor" }, { name: "Chris Lund" }],
        })}</script>`,
        "<p>Body</p>",
      );

      expect(extractAuthor(html).name).toBe("Sam Okafor");
    });

    it("finds the Article node inside a top-level @graph array", () => {
      const html = page(
        `<script type="application/ld+json">${JSON.stringify({
          "@context": "https://schema.org",
          "@graph": [
            { "@type": "WebSite", name: "Example News" },
            { "@type": "NewsArticle", author: { name: "Robin Park" } },
          ],
        })}</script>`,
        "<p>Body</p>",
      );

      expect(extractAuthor(html).name).toBe("Robin Park");
    });

    it("ignores JSON-LD blocks whose type isn't Article/NewsArticle", () => {
      const html = page(
        `<script type="application/ld+json">${JSON.stringify({
          "@type": "Organization",
          author: "Should Not Be Used",
        })}</script>`,
        "<p>Body</p>",
      );

      expect(extractAuthor(html)).toEqual({
        method: "NONE",
        name: null,
        confidence: 0,
        profileUrl: null,
      });
    });
  });

  describe("strategy 2: meta tags", () => {
    it("extracts a name from meta[name=author]", () => {
      const html = page(`<meta name="author" content="Morgan Lee">`, "<p>Body</p>");

      expect(extractAuthor(html)).toEqual({
        method: "META_TAG",
        name: "Morgan Lee",
        confidence: 0.75,
        profileUrl: null,
      });
    });

    it("extracts a name from meta[property=article:author] when its content is not a URL", () => {
      const html = page(`<meta property="article:author" content="Taylor Kim">`, "<p>Body</p>");

      expect(extractAuthor(html).name).toBe("Taylor Kim");
      expect(extractAuthor(html).method).toBe("META_TAG");
    });

    it("treats a URL-shaped article:author content as a profileUrl and falls through for the name", () => {
      const html = page(
        `<meta property="article:author" content="https://news.example.test/staff/jordan-blake">`,
        `<div class="byline">By Jordan Blake</div>`,
      );

      expect(extractAuthor(html)).toEqual({
        method: "BYLINE_PATTERN",
        name: "Jordan Blake",
        confidence: 0.55,
        profileUrl: "https://news.example.test/staff/jordan-blake",
      });
    });
  });

  describe("strategy 3: byline patterns", () => {
    it("extracts a name from a byline-class element", () => {
      const html = page("", `<div class="byline">By Alice Cooper</div><p>Article text.</p>`);

      expect(extractAuthor(html)).toEqual({
        method: "BYLINE_PATTERN",
        name: "Alice Cooper",
        confidence: 0.55,
        profileUrl: null,
      });
    });

    it("extracts a name from [rel=author]", () => {
      const html = page("", `<a rel="author">Nina Kapoor</a><p>Article text.</p>`);

      expect(extractAuthor(html).name).toBe("Nina Kapoor");
    });

    it("falls back to a 'By <Name>' text pattern near the top of the article when there's no byline markup", () => {
      const html = page(
        "",
        `<article><p>By Bob Jones</p><p>The rest of the article text goes here.</p></article>`,
      );

      expect(extractAuthor(html)).toEqual({
        method: "BYLINE_PATTERN",
        name: "Bob Jones",
        confidence: 0.55,
        profileUrl: null,
      });
    });
  });

  describe("strategy 4: author bio / staff page links", () => {
    it("extracts a name and profileUrl from an /author/ link", () => {
      const html = page(
        "",
        `<div class="meta">Written by <a href="/author/casey-marsh">Casey Marsh</a></div><p>Article text.</p>`,
      );

      expect(extractAuthor(html, "https://news.example.test/articles/1")).toEqual({
        method: "AUTHOR_BIO_PAGE",
        name: "Casey Marsh",
        confidence: 0.4,
        profileUrl: "https://news.example.test/author/casey-marsh",
      });
    });

    it("maps a /staff/ link to STAFF_PAGE", () => {
      const html = page("", `<a href="/staff/jamie-fox">Jamie Fox</a><p>Article text.</p>`);

      expect(extractAuthor(html, "https://news.example.test/articles/1").method).toBe("STAFF_PAGE");
    });

    it("maps a /contributor/ link to AUTHOR_BIO_PAGE", () => {
      const html = page("", `<a href="/contributor/pat-nguyen">Pat Nguyen</a><p>Article text.</p>`);

      expect(extractAuthor(html).method).toBe("AUTHOR_BIO_PAGE");
    });
  });

  describe("no signals at all", () => {
    it("reports NONE with a null name and zero confidence", () => {
      const html = page("", `<p>Just an article with no author information anywhere.</p>`);

      expect(extractAuthor(html)).toEqual({
        method: "NONE",
        name: null,
        confidence: 0,
        profileUrl: null,
      });
    });
  });

  describe("waterfall ordering", () => {
    it("stops at JSON-LD and never falls through to a present meta tag", () => {
      const html = page(
        `<script type="application/ld+json">${JSON.stringify({
          "@type": "Article",
          author: { name: "JsonLd Author" },
        })}</script><meta name="author" content="Meta Tag Author">`,
        "<p>Body</p>",
      );

      expect(extractAuthor(html)).toEqual({
        method: "JSON_LD",
        name: "JsonLd Author",
        confidence: 0.95,
        profileUrl: null,
      });
    });
  });
});
