import { describe, expect, it, vi } from "vitest";
import { CrawlerService, looksLikeEmptyShell } from "./crawler.js";

const SERVER_RENDERED_HTML = `
  <html>
    <head><title>Real Article</title></head>
    <body>
      <script>window.__DATA__ = {};</script>
      <style>.hero { color: red; }</style>
      <article>
        <h1>Hunting gear retailers see a surge in demand</h1>
        <p>
          Outdoor retailers across the region reported a significant uptick in
          sales this quarter, driven largely by new hunters entering the
          market after a wave of public-land access expansions. Analysts say
          the trend is likely to continue into next year as more states
          relax licensing requirements for first-time hunters and anglers.
        </p>
        <p>
          "We've never seen demand like this," said one retail manager,
          noting that inventory of basic gear has been difficult to keep in
          stock since early spring.
        </p>
      </article>
    </body>
  </html>
`;

const EMPTY_SPA_SHELL_HTML = `
  <html>
    <head><title>App</title></head>
    <body>
      <div id="root"></div>
      <script src="/static/js/bundle.js"></script>
    </body>
  </html>
`;

function htmlResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

function robotsResponse(status: number, body = ""): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

function noopSleep(): Promise<void> {
  return Promise.resolve();
}

describe("looksLikeEmptyShell", () => {
  it("returns false for server-rendered content with real text", () => {
    expect(looksLikeEmptyShell(SERVER_RENDERED_HTML)).toBe(false);
  });

  it("returns true for a near-empty SPA root div shell", () => {
    expect(looksLikeEmptyShell(EMPTY_SPA_SHELL_HTML)).toBe(true);
  });
});

describe("CrawlerService.crawlArticle", () => {
  it("marks CRAWLED with rawHtml on a successful server-rendered fetch", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) return robotsResponse(404);
      return htmlResponse(200, SERVER_RENDERED_HTML);
    });
    const renderPage = vi.fn();
    const service = new CrawlerService({ fetchImpl, renderPage, sleepImpl: noopSleep });

    const result = await service.crawlArticle("https://news.example.test/article-1");

    expect(result).toEqual({ status: "CRAWLED", rawHtml: SERVER_RENDERED_HTML });
    expect(renderPage).not.toHaveBeenCalled();
  });

  it("falls back to Playwright rendering when the plain fetch looks like an empty shell", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) return robotsResponse(404);
      return htmlResponse(200, EMPTY_SPA_SHELL_HTML);
    });
    const renderPage = vi.fn().mockResolvedValue(SERVER_RENDERED_HTML);
    const service = new CrawlerService({ fetchImpl, renderPage, sleepImpl: noopSleep });

    const result = await service.crawlArticle("https://spa.example.test/article-1");

    expect(result).toEqual({ status: "CRAWLED", rawHtml: SERVER_RENDERED_HTML });
    expect(renderPage).toHaveBeenCalledWith(
      "https://spa.example.test/article-1",
      expect.any(Number),
    );
  });

  it("marks FAILED with render_failed when the Playwright fallback itself fails", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) return robotsResponse(404);
      return htmlResponse(200, EMPTY_SPA_SHELL_HTML);
    });
    const renderPage = vi.fn().mockRejectedValue(new Error("browser crashed"));
    const service = new CrawlerService({ fetchImpl, renderPage, sleepImpl: noopSleep });

    const result = await service.crawlArticle("https://spa.example.test/article-1");

    expect(result).toEqual({ status: "FAILED", crawlError: "render_failed" });
  });

  it("marks FAILED with robots_disallowed and never fetches the page when robots.txt disallows it", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) {
        return robotsResponse(200, "User-agent: *\nDisallow: /article-1");
      }
      throw new Error("should not fetch the page when robots disallows it");
    });
    const service = new CrawlerService({ fetchImpl, sleepImpl: noopSleep });

    const result = await service.crawlArticle("https://news.example.test/article-1");

    expect(result).toEqual({ status: "FAILED", crawlError: "robots_disallowed" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("allows the crawl when robots.txt fetch itself fails (fail open)", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) throw new Error("ECONNREFUSED");
      return htmlResponse(200, SERVER_RENDERED_HTML);
    });
    const service = new CrawlerService({ fetchImpl, sleepImpl: noopSleep });

    const result = await service.crawlArticle("https://news.example.test/article-1");

    expect(result).toEqual({ status: "CRAWLED", rawHtml: SERVER_RENDERED_HTML });
  });

  it("caches robots.txt per domain, fetching it only once across multiple crawls", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) return robotsResponse(404);
      return htmlResponse(200, SERVER_RENDERED_HTML);
    });
    const service = new CrawlerService({ fetchImpl, sleepImpl: noopSleep });

    await service.crawlArticle("https://news.example.test/article-1");
    await service.crawlArticle("https://news.example.test/article-2");

    const robotsCalls = fetchImpl.mock.calls.filter(([url]) =>
      (url as string).endsWith("/robots.txt"),
    );
    expect(robotsCalls).toHaveLength(1);
  });

  it("marks FAILED with http_404 and does not retry on a 4xx response", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) return robotsResponse(404);
      return htmlResponse(404, "not found");
    });
    const service = new CrawlerService({ fetchImpl, sleepImpl: noopSleep, maxRetries: 2 });

    const result = await service.crawlArticle("https://news.example.test/missing");

    expect(result).toEqual({ status: "FAILED", crawlError: "http_404" });
    // One robots.txt fetch + exactly one page fetch (no retry on 4xx).
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries on 5xx up to maxRetries and then marks FAILED", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) return robotsResponse(404);
      return htmlResponse(503, "unavailable");
    });
    const service = new CrawlerService({ fetchImpl, sleepImpl: noopSleep, maxRetries: 2 });

    const result = await service.crawlArticle("https://news.example.test/flaky");

    expect(result).toEqual({ status: "FAILED", crawlError: "http_503" });
    // One robots.txt fetch + 3 page attempts (initial + 2 retries).
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("succeeds after a transient failure followed by a successful retry", async () => {
    let pageCalls = 0;
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) return robotsResponse(404);
      pageCalls += 1;
      if (pageCalls === 1) return htmlResponse(503, "unavailable");
      return htmlResponse(200, SERVER_RENDERED_HTML);
    });
    const service = new CrawlerService({ fetchImpl, sleepImpl: noopSleep, maxRetries: 2 });

    const result = await service.crawlArticle("https://news.example.test/flaky");

    expect(result).toEqual({ status: "CRAWLED", rawHtml: SERVER_RENDERED_HTML });
    expect(pageCalls).toBe(2);
  });

  it("marks FAILED with timeout when the fetch aborts", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/robots.txt")) return robotsResponse(404);
      const abortError = new Error("aborted");
      abortError.name = "AbortError";
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(abortError));
      });
    });
    const service = new CrawlerService({
      fetchImpl,
      sleepImpl: noopSleep,
      timeoutMs: 1,
      maxRetries: 0,
    });

    const result = await service.crawlArticle("https://news.example.test/slow");

    expect(result).toEqual({ status: "FAILED", crawlError: "timeout" });
  });

  it("marks FAILED with invalid_url for an unparseable URL", async () => {
    const fetchImpl = vi.fn();
    const service = new CrawlerService({ fetchImpl, sleepImpl: noopSleep });

    const result = await service.crawlArticle("not-a-url");

    expect(result).toEqual({ status: "FAILED", crawlError: "invalid_url" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("CrawlerService.fetchPage", () => {
  it("is the shared low-level helper crawlArticle itself now delegates to", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) return robotsResponse(404);
      return htmlResponse(200, SERVER_RENDERED_HTML);
    });
    const service = new CrawlerService({ fetchImpl, sleepImpl: noopSleep });

    const result = await service.fetchPage("https://news.example.test/contact");

    expect(result).toEqual({ html: SERVER_RENDERED_HTML });
  });

  it("applies the same robots.txt gate as crawlArticle", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) {
        return robotsResponse(200, "User-agent: *\nDisallow: /contact");
      }
      throw new Error("should not fetch a disallowed page");
    });
    const service = new CrawlerService({ fetchImpl, sleepImpl: noopSleep });

    const result = await service.fetchPage("https://news.example.test/contact");

    expect(result).toEqual({ error: "robots_disallowed" });
  });

  it("returns an error for a 4xx contact page without retrying", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) return robotsResponse(404);
      return htmlResponse(404, "not found");
    });
    const service = new CrawlerService({ fetchImpl, sleepImpl: noopSleep, maxRetries: 2 });

    const result = await service.fetchPage("https://news.example.test/about");

    expect(result).toEqual({ error: "http_404" });
  });

  it("shares the same per-domain robots.txt cache as crawlArticle", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) return robotsResponse(404);
      return htmlResponse(200, SERVER_RENDERED_HTML);
    });
    const service = new CrawlerService({ fetchImpl, sleepImpl: noopSleep });

    await service.crawlArticle("https://news.example.test/article-1");
    await service.fetchPage("https://news.example.test/contact");

    const robotsCalls = fetchImpl.mock.calls.filter(([url]) =>
      (url as string).endsWith("/robots.txt"),
    );
    expect(robotsCalls).toHaveLength(1);
  });
});

