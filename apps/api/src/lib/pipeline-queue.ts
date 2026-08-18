import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { runPipeline } from "../services/pipeline-orchestrator.js";

const QUEUE_NAME = "pipeline-runs";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

export interface RunPipelineJobData {
  pipelineRunId: string;
}

// `lazyConnect` defers the actual TCP connection until the first command is
// issued (queue.add / worker start), rather than connecting synchronously at
// module load — this module is imported by server.ts on every startup, and
// CI has no Redis running, so importing it (for typecheck/lint/build) must
// never require Redis to be reachable. `maxRetriesPerRequest: null` is
// required by BullMQ's blocking Worker commands.
function createConnection(): Redis {
  const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  // Without a listener, a failed connection attempt emits an unhandled
  // 'error' event that crashes the process — log instead.
  connection.on("error", (error: Error) => {
    console.error(`[pipeline-queue] Redis connection error: ${error.message}`);
  });
  return connection;
}

const connection = createConnection();

export const pipelineQueue = new Queue<RunPipelineJobData>(QUEUE_NAME, { connection });

let worker: Worker<RunPipelineJobData> | null = null;

/**
 * Starts the in-process BullMQ Worker. Called once from server.ts at actual
 * server startup (not at module import time, and never during
 * typecheck/lint/test/build) — runs in the same apps/api process as the
 * Fastify server rather than a separate deployable worker process, per the
 * brief's "no unnecessary complexity for a project that's never deployed
 * live" reasoning.
 */
export function startPipelineWorker(): Worker<RunPipelineJobData> {
  if (worker) return worker;

  worker = new Worker<RunPipelineJobData>(
    QUEUE_NAME,
    async (job: Job<RunPipelineJobData>) => {
      await runPipeline(job.data.pipelineRunId);
    },
    { connection },
  );

  worker.on("failed", (job, error) => {
    console.error(`[pipeline-queue] job ${job?.id ?? "?"} failed:`, error);
  });
  // Same reasoning as the raw connection's 'error' listener above — an
  // unreachable Redis (e.g. Docker not running yet) would otherwise crash
  // the whole API process via an unhandled 'error' event.
  worker.on("error", (error: Error) => {
    console.error(`[pipeline-queue] worker error: ${error.message}`);
  });

  return worker;
}

export function enqueuePipelineRun(pipelineRunId: string): Promise<Job<RunPipelineJobData>> {
  return pipelineQueue.add("run-pipeline", { pipelineRunId });
}
