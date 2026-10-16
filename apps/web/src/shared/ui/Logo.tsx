import { Presentation } from "lucide-react";

/** Docent's mark: Lucide's Presentation, a board being shown, white on the indigo tile. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <span className="logo" style={{ width: size, height: size, borderRadius: size * 0.28, background: "var(--logo-bg, #5B5BD6)", display: "inline-grid", placeItems: "center", color: "#fff", flex: "none" }} aria-hidden="true">
      <Presentation size={size * 0.62} strokeWidth={2.2} />
    </span>
  );
}
