import {
  ArrowClockwise, CaretRight, ChatCircleDots, FolderOpen, Play, Stop, ArrowUp, SidebarSimple as SidebarLeft, Cube, FileCode, Function as FnIcon, MagnifyingGlass, SidebarSimple, SquaresFour, TreeStructure, WarningCircle, X,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";

/** Light, precise line icons. One place to map names to the icon set. */
const ICONS = {
  search: MagnifyingGlass,
  warn: WarningCircle,
  inspector: SidebarSimple,
  sidebar: SidebarLeft,
  close: X,
  refresh: ArrowClockwise,
  chevron: CaretRight,
  area: SquaresFour,
  file: FileCode,
  fn: FnIcon,
  component: Cube,
  system: TreeStructure,
  folder: FolderOpen,
  ask: ChatCircleDots,
  play: Play,
  stop: Stop,
  send: ArrowUp,
} satisfies Record<string, PhosphorIcon>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 17, weight = "regular" }: { name: IconName; size?: number; weight?: "light" | "regular" | "bold" }) {
  const C = ICONS[name];
  return <C size={size} weight={weight} aria-hidden="true" />;
}
