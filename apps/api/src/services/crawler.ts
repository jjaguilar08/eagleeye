import robotsParserImport from "robots-parser";

// robots-parser@3.0.1 ships broken type declarations (an ambient `declare
// module` shorthand merged with a CJS `module.exports = function`, which TS
// resolves to a non-callable namespace type rather than the actual runtime
// function) — cast to the real runtime shape rather than fighting the
// upstream .d.ts.
const robotsParser = robotsParserImport as unknown as (url: string, contents: string) => Robot;

const USER_AGENT = "EagleEyeBot/0.1 (+https://github.com/jjaguilar08/eagleeye)";
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BACKOFF_MS = 500;
// Below this many characters of visible text (script/style/tags stripped), a
// page is treated as an empty JS-shell — this single text-length check covers
// both "barely any text" pages and "near-empty root div" SPA shells, since
// the latter is just a specific cause of the former.
const EMPTY_SHELL_TEXT_THRESHOLD = 200;

interface Robot {
  isAllowed(url: string, ua?: string): boolean | undefined;
  isDisallowed(url: string, ua?: string): boolean | undefined;
}

export type CrawlResult =
  { status: "CRAWLED"; rawHtml: string } | { status: "FAILED"; crawlError: string };

export type FetchPageResult = { html: string } | { error: string };

export interface CrawlerServiceConfig {
  fetchImpl?: typeof fetch;
  /** Renders `url` with a real browser and returns the rendered HTML. Defaults to a Playwright/Chromium implementation, lazily imported. */
  renderPage?: (url: string, timeoutMs: number) => Promise<string>;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
  minRequestIntervalMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  userAgent?: string;
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function looksLikeEmptyShell(html: string): boolean {
  return stripTags(html).length < EMPTY_SHELL_TEXT_THRESHOLD;
}

async function defaultRenderPage(url: string, timeoutMs: number): Promise<string> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ userAgent: USER_AGENT });
    // "load" rather than "networkidle" — many real SPAs keep a WebSocket or
    // polling connection open indefinitely, which would make "networkidle"
    // time out even once the page has fully rendered.
    await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
    return await page.content();
  } finally {
    await browser.close();
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches article HTML respecting robots.txt and a per-domain rate limit,
 * falling back to a Playwright render when a plain fetch looks like an empty
 * client-rendered shell. Robots.txt results and per-domain last-request
 * timestamps are cached on the instance — construct one `CrawlerService` per
 * process (see the `crawlerService` singleton below) so those caches persist
 * for the process lifetime as intended, rather than resetting per call.
 */
export class CrawlerService {
  private readonly fetchImpl: typeof fetch;
  private readonly renderPage: (url: string, timeoutMs: number) => Promise<string>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly minRequestIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly userAgent: string;
  private readonly robotsCache = new Map<string, Robot | null>();
  private readonly lastRequestAt = new Map<string, number>();

  constructor(config: CrawlerServiceConfig = {}) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.renderPage = config.renderPage ?? defaultRenderPage;
    this.sleep = config.sleepImpl ?? defaultSleep;
    this.now = config.now ?? Date.now;
    this.minRequestIntervalMs = config.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBackoffMs = config.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.userAgent = config.userAgent ?? USER_AGENT;
  }

  async crawlArticle(url: string): Promise<CrawlResult> {
    const result = await this.fetchPage(url);
    if ("error" in result) {
      return { status: "FAILED", crawlError: result.error };
    }
    return { status: "CRAWLED", rawHtml: result.html };
  }

  /**
   * Low-level page fetch shared by every crawl target — articles (via
   * `crawlArticle`) and, as of Day 6, contact/author-profile pages: robots.txt
   * check, per-domain rate limiting, retry-on-5xx, and a Playwright fallback
   * when the plain fetch looks like an empty JS shell. Any new fetch against
   * an outlet domain should go through this rather than a bare `fetch`, so it
   * gets the same politeness treatment as article crawling.
   */
  async fetchPage(url: string): Promise<FetchPageResult> {
    const domain = hostnameOf(url);
    if (!domain) {
      return { error: "invalid_url" };
    }

    const robots = await this.getRobots(domain);
    if (robots?.isAllowed(url, this.userAgent) === false) {
      return { error: "robots_disallowed" };
    }

    const fetchResult = await this.fetchHtml(url, domain);
    if ("crawlError" in fetchResult) {
      return { error: fetchResult.crawlError };
    }

    let html = fetchResult.html;

    if (looksLikeEmptyShell(html)) {
      try {
        await this.waitForRateLimit(domain);
        html = await this.renderPage(url, this.timeoutMs);
        this.markRequest(domain);
      } catch {
        return { error: "render_failed" };
      }
    }

    return { html };
  }

  private async getRobots(domain: string): Promise<Robot | null> {
    const cached = this.robotsCache.get(domain);
    if (cached !== undefined) {
      return cached;
    }

    const robotsUrl = `https://${domain}/robots.txt`;
    let robots: Robot | null = null;

    // Same AbortController+timeoutMs pattern as the page fetch below — a
    // robots.txt endpoint that hangs rather than actively refusing (no
    // response, no RST) would otherwise stall with no bound at all, since
    // fetch() itself has no default timeout. Found live: this made a Day 7
    // Stop request's "roughly one article" cancellation bound balloon to
    // 100+ seconds for one slow domain.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      await this.waitForRateLimit(domain);
      const response = await this.fetchImpl(robotsUrl, {
        signal: controller.signal,
        headers: { "User-Agent": this.userAgent },
      });
      this.markRequest(domain);
      if (response.ok) {
        robots = robotsParser(robotsUrl, await response.text());
      }
      // Non-OK (e.g. 404) means no robots.txt was published — fail open
      // (treat as allowed), matching standard crawler convention.
    } catch {
      // Network failure (including our own abort on timeout) fetching
      // robots.txt — fail open rather than blocking every crawl on that
      // domain for the rest of the process.
    } finally {
      clearTimeout(timeout);
    }

    this.robotsCache.set(domain, robots);
    return robots;
  }

  private async fetchHtml(
    url: string,
    domain: string,
  ): Promise<{ html: string } | { crawlError: string }> {
    let lastError = "fetch_error";

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.waitForRateLimit(domain);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.fetchImpl(url, {
          signal: controller.signal,
          headers: { "User-Agent": this.userAgent },
        });
        this.markRequest(domain);

        if (response.ok) {
          return { html: await response.text() };
        }

        if (response.status >= 500) {
          lastError = `http_${response.status}`;
        } else {
          // 4xx — not transient, don't retry.
          return { crawlError: `http_${response.status}` };
        }
      } catch (error) {
        this.markRequest(domain);
        lastError =
          error instanceof Error && error.name === "AbortError" ? "timeout" : "fetch_error";
      } finally {
        clearTimeout(timeout);
      }

      if (attempt < this.maxRetries) {
        await this.sleep(this.retryBackoffMs * (attempt + 1));
      }
    }

    return { crawlError: lastError };
  }

  private async waitForRateLimit(domain: string): Promise<void> {
    const last = this.lastRequestAt.get(domain);
    if (last === undefined) return;

    const wait = this.minRequestIntervalMs - (this.now() - last);
    if (wait > 0) {
      await this.sleep(wait);
    }
  }

  private markRequest(domain: string): void {
    this.lastRequestAt.set(domain, this.now());
  }
}

// One instance per process so the robots.txt cache and per-domain
// rate-limit tracking persist for the process lifetime as intended, rather
// than resetting on every crawl request.
export const crawlerService = new CrawlerService();
