"use client";

import { useEffect, useState, type FormEvent } from "react";
import type {
  ArticleDTO,
  ArticleStatus,
  ContactAttemptDTO,
  ContactAttemptStatus,
  PipelineRunDTO,
  PipelineRunStatus,
  PipelineStage,
  SettingDTO,
} from "@eagleeye/types";
import {
  crawlPipelineRun,
  createPipelineRun,
  discoverContacts,
  extractAuthors,
  getPipelineRun,
  getSettings,
  listPipelineRuns,
  stopPipelineRun,
  updateSettings,
} from "@/lib/api";

// A run is "in flight" — the Worker either hasn't picked it up yet (PENDING)
// or is actively working through stages (RUNNING). Both the live-polling
// effect and the Stop button key off this, not just RUNNING alone, so a
// run doesn't sit unpolled/unstoppable during the brief PENDING window
// before the Worker starts it.
function isRunInFlight(status: PipelineRunStatus): boolean {
  return status === "PENDING" || status === "RUNNING";
}

const POLL_INTERVAL_MS = 2000;

// Priority order for which ContactAttempt "wins" as an author's headline
// outcome — not most-recent, since a later attempt in the waterfall (e.g.
// OUTLET_FALLBACK) can run after an earlier one already succeeded.
const CONTACT_STATUS_PRIORITY: ContactAttemptDTO["status"][] = [
  "FOUND",
  "OUTLET_FALLBACK",
  "NEEDS_REVIEW",
  "FAILED",
];

function bestContactAttempt(attempts: ContactAttemptDTO[]): ContactAttemptDTO | null {
  for (const status of CONTACT_STATUS_PRIORITY) {
    const match = attempts.find((attempt) => attempt.status === status);
    if (match) return match;
  }
  return null;
}

const RUN_STATUS_STYLES: Record<PipelineRunStatus, string> = {
  PENDING: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  RUNNING: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  COMPLETED: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  FAILED: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  STOPPED: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
};

function StatusBadge({ status }: { status: PipelineRunStatus }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${RUN_STATUS_STYLES[status]}`}>
      {status}
    </span>
  );
}

const STAGE_LABELS: Record<PipelineStage, string> = {
  SEARCHING: "Searching for articles",
  CRAWLING: "Crawling articles",
  EXTRACTING: "Extracting authors",
  DISCOVERING_CONTACTS: "Discovering contacts",
};

function StageBadge({ stage }: { stage: PipelineStage }) {
  return (
    <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900 dark:text-blue-200">
      {STAGE_LABELS[stage]}…
    </span>
  );
}

const ARTICLE_STATUS_STYLES: Record<ArticleDTO["status"], string> = {
  DISCOVERED: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  CRAWLED: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  EXTRACTED: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  FAILED: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
};

function ArticleStatusBadge({ status }: { status: ArticleDTO["status"] }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${ARTICLE_STATUS_STYLES[status]}`}>
      {status}
    </span>
  );
}

const ARTICLE_STATUS_ORDER: ArticleStatus[] = ["DISCOVERED", "CRAWLED", "EXTRACTED", "FAILED"];
const CONTACT_STATUS_ORDER: ContactAttemptStatus[] = [
  "FOUND",
  "OUTLET_FALLBACK",
  "NEEDS_REVIEW",
  "FAILED",
];

function countBy<T extends string>(values: T[]): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function ProgressBreakdown({ articles }: { articles: ArticleDTO[] }) {
  const articleCounts = countBy(articles.map((article) => article.status));
  const contactCounts = countBy(
    articles.flatMap((article) => {
      const best = article.author ? bestContactAttempt(article.author.contactAttempts) : null;
      return best ? [best.status] : [];
    }),
  );
  const hasContactCounts = Object.keys(contactCounts).length > 0;

  return (
    <div className="mb-3 flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {ARTICLE_STATUS_ORDER.map(
          (status) =>
            articleCounts[status] !== undefined && (
              <span key={status}>
                {status}: {articleCounts[status]}
              </span>
            ),
        )}
      </div>
      {hasContactCounts && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {CONTACT_STATUS_ORDER.map(
            (status) =>
              contactCounts[status] !== undefined && (
                <span key={status}>
                  Contact {status}: {contactCounts[status]}
                </span>
              ),
          )}
        </div>
      )}
    </div>
  );
}

