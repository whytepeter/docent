import type { CommitRef } from "@docent/contracts";

/** History rows. The subject shows; the full message (often the "why") opens on click. */
export function Commits({ commits, limit = 12 }: { commits: CommitRef[]; limit?: number }) {
  return (
    <>
      {commits.slice(0, limit).map((c) => (
        <details key={c.sha} className="commit">
          <summary><span className="sha">{c.sha}</span><span>{c.subject} <span className="sub" style={{ color: "var(--ink-3)", fontSize: 11 }}>{c.date}</span></span></summary>
          {c.body && <div className="body-text">{c.body}</div>}
        </details>
      ))}
      {commits.length > limit && <div className="empty">and {commits.length - limit} older</div>}
    </>
  );
}
