import { describe, expect, it, vi } from "vitest";
import { SearchService, SearchServiceError } from "./search.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function newsApiArticle(n: number, sourceName = "Example News") {
  return {
    source: { id: null, name: sourceName },
    title: `Article ${n}`,
    url: `https://example.test/articles/${n}`,
    publishedAt: `2026-08-1${n % 10}T00:00:00Z`,
  };
}

describe("SearchService.searchArticles", () => {
  it("maps a single page of results to article candidates", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        status: "ok",
        totalResults: 2,
        articles: [newsApiArticle(1), newsApiArticle(2)],
      }),
    );
    const service = new SearchService({ apiKey: "key", fetchImpl });

    const results = await service.searchArticles("hunting gear", 2);

    expect(results).toEqual([
      {
        title: "Article 1",
        url: "https://example.test/articles/1",
        sourceDomain: "example.test",
        sourceName: "Example News",
        publishedAt: "2026-08-11T00:00:00Z",
      },
      {
        title: "Article 2",
        url: "https://example.test/articles/2",
        sourceDomain: "example.test",
        sourceName: "Example News",
        publishedAt: "2026-08-12T00:00:00Z",
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [requestedUrl, requestInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(requestedUrl);
    expect(parsed.searchParams.get("q")).toBe("hunting gear");
    expect(parsed.searchParams.get("sortBy")).toBe("publishedAt");
    expect(parsed.searchParams.get("language")).toBe("en");
    expect(parsed.searchParams.get("pageSize")).toBe("2");
    expect(parsed.searchParams.get("page")).toBe("1");
    expect((requestInit.headers as Record<string, string>)["X-Api-Key"]).toBe("key");
  });

  it("returns an empty array without calling fetch when count is 0", async () => {
    const fetchImpl = vi.fn();
    const service = new SearchService({ apiKey: "key", fetchImpl });

    const results = await service.searchArticles("hunting gear", 0);

    expect(results).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("paginates using the page param when more than one page is needed", async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => newsApiArticle(i + 1));
    const secondPage = Array.from({ length: 20 }, (_, i) => newsApiArticle(i + 101));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { status: "ok", totalResults: 500, articles: firstPage }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { status: "ok", totalResults: 500, articles: secondPage }),
      );
    const service = new SearchService({ apiKey: "key", fetchImpl });

    const results = await service.searchArticles("hunting gear", 120);

    expect(results).toHaveLength(120);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstUrl = new URL((fetchImpl.mock.calls[0] as [string, RequestInit])[0]);
    const secondUrl = new URL((fetchImpl.mock.calls[1] as [string, RequestInit])[0]);
    expect(firstUrl.searchParams.get("page")).toBe("1");
    expect(firstUrl.searchParams.get("pageSize")).toBe("100");
    expect(secondUrl.searchParams.get("page")).toBe("2");
    expect(secondUrl.searchParams.get("pageSize")).toBe("20");
  });

  it("stops once totalResults is reached even if fewer than requested", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { status: "ok", totalResults: 1, articles: [newsApiArticle(1)] }),
      );
    const service = new SearchService({ apiKey: "key", fetchImpl });

    const results = await service.searchArticles("very niche topic", 25);

    expect(results).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stops paginating once NewsAPI returns fewer results than requested", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { status: "ok", totalResults: 500, articles: [newsApiArticle(1)] }),
      );
    const service = new SearchService({ apiKey: "key", fetchImpl });

    const results = await service.searchArticles("very niche topic", 25);

    expect(results).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("defaults sourceName to null and derives sourceDomain when source name is missing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        status: "ok",
        totalResults: 1,
        articles: [
          {
            source: { id: null, name: null },
            title: "No source",
            url: "https://example.test/a",
            publishedAt: null,
          },
        ],
      }),
    );
    const service = new SearchService({ apiKey: "key", fetchImpl });

    const results = await service.searchArticles("topic", 1);

    expect(results).toEqual([
      {
        title: "No source",
        url: "https://example.test/a",
        sourceDomain: "example.test",
        sourceName: null,
        publishedAt: null,
      },
    ]);
  });

  it("throws a clear quota-exceeded error on HTTP 429", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () =>
        jsonResponse(429, {
          status: "error",
          code: "rateLimited",
          message: "You have made too many requests",
        }),
      );
    const service = new SearchService({ apiKey: "key", fetchImpl });

    await expect(service.searchArticles("hunting gear", 5)).rejects.toThrow(SearchServiceError);
    await expect(service.searchArticles("hunting gear", 5)).rejects.toThrow(/quota/i);
  });

  it("throws a clear quota-exceeded error on apiKeyExhausted even without HTTP 429", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { status: "error", code: "apiKeyExhausted", message: "exhausted" }),
      );
    const service = new SearchService({ apiKey: "key", fetchImpl });

    await expect(service.searchArticles("hunting gear", 5)).rejects.toThrow(/quota/i);
  });

  it("throws a clear key error on HTTP 401", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(401, {
          status: "error",
          code: "apiKeyInvalid",
          message: "Your API key is invalid",
        }),
      );
    const service = new SearchService({ apiKey: "bad-key", fetchImpl });

    await expect(service.searchArticles("hunting gear", 5)).rejects.toThrow(/api key/i);
  });

  it("throws a clear error on HTTP 426 (dev-environment-only restriction)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(426, { status: "error", code: "corsNotAllowed", message: "upgrade required" }),
      );
    const service = new SearchService({ apiKey: "key", fetchImpl });

    await expect(service.searchArticles("hunting gear", 5)).rejects.toThrow(
      /development environment/i,
    );
  });

  it("throws a SearchServiceError with the API message for other errors", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(400, {
          status: "error",
          code: "parametersMissing",
          message: "Required parameters are missing",
        }),
      );
    const service = new SearchService({ apiKey: "key", fetchImpl });

    await expect(service.searchArticles("hunting gear", 5)).rejects.toThrow(
      "Required parameters are missing",
    );
  });

  it("wraps network failures in a SearchServiceError", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const service = new SearchService({ apiKey: "key", fetchImpl });

    await expect(service.searchArticles("hunting gear", 5)).rejects.toThrow(SearchServiceError);
  });
});
