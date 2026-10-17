import type { AskEvent, AskRequest, AskedBefore, BoardState, FlowsState, CloudVoiceProvider, LocalModel, Settings, VoiceClip, VoiceOption, VoiceProvider, VoiceStatus, FeaturesState, Job, SourceSlice, Workspace } from "@docent/contracts";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // The server refuses state changes without this header, which other sites can't send.
  const res = await fetch(path, { ...init, headers: { ...init?.headers, "x-docent": "1" } });
  const body = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? res.statusText);
  return body as T;
}
const q = encodeURIComponent;

/** Posts a question and calls back with each server-sent event until the answer (or an error) arrives. */
async function ask(req: AskRequest, onEvent: (e: AskEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch("/api/ask", { method: "POST", headers: { "content-type": "application/json", "x-docent": "1" }, body: JSON.stringify(req), signal });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? res.statusText);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (data) onEvent(JSON.parse(data) as AskEvent);
    }
  }
}

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const api = {
  ask,
  askHistory: (boardId: string) => request<AskedBefore[]>(`/api/ask/history?board=${q(boardId)}`),
  workspace: () => request<Workspace>("/api/workspace"),
  openRepo: (path: string) => request<Workspace>("/api/workspace/open", json({ path })),
  findDropped: (name: string, children: string[]) => request<{ paths: string[] }>("/api/workspace/find", json({ name, children })),
  pickFolder: () => request<{ path: string | null }>("/api/workspace/pick", { method: "POST" }),
  source: (path: string, from?: number, to?: number) =>
    request<SourceSlice>(`/api/source?path=${q(path)}${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}`),
  features: () => request<FeaturesState>("/api/features"),
  writeEpisode: (id: string) => request<Job>(`/api/episodes/${q(id)}/write`, { method: "POST" }),
  flows: () => request<FlowsState>("/api/flows"),
  proposeFlows: () => request<Job>("/api/flows/propose", { method: "POST" }),
  writeOverview: () => request<Job>("/api/overview/write", { method: "POST" }),
  board: (id: string) => request<BoardState>(`/api/boards/${q(id)}`),
  writeBoard: (id: string) => request<Job>(`/api/boards/${q(id)}/write`, { method: "POST" }),
  stopBoard: (id: string) => request<Job | null>(`/api/boards/${q(id)}/stop`, { method: "POST" }),
  boardVoice: (id: string, at: number, beat: number) => request<VoiceClip>(`/api/boards/${q(id)}/voice`, json({ at, beat })),
  settings: () => request<Settings>("/api/settings"),
  setKey: (provider: CloudVoiceProvider | "anthropic", key: string | null) => request<Settings>("/api/settings/keys", { ...json({ provider, key }), method: "PUT" }),
  setVoice: (patch: { provider?: VoiceProvider; voice?: string; speed?: number; expressive?: boolean; pronunciations?: Record<string, string> }) => request<Settings>("/api/settings/voice", { ...json(patch), method: "PUT" }),
  setClaude: (mode: "claude-code" | "api") => request<Settings>("/api/settings/claude", { ...json({ mode }), method: "PUT" }),
  voices: (provider: VoiceProvider, q: string) => request<VoiceOption[]>(`/api/settings/voices?provider=${provider}&q=${q ? encodeURIComponent(q) : ""}`),
  previewVoice: (provider: VoiceProvider, voice: string) => request<VoiceClip>("/api/settings/voices/preview", json({ provider, voice })),
  voice: () => request<VoiceStatus>("/api/voice"),
  model: () => request<LocalModel>("/api/settings/models/kokoro"),
  downloadModel: () => request<LocalModel>("/api/settings/models/kokoro", { method: "POST" }),
  removeModel: () => request<Settings>("/api/settings/models/kokoro", { method: "DELETE" }),
  cancelJob: () => request<Job | null>("/api/features/cancel", { method: "POST" }),
  prepare: () => request<Job>("/api/features/prepare", { method: "POST" }),
  discover: () => request<Job>("/api/features/discover", { method: "POST" }),
  verify: (id?: string) => request<Job>("/api/features/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(id ? { id } : {}) }),
};
