import type {
  CreatePipelineRunRequest,
  PipelineRunDTO,
  SettingDTO,
  UpdateSettingRequest,
} from "@eagleeye/types";

const API_URL = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:4000";

interface ApiErrorBody {
  error?: string;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    // Only set Content-Type when there's a body — Fastify's JSON body
    // parser rejects an empty body sent with 'application/json'
    // (FST_ERR_CTP_EMPTY_JSON_BODY), which bodyless POSTs like the crawl
    // endpoint would otherwise hit.
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });

  const body: unknown = await response.json();

  if (!response.ok) {
    const message =
      typeof (body as ApiErrorBody)?.error === "string"
        ? (body as ApiErrorBody).error!
        : `Request failed (HTTP ${response.status})`;
    throw new Error(message);
  }

  return body as T;
}

export function getSettings(): Promise<SettingDTO> {
  return apiFetch<SettingDTO>("/settings");
}

export function updateSettings(patch: UpdateSettingRequest): Promise<SettingDTO> {
  return apiFetch<SettingDTO>("/settings", { method: "PATCH", body: JSON.stringify(patch) });
}

export function listPipelineRuns(): Promise<PipelineRunDTO[]> {
  return apiFetch<PipelineRunDTO[]>("/pipeline-runs");
}

export function createPipelineRun(body: CreatePipelineRunRequest): Promise<PipelineRunDTO> {
  return apiFetch<PipelineRunDTO>("/pipeline-runs", { method: "POST", body: JSON.stringify(body) });
}

export function getPipelineRun(id: string): Promise<PipelineRunDTO> {
  return apiFetch<PipelineRunDTO>(`/pipeline-runs/${id}`);
}

export function stopPipelineRun(id: string): Promise<PipelineRunDTO> {
  return apiFetch<PipelineRunDTO>(`/pipeline-runs/${id}/stop`, { method: "POST" });
}

export function crawlPipelineRun(id: string): Promise<PipelineRunDTO> {
  return apiFetch<PipelineRunDTO>(`/pipeline-runs/${id}/crawl`, { method: "POST" });
}

export function extractAuthors(id: string): Promise<PipelineRunDTO> {
  return apiFetch<PipelineRunDTO>(`/pipeline-runs/${id}/extract-authors`, { method: "POST" });
}

export function discoverContacts(id: string): Promise<PipelineRunDTO> {
  return apiFetch<PipelineRunDTO>(`/pipeline-runs/${id}/discover-contacts`, { method: "POST" });
}
