import { Presentation } from "lucide-react";

/** Docent's mark: Lucide's Presentation, a board being shown, in the accent colour. */
export function Logo({ size = 22 }: { size?: number }) {
  return <Presentation className="logo" size={size} strokeWidth={2.2} color="var(--accent)" aria-hidden="true" />;
}
