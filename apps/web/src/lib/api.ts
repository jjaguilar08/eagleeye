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
    headers: { "Content-Type": "application/json", ...init?.headers },
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
