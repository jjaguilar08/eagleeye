import { describe, expect, it, vi } from "vitest";
import { runPipeline, StageError, type PipelineOrchestratorDeps } from "./pipeline-orchestrator.js";

// Mirrors the production stage table's gating (SEARCHING/EXTRACTING
// ungated, CRAWLING/DISCOVERING_CONTACTS gated) but with mock stage runners
// — no prisma, no BullMQ/Redis, no real service calls anywhere in this file.
function makeDeps(overrides: Partial<PipelineOrchestratorDeps> = {}): {
  deps: PipelineOrchestratorDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const runningStatus = { current: "PENDING" as string };

  const deps: PipelineOrchestratorDeps = {
    stages: [
      { stage: "SEARCHING", gated: false, run: vi.fn(async () => void calls.push("SEARCHING")) },
      { stage: "CRAWLING", gated: true, run: vi.fn(async () => void calls.push("CRAWLING")) },
      { stage: "EXTRACTING", gated: false, run: vi.fn(async () => void calls.push("EXTRACTING")) },
      {
        stage: "DISCOVERING_CONTACTS",
        gated: true,
        run: vi.fn(async () => void calls.push("DISCOVERING_CONTACTS")),
      },
    ],
    isAutomationEnabled: vi.fn(async () => true),
    getRunStatus: vi.fn(async () => runningStatus.current as never),
    markRunning: vi.fn(async () => {
      calls.push("markRunning");
      runningStatus.current = "RUNNING";
    }),
    setStage: vi.fn(async (_runId, stage) => void calls.push(`setStage:${stage}`)),
    markCompleted: vi.fn(async () => void calls.push("markCompleted")),
    markFailed: vi.fn(async (_runId, reason) => void calls.push(`markFailed:${reason}`)),
    ...overrides,
  };

  return { deps, calls };
}

describe("runPipeline", () => {
  it("runs all four stages in order and completes", async () => {
    const { deps, calls } = makeDeps();

    await runPipeline("run-1", deps);

    expect(calls).toEqual([
      "markRunning",
      "setStage:SEARCHING",
      "SEARCHING",
      "setStage:CRAWLING",
      "CRAWLING",
      "setStage:EXTRACTING",
      "EXTRACTING",
      "setStage:DISCOVERING_CONTACTS",
      "DISCOVERING_CONTACTS",
      "markCompleted",
    ]);
    expect(deps.markFailed).not.toHaveBeenCalled();
  });

  it("does not start at all when the run was already STOPPED before the worker picked it up", async () => {
    const { deps, calls } = makeDeps({ getRunStatus: vi.fn(async () => "STOPPED" as never) });

    await runPipeline("run-1", deps);

    expect(calls).toEqual([]);
    expect(deps.markRunning).not.toHaveBeenCalled();
  });

  it("halts before CRAWLING and marks FAILED when automation was disabled mid-run", async () => {
    const { deps, calls } = makeDeps({ isAutomationEnabled: vi.fn(async () => false) });

    await runPipeline("run-1", deps);

    expect(calls).toEqual([
      "markRunning",
      "setStage:SEARCHING",
      "SEARCHING",
      "markFailed:Automation disabled mid-run.",
    ]);
    // CRAWLING's stage function itself is never invoked.
    expect(deps.stages[1]!.run).not.toHaveBeenCalled();
    expect(deps.markCompleted).not.toHaveBeenCalled();
  });

  it("runs ungated stages to completion even when automation is disabled the whole time", async () => {
    // Isolates the `gated` flag itself: with only SEARCHING and EXTRACTING
    // (both gated: false) and automation disabled throughout, both stages
    // should still run and the pipeline should still complete — proving
    // ungated stages truly ignore Setting.automationEnabled.
    const { deps, calls } = makeDeps({
      isAutomationEnabled: vi.fn(async () => false),
      stages: [
        { stage: "SEARCHING", gated: false, run: vi.fn(async () => void calls.push("SEARCHING")) },
        {
          stage: "EXTRACTING",
          gated: false,
          run: vi.fn(async () => void calls.push("EXTRACTING")),
        },
      ],
    });

    await runPipeline("run-1", deps);

    expect(calls).toEqual([
      "markRunning",
      "setStage:SEARCHING",
      "SEARCHING",
      "setStage:EXTRACTING",
      "EXTRACTING",
      "markCompleted",
    ]);
  });

  it("halts before DISCOVERING_CONTACTS when automation is disabled only after CRAWLING", async () => {
    let enabled = true;
    const { deps, calls } = makeDeps({
      isAutomationEnabled: vi.fn(async () => enabled),
    });
    // Flip automation off once CRAWLING has run, simulating it being turned
    // off mid-run rather than before the run ever started.
    const crawlRun = deps.stages[1]!.run;
    deps.stages[1]!.run = vi.fn(async () => {
      await (crawlRun as (runId: string) => Promise<void>)("run-1");
      enabled = false;
    });

    await runPipeline("run-1", deps);

    expect(calls).toEqual([
      "markRunning",
      "setStage:SEARCHING",
      "SEARCHING",
      "setStage:CRAWLING",
      "CRAWLING",
      "setStage:EXTRACTING",
      "EXTRACTING",
      "markFailed:Automation disabled mid-run.",
    ]);
    expect(deps.stages[3]!.run).not.toHaveBeenCalled();
  });

  it("marks FAILED with the stage's error message when a stage throws", async () => {
    const { deps, calls } = makeDeps();
    deps.stages[0]!.run = vi.fn(async () => {
      throw new StageError("Search is not configured: missing NEWSAPI_KEY.");
    });

    await runPipeline("run-1", deps);

    expect(calls).toEqual([
      "markRunning",
      "setStage:SEARCHING",
      "markFailed:Search is not configured: missing NEWSAPI_KEY.",
    ]);
    expect(deps.stages[1]!.run).not.toHaveBeenCalled();
  });

  it("halts cooperatively between stages once STOPPED is observed, without completing or failing", async () => {
    const statuses = ["PENDING", "RUNNING", "RUNNING", "STOPPED"];
    let call = 0;
    const { deps, calls } = makeDeps({
      getRunStatus: vi.fn(async () => statuses[Math.min(call++, statuses.length - 1)] as never),
    });

    await runPipeline("run-1", deps);

    // First getRunStatus (PENDING) lets the run start; second (RUNNING,
    // before SEARCHING) proceeds; third (RUNNING, before CRAWLING) proceeds;
    // fourth (STOPPED, before EXTRACTING) halts.
    expect(calls).toEqual([
      "markRunning",
      "setStage:SEARCHING",
      "SEARCHING",
      "setStage:CRAWLING",
      "CRAWLING",
      "setStage:null",
    ]);
    expect(deps.markCompleted).not.toHaveBeenCalled();
    expect(deps.markFailed).not.toHaveBeenCalled();
  });

  it("clears currentStage instead of completing when STOPPED is observed only after the last stage finishes", async () => {
    let stopAfterLastStage = false;
    const { deps, calls } = makeDeps({
      getRunStatus: vi.fn(async () => (stopAfterLastStage ? "STOPPED" : ("RUNNING" as never))),
    });
    const discoverRun = deps.stages[3]!.run;
    deps.stages[3]!.run = vi.fn(async () => {
      await (discoverRun as (runId: string) => Promise<void>)("run-1");
      stopAfterLastStage = true;
    });

    await runPipeline("run-1", deps);

    expect(calls[calls.length - 1]).toBe("setStage:null");
    expect(deps.markCompleted).not.toHaveBeenCalled();
  });
});
