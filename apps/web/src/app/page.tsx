"use client";

import { useEffect, useState, type FormEvent } from "react";
import type {
  ArticleDTO,
  ArticleStatus,
  ContactAttemptDTO,
  ContactAttemptStatus,
  DraftEmailBatchItemDTO,
  DraftEmailsResponse,
  EmailThreadDTO,
  EmailThreadStatus,
  PipelineRunDTO,
  PipelineRunStatus,
  PipelineStage,
  SettingDTO,
  WhitelistEntryDTO,
} from "@eagleeye/types";
import {
  addWhitelistEntry,
  approveEmailThread,
  crawlPipelineRun,
  createPipelineRun,
  discoverContacts,
  draftEmails,
  extractAuthors,
  getPipelineRun,
  getSettings,
  listPipelineRuns,
  listWhitelist,
  rejectEmailThread,
  removeWhitelistEntry,
  sendEmailThread,
  stopPipelineRun,
  updateEmailDraft,
  updateSettings,
} from "@/lib/api";

// Mirrors apps/api's src/services/email-draft.ts pricing constants — kept as
// an independent display-only copy (same convention as bestContactAttempt
// below), not shared through @eagleeye/types. Point-in-time Claude Haiku 4.5
// pricing, confirmed 2026-08-19 — re-verify before trusting for real billing.
const HAIKU_INPUT_PRICE_PER_MILLION_USD = 1.0;
const HAIKU_OUTPUT_PRICE_PER_MILLION_USD = 5.0;
// Rough per-draft assumption for the pre-flight estimate shown before a
// batch runs — real per-thread figures from the actual API response replace
// this once drafting completes.
const AVERAGE_INPUT_TOKENS_PER_DRAFT = 300;
const AVERAGE_OUTPUT_TOKENS_PER_DRAFT = 250;

function estimateCostUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * HAIKU_INPUT_PRICE_PER_MILLION_USD +
    (outputTokens / 1_000_000) * HAIKU_OUTPUT_PRICE_PER_MILLION_USD
  );
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

// Replaces one EmailThread wherever it appears nested under runs/articles —
// approve/reject/edit all act on a single thread but the dashboard's state
// tree is rooted at the runs list.
function replaceEmailThread(runs: PipelineRunDTO[], updated: EmailThreadDTO): PipelineRunDTO[] {
  return runs.map((run) => ({
    ...run,
    articles: run.articles.map((article) =>
      article.id === updated.articleId
        ? {
            ...article,
            emailThreads: article.emailThreads.map((thread) =>
              thread.id === updated.id ? updated : thread,
            ),
          }
        : article,
    ),
  }));
}

// Mirrors the API's rolling-24h daily-cap window (email-threads.ts's
// DAILY_SEND_WINDOW_MS) — a display-side estimate only, the server is the
// real enforcement point regardless of what this computes.
const DAILY_SEND_WINDOW_MS = 24 * 60 * 60 * 1000;

// Counts real sends (OUTBOUND messages with a non-null sentAt) across
// whichever runs `scope` selects, no later than `sinceMs` in the past. The
// dashboard already has every run's full nested articles/emailThreads/
// messages in `runs` state (same shape GET /pipeline-runs/:id returns), so
// this needs no new API surface for either the per-run or daily count.
function countSentMessages(
  runs: PipelineRunDTO[],
  scope: (run: PipelineRunDTO) => boolean,
  sinceMs: number,
): number {
  let count = 0;
  for (const run of runs) {
    if (!scope(run)) continue;
    for (const article of run.articles) {
      for (const thread of article.emailThreads) {
        for (const message of thread.messages) {
          if (
            message.direction === "OUTBOUND" &&
            message.sentAt &&
            new Date(message.sentAt).getTime() >= sinceMs
          ) {
            count += 1;
          }
        }
      }
    }
  }
  return count;
}

function computeSendBlockReason(params: {
  automationEnabled: boolean;
  whitelisted: boolean;
  sentInRun: number;
  maxSendsPerRun: number;
  sentToday: number;
  dailySendCap: number;
}): string | null {
  if (!params.automationEnabled) return "Automation is off — turn it on above to send.";
  if (!params.whitelisted) return "Recipient is not on the whitelist.";
  if (params.sentInRun >= params.maxSendsPerRun) {
    return `This run has reached its send limit (${params.maxSendsPerRun}).`;
  }
  if (params.sentToday >= params.dailySendCap) {
    return `Daily send cap reached (${params.dailySendCap}).`;
  }
  return null;
}

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

