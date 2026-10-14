export type Tone = "default" | "focus" | "muted" | "warn" | "ghost";
export type Hue = "app" | "features" | "components" | "shared" | "other";

export type DiagramRow = {
  id: string;
  label: string;
  sub?: string;
  onClick?: () => void;
};

export type DiagramNode = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
  kicker?: string;
  tone?: Tone;
  /** Which layer of the codebase the box belongs to; shown as a small color tag. */
  hue?: Hue;
  mono?: boolean;
  /** What the box is; drawn as a small tinted chip in the layer color. */
  icon?: "area" | "file" | "fn" | "component" | "folder";
  /** Short facts shown as compact items with icons instead of one long, truncated line. */
  meta?: { icon: "file" | "fn" | "test" | "used" | "lines"; value: string | number; label: string }[];
  rows?: DiagramRow[];
  /** Let the title wrap to two lines (for sentences, like flow steps). */
  wrapTitle?: boolean;
  onClick?: () => void;
};

export type DiagramEdge = {
  id: string;
  from: string;
  to: string;
  tone?: "default" | "inferred";
  width?: number;
  /** Connect bottom → top instead of right → left (storyboards that read downward). */
  vertical?: boolean;
  /** Short text on the link, e.g. the line where the call happens. */
  label?: string;
};

/** A tinted, labeled frame behind a group of boxes (like a FigJam section). */
export type DiagramSection = {
  id: string;
  label: string;
  hue?: Hue;
  count?: number;
  x: number;
  y: number;
  w: number;
  h: number;
};
