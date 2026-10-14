import type { Confidence } from "@docent/contracts";

const TITLE: Record<Confidence, string> = {
  confirmed: "Confirmed · resolved by the compiler",
  inferred: "Inferred · reasoned, not proven",
  unknown: "Unknown",
};

/** The small colored dot behind every link. Its words appear on hover, not on the screen. */
export function EvidenceDot({ confidence, via }: { confidence: Confidence; via?: string }) {
  return <span className={`dot ${confidence}`} title={via ? `${TITLE[confidence]} — ${via}` : TITLE[confidence]} aria-label={TITLE[confidence]} role="img" />;
}