describe("CrawlerService.crawlArticle rate limiting", () => {
  it("waits at least minRequestIntervalMs between two requests to the same domain", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) return robotsResponse(404);
      return htmlResponse(200, SERVER_RENDERED_HTML);
    });
    let now = 0;
    const sleepCalls: number[] = [];
    const service = new CrawlerService({
      fetchImpl,
      now: () => now,
      sleepImpl: (ms: number) => {
        sleepCalls.push(ms);
        now += ms;
        return Promise.resolve();
      },
      minRequestIntervalMs: 2000,
    });

    await service.crawlArticle("https://news.example.test/article-1");
    now += 100; // well under the 2s minimum interval
    await service.crawlArticle("https://news.example.test/article-2");

    // The second page fetch should have waited ~1900ms to respect the
    // per-domain minimum interval since the first page fetch.
    expect(sleepCalls.some((ms) => ms >= 1800 && ms <= 1900)).toBe(true);
  });

  it("does not carry one domain's rate-limit wait over to a different domain", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) return robotsResponse(404);
      return htmlResponse(200, SERVER_RENDERED_HTML);
    });
    let now = 0;
    const service = new CrawlerService({
      fetchImpl,
      now: () => now,
      sleepImpl: (ms: number) => {
        now += ms;
        return Promise.resolve();
      },
      minRequestIntervalMs: 2000,
    });

    await service.crawlArticle("https://a.example.test/article");
    const elapsedForA = now;
    await service.crawlArticle("https://b.example.test/article");
    const elapsedForB = now - elapsedForA;

    // Each domain incurs its own one-time robots.txt-then-page wait on a
    // first visit; domain B's wait should match domain A's, not be
    // inflated by domain A's timing bleeding across domains.
    expect(elapsedForB).toBe(elapsedForA);
  });
});
