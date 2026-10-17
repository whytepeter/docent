import {
  ArrowLeft, ArrowUp, Box, Check, ChevronRight, CircleAlert, Cloud, Download, Laptop, FileCode, Folder, FolderDown, FolderOpen, LayoutGrid, Lock, Maximize, MessageCircle, Minus, Network, PanelLeft, PanelRight, Pause, Play, Plus, RotateCw, Search, Settings, SkipBack, SkipForward, Sparkles, Square, SquareFunction, Volume2, VolumeX, X, Sun, Moon, Monitor,
  type LucideIcon,
} from "lucide-react";

/** Lucide line icons. One place to map names to the icon set. */
const ICONS = {
  search: Search,
  warn: CircleAlert,
  inspector: PanelRight,
  sidebar: PanelLeft,
  close: X,
  refresh: RotateCw,
  chevron: ChevronRight,
  area: LayoutGrid,
  file: FileCode,
  fn: SquareFunction,
  component: Box,
  system: Network,
  folder: FolderOpen,
  ask: MessageCircle,
  play: Play,
  pause: Pause,
  stop: Square,
  prev: SkipBack,
  next: SkipForward,
  send: ArrowUp,
  sound: Volume2,
  muted: VolumeX,
  settings: Settings,
  check: Check,
  lock: Lock,
  claude: Sparkles,
  plus: Plus,
  minus: Minus,
  fit: Maximize,
  back: ArrowLeft,
  sun: Sun,
  moon: Moon,
  screen: Monitor,
  project: Folder,
  drop: FolderDown,
  download: Download,
  cloud: Cloud,
  local: Laptop,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

const STROKE = { light: 1.5, regular: 1.9, bold: 2.4 } as const;

export function Icon({ name, size = 17, weight = "regular", fill = false }: { name: IconName; size?: number; weight?: keyof typeof STROKE; fill?: boolean }) {
  const C = ICONS[name];
  return <C size={size} strokeWidth={STROKE[weight]} fill={fill ? "currentColor" : "none"} aria-hidden="true" />;
}
