// NewsAPI.org's free "Developer" plan allows up to 100 results per page and
// tells us the true result count via `totalResults` — there's no fixed
// overall ceiling like some providers impose, just the per-page cap.
const NEWSAPI_MAX_PAGE_SIZE = 100;
const NEWSAPI_ENDPOINT = "https://newsapi.org/v2/everything";

export interface ArticleCandidate {
  title: string;
  url: string;
  sourceDomain: string;
  sourceName: string | null;
  publishedAt: string | null;
}

export class SearchServiceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SearchServiceError";
  }
}

interface NewsApiArticle {
  source: { id: string | null; name: string | null } | null;
  title: string;
  url: string;
  publishedAt: string | null;
}

interface NewsApiSuccessResponse {
  status: "ok";
  totalResults: number;
  articles: NewsApiArticle[];
}

interface NewsApiErrorResponse {
  status: "error";
  code: string;
  message: string;
}

type NewsApiResponse = NewsApiSuccessResponse | NewsApiErrorResponse;

function isErrorResponse(body: NewsApiResponse): body is NewsApiErrorResponse {
  return body.status === "error";
}

function sourceDomainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

export interface SearchServiceConfig {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export class SearchService {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: SearchServiceConfig) {
    this.apiKey = config.apiKey;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** Returns up to `count` article candidates for `topic`, paginating as needed. */
  async searchArticles(topic: string, count: number): Promise<ArticleCandidate[]> {
    const targetCount = Math.max(0, count);
    const results: ArticleCandidate[] = [];
    let page = 1;
    let totalResults: number | undefined;

    while (results.length < targetCount) {
      if (totalResults !== undefined && results.length >= totalResults) {
        break;
      }

      const pageSize = Math.min(NEWSAPI_MAX_PAGE_SIZE, targetCount - results.length);
      const data = await this.fetchPage(topic, page, pageSize);
      totalResults = data.totalResults;

      for (const article of data.articles) {
        results.push({
          title: article.title,
          url: article.url,
          sourceDomain: sourceDomainOf(article.url),
          sourceName: article.source?.name ?? null,
          publishedAt: article.publishedAt ?? null,
        });
        if (results.length >= targetCount) break;
      }

      if (data.articles.length < pageSize) {
        // Fewer results than requested means NewsAPI has nothing more for this query.
        break;
      }

      page += 1;
    }

    return results;
  }

  private async fetchPage(
    query: string,
    page: number,
    pageSize: number,
  ): Promise<NewsApiSuccessResponse> {
    const url = new URL(NEWSAPI_ENDPOINT);
    url.searchParams.set("q", query);
    url.searchParams.set("sortBy", "publishedAt");
    url.searchParams.set("language", "en");
    url.searchParams.set("pageSize", String(pageSize));
    url.searchParams.set("page", String(page));

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        headers: { "X-Api-Key": this.apiKey },
      });
    } catch (cause) {
      throw new SearchServiceError("Failed to reach NewsAPI.org.", { cause });
    }

    let body: NewsApiResponse;
    try {
      body = (await response.json()) as NewsApiResponse;
    } catch (cause) {
      throw new SearchServiceError("NewsAPI.org returned an unparseable response.", { cause });
    }

    if (!response.ok || isErrorResponse(body)) {
      const code = isErrorResponse(body) ? body.code : undefined;

      if (response.status === 429 || code === "rateLimited" || code === "apiKeyExhausted") {
        throw new SearchServiceError(
          "NewsAPI.org quota exceeded for today (free Developer plan caps at 100 requests/day). Try again tomorrow.",
        );
      }

      if (
        response.status === 401 ||
        code === "apiKeyInvalid" ||
        code === "apiKeyMissing" ||
        code === "apiKeyDisabled"
      ) {
        throw new SearchServiceError("NewsAPI.org rejected the API key. Check NEWSAPI_KEY.");
      }

      if (response.status === 426) {
        throw new SearchServiceError(
          "NewsAPI.org's free Developer plan only allows requests from a development environment.",
        );
      }

      throw new SearchServiceError(
        isErrorResponse(body) ? body.message : `NewsAPI.org error (HTTP ${response.status}).`,
      );
    }

    return body;
  }
}