const EMAIL_THREAD_STATUS_STYLES: Record<EmailThreadStatus, string> = {
  DRAFT: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  PENDING_APPROVAL: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  SENT: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  REPLIED: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  CLOSED: "bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-500",
};

function EmailThreadStatusBadge({ status }: { status: EmailThreadStatus }) {
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs font-medium ${EMAIL_THREAD_STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}

function EmailThreadCard({
  thread,
  articleTitle,
  contactMethod,
  batchResult,
  onApprove,
  onReject,
  onSave,
  onSend,
  onRefresh,
  pending,
  refreshing,
  error,
  sendBlockReason,
}: {
  thread: EmailThreadDTO;
  articleTitle: string;
  contactMethod: string | null;
  batchResult: DraftEmailBatchItemDTO | undefined;
  onApprove: () => void;
  onReject: () => void;
  onSave: (subject: string, body: string) => void;
  onSend: () => void;
  onRefresh: () => void;
  pending: boolean;
  refreshing: boolean;
  error: string | undefined;
  sendBlockReason: string | null;
}) {
  const [editing, setEditing] = useState(false);
  // Edit/approve/send always act on the one OUTBOUND draft, regardless of
  // how many INBOUND replies have landed since — those are rendered below,
  // read-only.
  const message = thread.messages.find((m) => m.direction === "OUTBOUND");
  const [subject, setSubject] = useState(thread.subject);
  const [body, setBody] = useState(message?.body ?? "");

  useEffect(() => {
    if (!editing) {
      setSubject(thread.subject);
      setBody(message?.body ?? "");
    }
  }, [thread, editing, message?.body]);

  const approved = message?.approvedByUser ?? false;

  return (
    <li className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          <div className="font-medium text-zinc-700 dark:text-zinc-300">{articleTitle}</div>
          <div>
            To: {thread.recipientEmail}
            {contactMethod && ` (via ${contactMethod})`}
          </div>
          {message?.sentAt && <div>Sent: {new Date(message.sentAt).toLocaleString()}</div>}
        </div>
        <EmailThreadStatusBadge status={thread.status} />
      </div>

      {editing ? (
        <div className="flex flex-col gap-2">
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={7}
            className="rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                onSave(subject, body);
                setEditing(false);
              }}
              disabled={pending || subject.trim() === "" || body.trim() === ""}
              className="rounded bg-black px-3 py-1 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={pending}
              className="rounded border border-zinc-300 px-3 py-1 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium text-black dark:text-zinc-100">{thread.subject}</div>
          <ul className="flex flex-col gap-2">
            {thread.messages.map((m) => (
              <li
                key={m.id}
                className={`rounded border px-3 py-2 text-sm ${
                  m.direction === "OUTBOUND"
                    ? "ml-6 border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950"
                    : "mr-6 border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950"
                }`}
              >
                <div className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  {m.direction === "OUTBOUND" ? "You" : "Reply"} ·{" "}
                  {new Date(m.createdAt).toLocaleString()}
                </div>
                <div className="whitespace-pre-wrap text-zinc-700 dark:text-zinc-300">{m.body}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!editing && (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={onApprove}
            disabled={pending || approved || thread.status === "CLOSED"}
            className="rounded border border-green-300 px-3 py-1 text-sm font-medium text-green-700 hover:bg-green-50 disabled:opacity-50 dark:border-green-800 dark:text-green-300 dark:hover:bg-green-950"
          >
            {approved ? "Approved" : "Approve"}
          </button>
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={pending || thread.status === "CLOSED"}
            className="rounded border border-zinc-300 px-3 py-1 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={onReject}
            disabled={pending || thread.status === "CLOSED"}
            className="rounded border border-red-300 px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
          >
            Reject
          </button>
          {/* Manual only — replies can take real-world minutes to days, so
              continuously polling every thread doesn't make sense the way it
              does for the Day 7 pipeline-run view. */}
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="rounded border border-zinc-300 px-3 py-1 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      )}

      {!editing && thread.status === "PENDING_APPROVAL" && (
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={onSend}
            disabled={pending || Boolean(sendBlockReason)}
            className="rounded bg-black px-3 py-1 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
          >
            {pending ? "Sending…" : "Send"}
          </button>
          {sendBlockReason && (
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{sendBlockReason}</span>
          )}
        </div>
      )}

      <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
        {batchResult
          ? `${batchResult.inputTokens} in / ${batchResult.outputTokens} out tokens · ${formatUsd(batchResult.costUsd)}`
          : "Token/cost figures only shown right after the batch that drafted this thread."}
      </div>

      {error && <p className="mt-2 text-xs text-red-700 dark:text-red-400">{error}</p>}
    </li>
  );
}

function WhitelistSection({
  entries,
  onAdd,
  onRemove,
  adding,
  addError,
  removingId,
}: {
  entries: WhitelistEntryDTO[];
  onAdd: (email: string, label: string) => void;
  onRemove: (id: string) => void;
  adding: boolean;
  addError: string | null;
  removingId: string | null;
}) {
  const [email, setEmail] = useState("");
  const [label, setLabel] = useState("");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    onAdd(email, label);
    setEmail("");
    setLabel("");
  }

  return (
    <section className="rounded border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Whitelist</h2>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        Only these addresses can ever receive a real send — enforced server-side, in the send
        function itself. Add your own test address here after this ships; never commit a real one.
      </p>

      <form onSubmit={handleSubmit} className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">Label (optional)</span>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <button
          type="submit"
          disabled={adding}
          className="rounded bg-black px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
        >
          {adding ? "Adding…" : "Add"}
        </button>
      </form>
      {addError && <p className="mt-2 text-sm text-red-700 dark:text-red-400">{addError}</p>}

      <ul className="mt-3 divide-y divide-zinc-200 dark:divide-zinc-800">
        {entries.length === 0 && (
          <p className="py-2 text-sm text-zinc-500 dark:text-zinc-400">
            No whitelisted addresses yet.
          </p>
        )}
        {entries.map((entry) => (
          <li key={entry.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span className="text-zinc-700 dark:text-zinc-300">
              {entry.email}
              {entry.label && (
                <span className="text-zinc-500 dark:text-zinc-400"> — {entry.label}</span>
              )}
            </span>
            <button
              type="button"
              onClick={() => onRemove(entry.id)}
              disabled={removingId === entry.id}
              className="rounded border border-red-300 px-2 py-0.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </section>
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
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [lastDraftBatch, setLastDraftBatch] = useState<DraftEmailsResponse | null>(null);
  const [pendingThreadId, setPendingThreadId] = useState<string | null>(null);
  const [refreshingThreadId, setRefreshingThreadId] = useState<string | null>(null);
  const [threadErrors, setThreadErrors] = useState<Record<string, string>>({});
  const [whitelist, setWhitelist] = useState<WhitelistEntryDTO[]>([]);
  const [whitelistAdding, setWhitelistAdding] = useState(false);
  const [whitelistAddError, setWhitelistAddError] = useState<string | null>(null);
  const [whitelistRemovingId, setWhitelistRemovingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [settingsResult, runsResult, whitelistResult] = await Promise.all([
          getSettings(),
          listPipelineRuns(),
          listWhitelist(),
        ]);
        if (cancelled) return;
        setSettings(settingsResult);
        setRuns(runsResult);
        setWhitelist(whitelistResult);
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

  async function handleDraftEmails() {
    if (!selectedRun || !settings?.automationEnabled) return;

    setDrafting(true);
    setDraftError(null);
    try {
      const response = await draftEmails(selectedRun.id);
      setRuns((prev) => prev.map((run) => (run.id === response.run.id ? response.run : run)));
      setLastDraftBatch(response);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "Failed to draft emails.");
    } finally {
      setDrafting(false);
    }
  }

  async function handleApproveThread(threadId: string) {
    setPendingThreadId(threadId);
    setThreadErrors((prev) => ({ ...prev, [threadId]: "" }));
    try {
      const updated = await approveEmailThread(threadId);
      setRuns((prev) => replaceEmailThread(prev, updated));
    } catch (error) {
      setThreadErrors((prev) => ({
        ...prev,
        [threadId]: error instanceof Error ? error.message : "Failed to approve draft.",
      }));
    } finally {
      setPendingThreadId(null);
    }
  }

  async function handleRejectThread(threadId: string) {
    setPendingThreadId(threadId);
    setThreadErrors((prev) => ({ ...prev, [threadId]: "" }));
    try {
      const updated = await rejectEmailThread(threadId);
      setRuns((prev) => replaceEmailThread(prev, updated));
    } catch (error) {
      setThreadErrors((prev) => ({
        ...prev,
        [threadId]: error instanceof Error ? error.message : "Failed to reject draft.",
      }));
    } finally {
      setPendingThreadId(null);
    }
  }

  async function handleSaveDraft(threadId: string, subject: string, body: string) {
    setPendingThreadId(threadId);
    setThreadErrors((prev) => ({ ...prev, [threadId]: "" }));
    try {
      const updated = await updateEmailDraft(threadId, { subject, body });
      setRuns((prev) => replaceEmailThread(prev, updated));
    } catch (error) {
      setThreadErrors((prev) => ({
        ...prev,
        [threadId]: error instanceof Error ? error.message : "Failed to save draft.",
      }));
    } finally {
      setPendingThreadId(null);
    }
  }

  async function handleSendThread(threadId: string) {
    setPendingThreadId(threadId);
    setThreadErrors((prev) => ({ ...prev, [threadId]: "" }));
    try {
      // This is the one action that actually delivers a real email — the
      // server re-checks every gate (approval, whitelist, both send caps)
      // regardless of what the disabled button state already implied.
      const updated = await sendEmailThread(threadId);
      setRuns((prev) => replaceEmailThread(prev, updated));
    } catch (error) {
      setThreadErrors((prev) => ({
        ...prev,
        [threadId]: error instanceof Error ? error.message : "Failed to send email.",
      }));
    } finally {
      setPendingThreadId(null);
    }
  }

  async function handleRefreshThread(threadId: string) {
    if (!selectedRun) return;

    setRefreshingThreadId(threadId);
    setThreadErrors((prev) => ({ ...prev, [threadId]: "" }));
    try {
      const updated = await getPipelineRun(selectedRun.id);
      setRuns((prev) => prev.map((run) => (run.id === updated.id ? updated : run)));
    } catch (error) {
      setThreadErrors((prev) => ({
        ...prev,
        [threadId]: error instanceof Error ? error.message : "Failed to refresh.",
      }));
    } finally {
      setRefreshingThreadId(null);
    }
  }

  async function handleAddWhitelistEntry(email: string, label: string) {
    setWhitelistAdding(true);
    setWhitelistAddError(null);
    try {
      const trimmedLabel = label.trim();
      const entry = await addWhitelistEntry({
        email,
        ...(trimmedLabel && { label: trimmedLabel }),
      });
      setWhitelist((prev) => [...prev, entry]);
    } catch (error) {
      setWhitelistAddError(
        error instanceof Error ? error.message : "Failed to add whitelist entry.",
      );
    } finally {
      setWhitelistAdding(false);
    }
  }

  async function handleRemoveWhitelistEntry(id: string) {
    setWhitelistRemovingId(id);
    try {
      await removeWhitelistEntry(id);
      setWhitelist((prev) => prev.filter((entry) => entry.id !== id));
    } catch (error) {
      setWhitelistAddError(
        error instanceof Error ? error.message : "Failed to remove whitelist entry.",
      );
    } finally {
      setWhitelistRemovingId(null);
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
  const draftEligibleCount =
    selectedRun?.articles.filter((article) => {
      if (!article.author || article.emailThreads.length > 0) return false;
      const best = bestContactAttempt(article.author.contactAttempts);
      return Boolean(best?.emailCandidate);
    }).length ?? 0;
  const maxDraftsAllowed = settings?.maxDraftsPerRun ?? 0;
  const preflightEstimateUsd = estimateCostUsd(
    maxDraftsAllowed * AVERAGE_INPUT_TOKENS_PER_DRAFT,
    maxDraftsAllowed * AVERAGE_OUTPUT_TOKENS_PER_DRAFT,
  );
  const draftBatchForRun =
    lastDraftBatch && selectedRun && lastDraftBatch.run.id === selectedRun.id
      ? lastDraftBatch
      : null;
  const emailThreadsForRun =
    selectedRun?.articles.flatMap((article) =>
      article.emailThreads.map((thread) => ({ article, thread })),
    ) ?? [];
  const sentInSelectedRun = selectedRun
    ? countSentMessages(runs, (run) => run.id === selectedRun.id, 0)
    : 0;
  const sentToday = countSentMessages(runs, () => true, Date.now() - DAILY_SEND_WINDOW_MS);
  const whitelistedEmails = new Set(whitelist.map((entry) => entry.email.toLowerCase()));
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

      <WhitelistSection
        entries={whitelist}
        onAdd={handleAddWhitelistEntry}
        onRemove={handleRemoveWhitelistEntry}
        adding={whitelistAdding}
        addError={whitelistAddError}
        removingId={whitelistRemovingId}
      />

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

          <div className="mb-3 rounded border border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center justify-between gap-3 p-3">
              <div>
                <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Draft Emails
                </h3>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  Calls the Anthropic API — real cost per call, reviewable before anything sends.
                  Pre-flight estimate: up to {maxDraftsAllowed} draft
                  {maxDraftsAllowed === 1 ? "" : "s"} × ~
                  {AVERAGE_INPUT_TOKENS_PER_DRAFT + AVERAGE_OUTPUT_TOKENS_PER_DRAFT} avg tokens ≈{" "}
                  {formatUsd(preflightEstimateUsd)}.
                </p>
              </div>
              <button
                type="button"
                onClick={handleDraftEmails}
                disabled={
                  !settings?.automationEnabled ||
                  draftEligibleCount === 0 ||
                  drafting ||
                  runInFlight
                }
                className="shrink-0 rounded bg-black px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
              >
                {drafting ? "Drafting…" : "Draft Emails"}
              </button>
            </div>
            <div className="px-3 pb-3">
              {manualControlsBlockedReason ? (
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {manualControlsBlockedReason}
                </span>
              ) : !settings?.automationEnabled ? (
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  Automation is off — turn it on above to draft emails.
                </span>
              ) : (
                draftEligibleCount === 0 && (
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    No extracted articles with a usable contact are waiting on a draft.
                  </span>
                )
              )}
              {draftError && (
                <p className="mt-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                  {draftError}
                </p>
              )}

              {draftBatchForRun && (
                <div className="mt-3 flex flex-col gap-2">
                  <p className="rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm font-medium text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
                    Last batch: {draftBatchForRun.totalInputTokens} in /{" "}
                    {draftBatchForRun.totalOutputTokens} out tokens ·{" "}
                    {formatUsd(draftBatchForRun.totalCostUsd)}
                  </p>
                  {draftBatchForRun.results
                    .filter(
                      (result): result is DraftEmailBatchItemDTO & { outcome: "failed" } =>
                        result.outcome === "failed",
                    )
                    .map((result) => {
                      const article = selectedRun.articles.find((a) => a.id === result.articleId);
                      return (
                        <p
                          key={result.articleId}
                          className="text-xs text-amber-700 dark:text-amber-400"
                        >
                          {article?.title ?? result.articleId}:{" "}
                          {result.reason ?? "Drafting failed."}
                        </p>
                      );
                    })}
                </div>
              )}

              {emailThreadsForRun.length > 0 && (
                <ul className="mt-3 flex flex-col gap-3">
                  {emailThreadsForRun.map(({ article, thread }) => {
                    const contactMethod =
                      article.author?.contactAttempts.find(
                        (attempt) => attempt.id === thread.contactAttemptId,
                      )?.method ?? null;
                    const batchResult = draftBatchForRun?.results.find(
                      (result) => result.threadId === thread.id,
                    );
                    const sendBlockReason = computeSendBlockReason({
                      automationEnabled: settings?.automationEnabled ?? false,
                      whitelisted: whitelistedEmails.has(thread.recipientEmail.toLowerCase()),
                      sentInRun: sentInSelectedRun,
                      maxSendsPerRun: settings?.maxSendsPerRun ?? 0,
                      sentToday,
                      dailySendCap: settings?.dailySendCap ?? 0,
                    });
                    return (
                      <EmailThreadCard
                        key={thread.id}
                        thread={thread}
                        articleTitle={article.title}
                        contactMethod={contactMethod}
                        batchResult={batchResult}
                        onApprove={() => handleApproveThread(thread.id)}
                        onReject={() => handleRejectThread(thread.id)}
                        onSave={(subject, body) => handleSaveDraft(thread.id, subject, body)}
                        onSend={() => handleSendThread(thread.id)}
                        onRefresh={() => handleRefreshThread(thread.id)}
                        pending={pendingThreadId === thread.id}
                        refreshing={refreshingThreadId === thread.id}
                        error={threadErrors[thread.id] || undefined}
                        sendBlockReason={sendBlockReason}
                      />
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

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
