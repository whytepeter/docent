import type { Board } from "@docent/contracts";
import { openCode } from "../code/index.ts";
import { LABEL } from "./engine.ts";

type Claim = Board["cards"][number]["why"];

const SHORT: Record<string, string> = { confirmed: "confirmed", inferred: "inferred", unknown: "unknown", record: "record" };

/**
 * One sentence Docent says, in plain React (the board draws its own): the text, its label, and chips for
 * the lines it rests on. A chip opens those lines.
 */
export function Said({ claim, checking = false, className = "", typed }: { claim: Claim; checking?: boolean; className?: string; typed?: number }) {
  // While an answer types in, only what's typed shows, and its label and lines wait until the sentence is done.
  const typing = typed !== undefined && typed < claim.text.length;
  const waiting = checking && (claim.label === "confirmed" || claim.label === "record") && !claim.review && !claim.claimedLabel;
  const title = waiting
    ? "Being double-checked against the code"
    : claim.review?.verdict === "upheld" ? `${LABEL[claim.label]}: ${claim.review.reason}` : LABEL[claim.label] ?? "";
  return (
    <div className={`bd-said ${className}`}>
      <p>{typing ? <>{claim.text.slice(0, typed)}<span className="bd-caret" aria-hidden="true" /></> : claim.text}</p>
      {!typing && <div className="bd-said-meta">
        <span className="bd-said-lab" title={title}>
          <span className={`bd-dot ${waiting ? "checking" : claim.label}`} aria-hidden="true" />
          {waiting ? "checking" : SHORT[claim.label] ?? claim.label}
        </span>
        {claim.evidence.slice(0, 3).map((e, i) => (
          <button
            key={i}
            className={`bd-chip${e.check.ok ? "" : " bad"}`}
            title={e.check.ok ? `Open ${e.file}:${e.start}–${e.end}` : e.check.reason ?? ""}
            onClick={() => openCode(e.file, e.start, e.end)}
          >
            {e.file.split("/").pop()}:{e.start}
          </button>
        ))}
      </div>}
      {!typing && claim.checkNote && <em className="bd-taken">Docent first said “{claim.claimedLabel}”; {claim.checkNote}.</em>}
    </div>
  );
}
