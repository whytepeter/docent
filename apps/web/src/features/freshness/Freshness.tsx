import { useEffect, useState } from "react";
import type { Status } from "@docent/contracts";
import { api } from "../../shared/api/client.ts";
import { invalidateAll } from "../../shared/api/useQuery.ts";
import { Icon } from "../../shared/ui/index.ts";

const POLL_MS = 5000;

/** Says nothing while the map matches the code. When the code moves on, offers to re-read it. */
export function Freshness() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const tick = () => api.status().then((s) => live && setStatus(s)).catch(() => {});
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  if (!status?.stale && !busy) return null;
  const reread = async () => {
    setBusy(true);
    try {
      setStatus(await api.reextract());
      invalidateAll();
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="tbtn fresh" onClick={reread} disabled={busy} title={`Map shows ${status?.factsHead ?? "?"}; the repo is on ${status?.head ?? "?"} with changes`}>
      {busy ? <span className="spinner" /> : <Icon name="refresh" />}
      {busy ? "Reading…" : "Code changed · Re-read"}
    </button>
  );
}
