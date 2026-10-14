import type { AnalysisHealth, AskEvent, AskRequest, AreaView, Feature, FeatureDetail, FeaturesState, FileView, Health, Job, Overview, SearchHit, SourceSlice, Status, SymbolView, TreeNode, Workspace, PartOf } from "@docent/contracts";

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
  workspace: () => request<Workspace>("/api/workspace"),
  openRepo: (path: string) => request<Workspace>("/api/workspace/open", json({ path })),
  pickFolder: () => request<{ path: string | null }>("/api/workspace/pick", { method: "POST" }),
  overview: () => request<Overview>("/api/overview"),
  tree: () => request<TreeNode[]>("/api/tree"),
  health: () => request<Health>("/api/health"),
  analysisHealth: () => request<AnalysisHealth>("/api/features/health"),
  status: () => request<Status>("/api/status"),
  search: (text: string) => request<SearchHit[]>(`/api/search?q=${q(text)}`),
  area: (id: string) => request<AreaView>(`/api/area?id=${q(id)}`),
  file: (path: string) => request<FileView>(`/api/file?path=${q(path)}`),
  symbol: (id: string) => request<SymbolView>(`/api/symbol?id=${q(id)}`),
  source: (path: string, from?: number, to?: number) =>
    request<SourceSlice>(`/api/source?path=${q(path)}${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}`),
  reextract: () => request<Status>("/api/reextract", { method: "POST" }),
  features: () => request<FeaturesState>("/api/features"),
  feature: (id: string) => request<FeatureDetail>(`/api/features/${q(id)}`),
  partOf: (file: string, symbol?: string) => request<PartOf>(`/api/part-of?file=${q(file)}${symbol ? `&symbol=${q(symbol)}` : ""}`),
  cancelJob: () => request<Job | null>("/api/features/cancel", { method: "POST" }),
  discover: () => request<Job>("/api/features/discover", { method: "POST" }),
  verify: (id?: string) => request<Job>("/api/features/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(id ? { id } : {}) }),
  saveFeatures: (features: Feature[], approve = false) =>
    request("/api/features", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ features, approve }) }),
};
