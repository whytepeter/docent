/**
 * How far you got in each tour, kept in this browser: the step you were on, and whether you reached the end.
 * It belongs to one drawing of a board, so a board drawn again starts from the top.
 */
export interface Progress {
  generatedAt: string;
  step: number;
  steps: number;
  done: boolean;
}

const key = (repo: string, flowId: string) => `docent:progress:${repo}:${flowId}`;

export function loadProgress(repo: string, flowId: string): Progress | null {
  try {
    const raw = localStorage.getItem(key(repo, flowId));
    return raw ? (JSON.parse(raw) as Progress) : null;
  } catch {
    return null;
  }
}

export function saveProgress(repo: string, flowId: string, p: Progress): void {
  try {
    localStorage.setItem(key(repo, flowId), JSON.stringify(p));
  } catch {
    /* storage off: progress just isn't remembered */
  }
}
