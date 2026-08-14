"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { ArticleDTO, PipelineRunDTO, PipelineRunStatus, SettingDTO } from "@eagleeye/types";
import { createPipelineRun, getSettings, listPipelineRuns, updateSettings } from "@/lib/api";

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

function ArticleList({ articles }: { articles: ArticleDTO[] }) {
  if (articles.length === 0) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">No articles discovered.</p>;
  }

  return (
    <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
      {articles.map((article) => (
        <li key={article.id} className="py-2">
          <a
            href={article.url}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-blue-700 hover:underline dark:text-blue-400"
          >
            {article.title}
          </a>
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            {article.sourceName ?? article.sourceDomain}
            {article.publishedAt &&
              ` · ${new Date(article.publishedAt).toLocaleDateString()}`} · {article.status}
          </div>
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
      const run = await createPipelineRun({ topic, maxArticles });
      setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)]);
      setSelectedRunId(run.id);
      if (run.error) {
        setSubmitError(run.error);
      }
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Failed to start run.");
    } finally {
      setSubmitting(false);
    }
  }

  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null;
  const maxAllowed = settings?.maxArticlesPerRun ?? 1;

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
              {submitting ? "Running…" : "Start run"}
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
            <StatusBadge status={selectedRun.status} />
          </div>
          {selectedRun.error && (
            <p className="mb-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
              {selectedRun.error}
            </p>
          )}
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