function ContactOutcome({ attempts }: { attempts: ContactAttemptDTO[] }) {
  const best = bestContactAttempt(attempts);
  if (!best) return null;

  if (best.status === "FAILED") {
    return (
      <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">
        Contact: needs manual review — no email found across {attempts.length} attempt
        {attempts.length === 1 ? "" : "s"}.
      </div>
    );
  }

  return (
    <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
      Contact: {best.emailCandidate} ({best.method}, {best.status}, confidence{" "}
      {best.confidence.toFixed(2)})
    </div>
  );
}

function ArticleList({ articles }: { articles: ArticleDTO[] }) {
  if (articles.length === 0) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">No articles discovered.</p>;
  }

  return (
    <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
      {articles.map((article) => (
        <li key={article.id} className="py-2">
          <div className="flex items-start justify-between gap-3">
            <a
              href={article.url}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-blue-700 hover:underline dark:text-blue-400"
            >
              {article.title}
            </a>
            <ArticleStatusBadge status={article.status} />
          </div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            {article.sourceName ?? article.sourceDomain}
            {article.publishedAt && ` · ${new Date(article.publishedAt).toLocaleDateString()}`}
          </div>
          {article.status === "FAILED" && article.crawlError && (
            <div className="mt-1 text-xs text-red-700 dark:text-red-400">
              Crawl failed: {article.crawlError}
            </div>
          )}
          {article.author && (
            <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
              {article.author.extractionMethod === "NONE" ? (
                "No author found"
              ) : (
                <>
                  Author: {article.author.name} ({article.author.extractionMethod}, confidence{" "}
                  {article.author.confidence.toFixed(2)})
                </>
              )}
            </div>
          )}
          {article.author && article.author.contactAttempts.length > 0 && (
            <ContactOutcome attempts={article.author.contactAttempts} />
          )}
        </li>
      ))}
    </ul>
  );
}

