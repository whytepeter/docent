import type { AnalysisHealth, AreaView, Feature, FeatureDetail, FeaturesState, FileView, Health, Job, Overview, SearchHit, SourceSlice, Status, SymbolView, TreeNode, Workspace, PartOf } from "@docent/contracts";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // The server refuses state changes without this header, which other sites can't send.
  const res = await fetch(path, { ...init, headers: { ...init?.headers, "x-docent": "1" } });
  const body = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? res.statusText);
  return body as T;
}
const q = encodeURIComponent;

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const api = {
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