export default function Home() {
  const [settings, setSettings] = useState<SettingDTO | null>(null);
  const [runs, setRuns] = useState<PipelineRunDTO[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [topic, setTopic] = useState("");
  const [maxArticles, setMaxArticles] = useState(10);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [togglePending, setTogglePending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [crawling, setCrawling] = useState(false);
  const [crawlError, setCrawlError] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [settingsResult, runsResult] = await Promise.all([getSettings(), listPipelineRuns()]);
        if (cancelled) return;
        setSettings(settingsResult);
        setRuns(runsResult);
        setTopic(settingsResult.searchTopic);
        setMaxArticles(settingsResult.maxArticlesPerRun);
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "Failed to load dashboard data.");
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null;

  // Polls the selected run's own GET endpoint while it's in flight (PENDING
  // or RUNNING) so the dashboard reflects the Worker's progress through
  // SEARCHING/CRAWLING/EXTRACTING/DISCOVERING_CONTACTS live, stopping as
  // soon as the run reaches a terminal status.
  useEffect(() => {
    const runId = selectedRun?.id;
    const status = selectedRun?.status;
    if (!runId || !status || !isRunInFlight(status)) return;

    let cancelled = false;
    const interval = setInterval(() => {
      void (async () => {
        try {
          const updated = await getPipelineRun(runId);
          if (!cancelled) {
            setRuns((prev) => prev.map((run) => (run.id === updated.id ? updated : run)));
          }
        } catch {
          // Transient poll failure — the next tick will just try again.
        }
      })();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedRun?.id, selectedRun?.status]);

  async function handleToggleAutomation() {
    if (!settings) return;
    setTogglePending(true);
    setLoadError(null);
    try {
      const updated = await updateSettings({ automationEnabled: !settings.automationEnabled });
      setSettings(updated);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Failed to update automation setting.");
    } finally {
      setTogglePending(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!settings?.automationEnabled) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      // Returns immediately once the run is created and queued — it starts
      // out PENDING with no articles yet; the live-polling effect above
      // picks up progress as soon as the Worker starts processing it.
      const run = await createPipelineRun({ topic, maxArticles });
      setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)]);
      setSelectedRunId(run.id);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Failed to start run.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStop() {
    if (!selectedRun) return;

    setStopping(true);
    setStopError(null);
    try {
      const updated = await stopPipelineRun(selectedRun.id);
      setRuns((prev) => prev.map((run) => (run.id === updated.id ? updated : run)));
    } catch (error) {
      setStopError(error instanceof Error ? error.message : "Failed to stop run.");
    } finally {
      setStopping(false);
    }
  }

  async function handleCrawl() {
    if (!selectedRun || !settings?.automationEnabled) return;

    setCrawling(true);
    setCrawlError(null);
    try {
      const updated = await crawlPipelineRun(selectedRun.id);
      setRuns((prev) => prev.map((run) => (run.id === updated.id ? updated : run)));
    } catch (error) {
      setCrawlError(error instanceof Error ? error.message : "Failed to crawl articles.");
    } finally {
      setCrawling(false);
    }
  }

  async function handleExtractAuthors() {
    if (!selectedRun) return;

    setExtracting(true);
    setExtractError(null);
    try {
      const updated = await extractAuthors(selectedRun.id);
      setRuns((prev) => prev.map((run) => (run.id === updated.id ? updated : run)));
    } catch (error) {
      setExtractError(error instanceof Error ? error.message : "Failed to extract authors.");
    } finally {
      setExtracting(false);
    }
  }

  async function handleDiscoverContacts() {
    if (!selectedRun || !settings?.automationEnabled) return;

    setDiscovering(true);
    setDiscoverError(null);
    try {
      const updated = await discoverContacts(selectedRun.id);
      setRuns((prev) => prev.map((run) => (run.id === updated.id ? updated : run)));
    } catch (error) {
      setDiscoverError(error instanceof Error ? error.message : "Failed to discover contacts.");
    } finally {
      setDiscovering(false);
    }
  }

  const maxAllowed = settings?.maxArticlesPerRun ?? 1;
  const runInFlight = selectedRun ? isRunInFlight(selectedRun.status) : false;
  const discoveredCount =
    selectedRun?.articles.filter((article) => article.status === "DISCOVERED").length ?? 0;
  const crawledCount =
    selectedRun?.articles.filter((article) => article.status === "CRAWLED").length ?? 0;
  const eligibleForContactCount =
    selectedRun?.articles.filter(
      (article) => article.author && article.author.contactAttempts.length === 0,
    ).length ?? 0;
  // Manual per-stage controls are for re-running a single stage on an
  // existing run — while the automated Worker is actively on the same run,
  // triggering one manually would just race it, so they're disabled with a
  // shared reason rather than left free to double-process.
  const manualControlsBlockedReason = runInFlight ? "Run is in progress." : null;

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 bg-zinc-50 px-6 py-10 dark:bg-black">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
          EagleEye
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Search &amp; discovery dashboard</p>
      </header>

      {loadError && (
        <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {loadError}
        </p>
      )}

      <section className="flex items-center justify-between rounded border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div>
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Automation</h2>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Runs spend real NewsAPI.org quota — off by default.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`rounded px-2 py-1 text-sm font-semibold ${
              settings?.automationEnabled
                ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                : "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            }`}
          >
            {settings ? (settings.automationEnabled ? "ON" : "OFF") : "…"}
          </span>
          <button
            type="button"
            onClick={handleToggleAutomation}
            disabled={!settings || togglePending}
            className="rounded border border-zinc-300 px-3 py-1 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            {settings?.automationEnabled ? "Turn off" : "Turn on"}
          </button>
        </div>
      </section>

      <section className="rounded border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">New run</h2>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">Topic</span>
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              required
              className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">
              Max articles (up to {maxAllowed})
            </span>
            <input
              type="number"
              min={1}
              max={maxAllowed}
              value={maxArticles}
              onChange={(e) =>
                setMaxArticles(Math.max(1, Math.min(maxAllowed, Number(e.target.value) || 1)))
              }
              className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>

          {submitError && <p className="text-sm text-red-700 dark:text-red-400">{submitError}</p>}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={!settings?.automationEnabled || submitting}
              className="rounded bg-black px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
            >
              {submitting ? "Starting…" : "Start run"}
            </button>
            {!settings?.automationEnabled && (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                Automation is off — turn it on above to start a run.
              </span>
            )}
          </div>
        </form>
      </section>

      {selectedRun && (
        <section className="rounded border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Run detail — {selectedRun.topic}
            </h2>
            <div className="flex items-center gap-2">
              {selectedRun.currentStage && <StageBadge stage={selectedRun.currentStage} />}
              <StatusBadge status={selectedRun.status} />
            </div>
          </div>

          {selectedRun.error && (
            <p className="mb-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
              {selectedRun.error}
            </p>
          )}

          {runInFlight && (
            <div className="mb-3 flex items-center gap-3">
              <button
                type="button"
                onClick={handleStop}
                disabled={stopping}
                className="rounded border border-red-300 px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
              >
                {stopping ? "Stopping…" : "Stop"}
              </button>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                Stopping halts at the next stage or article boundary — not instant.
              </span>
            </div>
          )}
          {stopError && (
            <p className="mb-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
              {stopError}
            </p>
          )}

          <ProgressBreakdown articles={selectedRun.articles} />

          <details className="mb-3 rounded border border-zinc-200 dark:border-zinc-800">
            <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Manual controls
            </summary>
            <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
              <div className="mb-3 flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleCrawl}
                  disabled={
                    !settings?.automationEnabled || discoveredCount === 0 || crawling || runInFlight
                  }
                  className="rounded border border-zinc-300 px-3 py-1 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
                >
                  {crawling ? "Crawling…" : "Crawl Articles"}
                </button>
                {manualControlsBlockedReason ? (
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    {manualControlsBlockedReason}
                  </span>
                ) : !settings?.automationEnabled ? (
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    Automation is off — turn it on above to crawl articles.
                  </span>
                ) : (
                  discoveredCount === 0 && (
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      No discovered articles left to crawl.
                    </span>
                  )
                )}
              </div>
              {crawlError && (
                <p className="mb-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                  {crawlError}
                </p>
              )}
              <div className="mb-3 flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleExtractAuthors}
                  disabled={crawledCount === 0 || extracting || runInFlight}
                  className="rounded border border-zinc-300 px-3 py-1 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
                >
                  {extracting ? "Extracting…" : "Extract Authors"}
                </button>
                {manualControlsBlockedReason ? (
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    {manualControlsBlockedReason}
                  </span>
                ) : (
                  crawledCount === 0 && (
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      No crawled articles left to extract authors from.
                    </span>
                  )
                )}
              </div>
              {extractError && (
                <p className="mb-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                  {extractError}
                </p>
              )}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleDiscoverContacts}
                  disabled={
                    !settings?.automationEnabled ||
                    eligibleForContactCount === 0 ||
                    discovering ||
                    runInFlight
                  }
                  className="rounded border border-zinc-300 px-3 py-1 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
                >
                  {discovering ? "Discovering…" : "Discover Contacts"}
                </button>
                {manualControlsBlockedReason ? (
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    {manualControlsBlockedReason}
                  </span>
                ) : !settings?.automationEnabled ? (
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    Automation is off — turn it on above to discover contacts.
                  </span>
                ) : (
                  eligibleForContactCount === 0 && (
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      No authors left needing contact discovery.
                    </span>
                  )
                )}
              </div>
              {discoverError && (
                <p className="mt-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                  {discoverError}
                </p>
              )}
            </div>
          </details>

          <ArticleList articles={selectedRun.articles} />
        </section>
      )}

      <section className="rounded border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">Past runs</h2>
        {runs.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No runs yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {runs.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => setSelectedRunId(run.id)}
                  className={`flex w-full items-center justify-between px-1 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900 ${
                    run.id === selectedRun?.id ? "bg-zinc-50 dark:bg-zinc-900" : ""
                  }`}
                >
                  <span>
                    <span className="font-medium text-black dark:text-zinc-100">{run.topic}</span>{" "}
                    <span className="text-zinc-500 dark:text-zinc-400">
                      · {run.articles.length} article{run.articles.length === 1 ? "" : "s"}
                    </span>
                  </span>
                  <StatusBadge status={run.status} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
