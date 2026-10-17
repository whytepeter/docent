import type { Board, VoiceClip } from "@docent/contracts";

/*
 * The whiteboard engine. Plain DOM and one camera transform, so panning, zooming and every animation stay
 * fast. React draws the floating controls; this draws and moves everything on the board itself.
 */

type Claim = Board["cards"][number]["why"];
type Step = Board["steps"][number];
export type Beat = Step["beats"][number];
export type Mode = "tour" | "try" | "defend";
/** Where the learner pointed for a Defend question: the exact lines, the right card, or elsewhere. */
export type Pick = "line" | "card" | "miss";

/**
 * A tour guess: Docent asked (beat `beat` of step `step`) and waits. The answer is the choice the learner
 * picked, or where they pointed; ok is null when they skipped to the answer.
 */
export interface Quiz {
  step: number;
  beat: number;
  answer: { choice: number | null; ok: boolean | null } | null;
}

export interface Insets { t: number; b: number; l: number; r: number }

export interface EngineState {
  mode: Mode;
  step: number;
  steps: number;
  playing: boolean;
  /** The tour beat playing now (say, point, predict, reveal). */
  beat: { i: number; kind: Beat["kind"] } | null;
  quiz: Quiz | null;
  zoom: number;
  toggles: Record<string, boolean>;
  /** Defend it: the question on screen, whether its answer is showing, and where the learner pointed. */
  ask: { i: number; revealed: boolean; pick: Pick | null };
  picks: Record<number, Pick>;
  defended: Record<number, "yes" | "rev">;
}

export interface Saved {
  pos?: Record<string, { x: number; y: number }>;
  notes?: { id: string; x: number; y: number; text: string; color: string; r: number }[];
  defended?: Record<number, "yes" | "rev">;
}

export interface EngineOptions {
  caption: { title: HTMLElement; text: HTMLElement };
  onState: (s: EngineState) => void;
  /** How much of each edge the floating controls cover, for this mode. */
  insets: (mode: Mode) => Insets;
  rate: () => number;
  /** A voice clip for one beat of a tour step, or null to read without one. */
  voice: (at: number, beat: number) => Promise<VoiceClip | null>;
  /** Highlighted HTML for each line of an excerpt. */
  highlight: (lines: string[], file: string, start: number) => Promise<string[]>;
  openCode: (file: string, start?: number, end?: number) => void;
  saved: Saved;
  persist: (s: Saved) => void;
}

const W = 520;
const COL = 720;
const ROW = 560;
const LINE = 24;
/** Dot grid spacing in board units, and the closest dots may get on screen (px) before the grid thins. */
const GRID = 16;
const GRID_MIN = 10;
export const LABEL: Record<string, string> = {
  confirmed: "Confirmed · read in the code, citation checked, and a second reader couldn't refute it",
  inferred: "Inferred · a reasoned guess",
  unknown: "Unknown · can't be established from this repo",
  record: "Record · from commit history",
};

const rm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const ease = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const ease2 = (p: number) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

interface CardEl {
  data: Board["cards"][number];
  root: HTMLDivElement;
  head: HTMLDivElement;
  code: HTMLDivElement;
  stat: HTMLSpanElement;
  why: HTMLDivElement;
  say: HTMLDivElement;
  x: number;
  y: number;
  /** The excerpt as shown (a switch can change one line). */
  cur: string[];
  html: string[] | null;
  typed: boolean;
  changed: Set<number>;
}

export class BoardEngine {
  private world: HTMLDivElement;
  private svg: SVGSVGElement;
  private cam = { x: 0, y: 0, k: 0.5 };
  private cards = new Map<string, CardEl>();
  private edges = new Map<string, { path: SVGPathElement; label: SVGTextElement; from: string; to: string }>();
  private launcher: HTMLDivElement | null = null;
  private tok = 0;
  private flyId = 0;
  private paused = false;
  private audio: HTMLAudioElement | null = null;
  /** Voice clips by "step:beat", fetched one beat ahead so the teacher doesn't stall between sentences. */
  private clips = new Map<string, Promise<VoiceClip | null>>();
  private skip = false;
  /** The card whose code is typing right now; opening all code leaves it to finish. */
  private typingId: string | null = null;
  private s: EngineState;
  private frame1 = { x: 0, y: 0, w: 0, h: 0 };

  private cleanup: (() => void)[] = [];

  constructor(private stage: HTMLDivElement, private board: Board, private o: EngineOptions) {
    this.s = {
      mode: "tour", step: 0, steps: board.steps.length, playing: false, beat: null, quiz: null, zoom: 0.5,
      toggles: Object.fromEntries(board.tryIt.toggles.map((t) => [t.id, true])),
      ask: { i: 0, revealed: false, pick: null }, picks: {}, defended: { ...(o.saved.defended ?? {}) },
    };
    this.world = document.createElement("div");
    this.world.className = "bd-world";
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svg.classList.add("bd-edges");
    this.svg.innerHTML = '<defs><marker id="bd-ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M1 1L9 5L1 9" fill="none" stroke="context-stroke" stroke-width="2" stroke-linecap="round"/></marker></defs>';
    this.world.appendChild(this.svg);
    stage.appendChild(this.world);
    this.build();
    this.bindPointer();
    this.fit(0);
    void document.fonts?.ready.then(() => this.drawEdges());
    this.emit();
    void this.runStep(0, false);
  }

  /** New labels from the double-check behind the board: refresh the notes without restarting anything. */
  refresh(board: Board) {
    this.board = board;
    for (const c of board.cards) {
      const el = this.cards.get(c.id);
      if (!el) continue;
      el.data = { ...el.data, why: c.why, say: c.say };
      this.fillNote(el.why, c.why, false);
      this.fillNote(el.say, c.say, false);
    }
  }

  destroy() {
    this.tok++;
    this.flyId++;
    this.audio?.pause();
    for (const f of this.cleanup) f();
    this.world.remove();
  }

  // ---------------------------------------------------------------- state

  private emit() {
    this.o.onState({ ...this.s, zoom: this.cam.k });
  }
  private set(p: Partial<EngineState>) {
    Object.assign(this.s, p);
    this.emit();
  }
  private persist() {
    const pos: Saved["pos"] = {};
    for (const [id, c] of this.cards) pos[id] = { x: c.x, y: c.y };
    const notes = [...this.world.querySelectorAll<HTMLDivElement>(".bd-sticky.mine")].map((n) => ({
      id: n.dataset.id!, x: n.offsetLeft, y: n.offsetTop, text: n.querySelector(".bd-st-text")?.textContent ?? "", color: n.dataset.c ?? "", r: Number(n.dataset.r ?? 0),
    }));
    this.o.persist({ pos, notes, defended: this.s.defended });
  }

  /** Waits, but stands still while the learner has paused. */
  private async sleep(ms: number, tok: number) {
    const end = performance.now() + (rm() ? Math.min(ms, 30) : ms);
    while (performance.now() < end || this.paused) {
      if (tok !== this.tok) return;
      await new Promise((r) => setTimeout(r, Math.min(50, Math.max(5, end - performance.now()))));
    }
  }

  // ---------------------------------------------------------------- camera

  private apply() {
    const { x, y, k } = this.cam;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    this.grid(x, y, k);
    this.emit();
  }
  /**
   * The dot grid, as on FigJam: dots stay the same small size on screen, and as you zoom out the grid steps
   * to every 2nd, 4th… dot so it never turns into noise. The finer level fades as it gets dense, so stepping
   * between levels is a cross-fade, not a jump.
   */
  private grid(x: number, y: number, k: number) {
    let step = GRID;
    while (step * k < GRID_MIN) step *= 2;
    while (step > GRID && (step / 2) * k >= GRID_MIN) step /= 2;
    const coarse = step * 2 * k; // screen spacing of the level that always shows
    const fine = step * k; // the finer level, fading in as it opens up
    // The finer level is fully there until it gets close to the minimum, then fades out quickly.
    const fade = Math.min(1, Math.max(0, (fine - GRID_MIN) / (GRID_MIN * 0.5)));
    const st = this.stage.style;
    st.setProperty("--grid-fine", `${fine}px`);
    st.setProperty("--grid-coarse", `${coarse}px`);
    st.setProperty("--grid-fade", fade.toFixed(3));
    st.backgroundPosition = `${x}px ${y}px, ${x}px ${y}px`;
  }

  private fitRect(R: { x: number; y: number; w: number; h: number }) {
    const i = this.o.insets(this.s.mode);
    const vw = this.stage.clientWidth;
    const vh = this.stage.clientHeight;
    const aw = Math.max(200, vw - i.l - i.r);
    const ah = Math.max(200, vh - i.t - i.b);
    const k = Math.min(aw / R.w, ah / R.h, 1.15);
    return { k, x: i.l + aw / 2 - (R.x + R.w / 2) * k, y: i.t + ah / 2 - (R.y + R.h / 2) * k };
  }
  /** Glides the camera, zooming in log space and moving the world centre, so it feels like one camera. */
  private flyTo(T: { x: number; y: number; k: number }, ms: number): Promise<void> {
    const id = ++this.flyId;
    const a = { ...this.cam };
    if (rm() || !ms) {
      Object.assign(this.cam, T);
      this.apply();
      return Promise.resolve();
    }
    const vw = this.stage.clientWidth / 2;
    const vh = this.stage.clientHeight / 2;
    return new Promise((res) => {
      const t0 = performance.now();
      const f = (n: number) => {
        if (id !== this.flyId) return res();
        const p = ease(Math.min(1, (n - t0) / ms));
        const k = Math.exp(Math.log(a.k) + (Math.log(T.k) - Math.log(a.k)) * p);
        const cx0 = (vw - a.x) / a.k, cy0 = (vh - a.y) / a.k, cx1 = (vw - T.x) / T.k, cy1 = (vh - T.y) / T.k;
        this.cam.k = k;
        this.cam.x = vw - (cx0 + (cx1 - cx0) * p) * k;
        this.cam.y = vh - (cy0 + (cy1 - cy0) * p) * k;
        this.apply();
        if (p < 1) requestAnimationFrame(f);
        else res();
      };
      requestAnimationFrame(f);
    });
  }
  zoomAt(cx: number, cy: number, f: number) {
    this.flyId++;
    const nk = clamp(this.cam.k * f, 0.12, 2.2);
    this.cam.x = cx - ((cx - this.cam.x) * nk) / this.cam.k;
    this.cam.y = cy - ((cy - this.cam.y) * nk) / this.cam.k;
    this.cam.k = nk;
    this.apply();
  }
  zoom(f: number) {
    this.zoomAt(this.stage.clientWidth / 2, this.stage.clientHeight / 2, f);
  }
  fit(ms = 900) {
    const R = this.frame1;
    return this.flyTo(this.fitRect({ x: R.x + 40, y: R.y + 40, w: R.w - 80, h: R.h - 80 }), ms);
  }
  private cardRect(c: CardEl) {
    const h = 116 + c.cur.length * LINE + 24 + 190;
    return { x: c.x - 180, y: c.y - 50, w: W + 360, h: h + 100 };
  }

  // ---------------------------------------------------------------- building

  private build() {
    const b = this.board;
    // Columns follow the request, breadth-first from where it starts: a card sits one column right of the
    // first card that sends to it. A reply back to a card already placed doesn't move it.
    const rank = new Map<string, number>();
    const order = [...new Set([...b.steps.map((s) => s.card).filter(Boolean), ...b.cards.map((c) => c.id)])];
    const start = order[0];
    if (start) {
      rank.set(start, 0);
      const queue = [start];
      for (let u = queue.shift(); u; u = queue.shift()) {
        for (const e of b.edges) {
          if (e.from !== u || rank.has(e.to)) continue;
          rank.set(e.to, (rank.get(u) ?? 0) + 1);
          queue.push(e.to);
        }
      }
    }
    let spare = Math.max(-1, ...rank.values()) + 1;
    for (const id of order) if (!rank.has(id)) rank.set(id, spare++);
    const perCol = new Map<number, string[]>();
    for (const id of order) {
      const r = rank.get(id) ?? 0;
      perCol.set(r, [...(perCol.get(r) ?? []), id]);
    }
    const saved = this.o.saved.pos ?? {};
    for (const c of b.cards) {
      const col = rank.get(c.id) ?? 0;
      const list = perCol.get(col) ?? [c.id];
      const row = list.indexOf(c.id);
      const y = 300 + (row - (list.length - 1) / 2) * ROW;
      const at = saved[c.id] ?? { x: col * COL, y };
      this.mkCard(c, at.x, at.y);
    }
    for (const e of b.edges) this.mkEdge(e.from, e.to, e.label);
    this.drawEdges();

    const xs = [...this.cards.values()];
    const minX = Math.min(...xs.map((c) => c.x)) - 120;
    const minY = Math.min(...xs.map((c) => c.y)) - 260;
    const maxX = Math.max(...xs.map((c) => c.x + W)) + 120;
    const maxY = Math.max(...xs.map((c) => c.y + 560)) + 60;
    this.frame1 = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    this.mkFrame(this.frame1, b.title);

    // Try it lives on the board: scenarios start where the request starts.
    const first = this.cards.get(order[0] ?? "") ?? xs[0];
    if (first) this.mkLauncher(first);
    for (const n of this.o.saved.notes ?? []) this.sticky({ x: n.x, y: n.y, text: n.text, c: n.color, r: n.r, mine: true, id: n.id });
  }

  private mkFrame(R: { x: number; y: number; w: number; h: number }, label: string) {
    const f = document.createElement("div");
    f.className = "bd-frame";
    Object.assign(f.style, { left: `${R.x}px`, top: `${R.y}px`, width: `${R.w}px`, height: `${R.h}px` });
    f.innerHTML = `<b>${esc(label)}</b>`;
    this.world.prepend(f);
  }

  private note(label: string, cls: string, claim: Claim): HTMLDivElement {
    const n = document.createElement("div");
    n.className = `bd-nt ${cls}`;
    n.dataset.label = label;
    this.fillNote(n, claim, false);
    return n;
  }
  /** A note with its claim, a label dot, and evidence chips that open the exact lines. */
  private fillNote(n: HTMLDivElement, claim: Claim, typed: boolean, text = claim.text) {
    const checking = this.board.status === "checking" && (claim.label === "confirmed" || claim.label === "record") && !claim.review && !claim.claimedLabel;
    const dot = `<span class="bd-dot ${checking ? "checking" : claim.label}" title="${esc(checking ? "Being double-checked against the code" : (claim.review?.verdict === "upheld" ? `${LABEL[claim.label]}: ${claim.review.reason}` : LABEL[claim.label] ?? ""))}"></span>`;
    const chips = claim.evidence.slice(0, 3).map((e, i) => `<button class="bd-chip${e.check.ok ? "" : " bad"}" data-i="${i}" title="${esc(e.check.ok ? `${e.file}:${e.start}–${e.end}` : e.check.reason ?? "")}">${esc(e.file.split("/").pop() ?? e.file)}:${e.start}</button>`).join("");
    const taken = claim.checkNote ? `<em class="bd-taken">Docent first said “${esc(claim.claimedLabel ?? "")}”; ${esc(claim.checkNote)}.</em>` : "";
    n.innerHTML = `<label>${dot}${esc(n.dataset.label ?? "")}</label><span class="bd-nt-text">${typed ? "" : esc(text)}</span>${chips ? `<div class="bd-chips">${chips}</div>` : ""}${taken}`;
    n.querySelectorAll<HTMLButtonElement>(".bd-chip").forEach((b) => {
      b.onpointerdown = (e) => e.stopPropagation();
      b.onclick = () => {
        const e = claim.evidence[Number(b.dataset.i)];
        if (e) this.o.openCode(e.file, e.start, e.end);
      };
    });
  }

  private mkCard(c: Board["cards"][number], x: number, y: number) {
    const root = document.createElement("div");
    root.className = "bd-card";
    root.dataset.id = c.id;
    root.style.left = `${x}px`;
    root.style.top = `${y}px`;
    root.style.width = `${W}px`;
    root.innerHTML = `<div class="bd-head" tabindex="0" role="button" aria-expanded="false"><div class="bd-num">${c.n}</div><div class="bd-tt"><b>${esc(c.title)}</b><span>${esc(c.file)}</span></div><span class="bd-stat"></span><div class="bd-chev"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></div><div class="bd-role">${esc(c.role)}</div></div><div class="bd-bw"><div><div class="bd-code"></div><div class="bd-file"><button class="bd-open">Open the whole file</button></div><div class="bd-notes"></div></div></div>`;
    const why = this.note("Why", "why", c.why);
    const say = this.note("Say it", "say", c.say);
    root.querySelector(".bd-notes")!.append(why, say);
    const open = root.querySelector<HTMLButtonElement>(".bd-open")!;
    open.onpointerdown = (e) => e.stopPropagation();
    open.onclick = () => this.o.openCode(c.file, c.start, c.start + c.lines.length - 1);
    this.world.appendChild(root);
    const el: CardEl = {
      data: c, root, head: root.querySelector(".bd-head")!, code: root.querySelector(".bd-code")!, stat: root.querySelector(".bd-stat")!,
      why, say, x, y, cur: c.lines.slice(), html: null, typed: false, changed: new Set(),
    };
    this.cards.set(c.id, el);
    void this.o.highlight(c.lines, c.file, c.start).then((h) => {
      el.html = h;
      if (el.typed) this.renderCode(el, this.hotFor(el));
    });
  }

  private hotFor(c: CardEl) {
    return this.s.mode === "tour" ? c.data.hot : [];
  }

  private mkEdge(from: string, to: string, label: string) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "bd-edge");
    path.setAttribute("marker-end", "url(#bd-ah)");
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("class", "bd-edgelab");
    t.textContent = label;
    this.svg.append(path, t);
    this.edges.set(`${from}>${to}`, { path, label: t, from, to });
  }
  private anchor(id: string, side: "l" | "r") {
    const c = this.cards.get(id)!;
    return { x: c.x + (side === "r" ? W : 0), y: c.y + 58 };
  }
  private drawEdges() {
    for (const e of this.edges.values()) {
      const s = this.anchor(e.from, "r");
      const d = this.anchor(e.to, "l");
      const back = d.x < s.x + 40;
      const dx = Math.max(80, Math.abs(d.x - s.x) / 2);
      e.path.setAttribute("d", back
        ? `M${s.x} ${s.y} C${s.x + 160} ${s.y + 260} ${d.x - 160} ${d.y + 260} ${d.x} ${d.y}`
        : `M${s.x} ${s.y} C${s.x + dx} ${s.y} ${d.x - dx} ${d.y} ${d.x} ${d.y}`);
      const len = e.path.getTotalLength();
      const mid = e.path.getPointAtLength(len / 2);
      e.label.setAttribute("x", String(mid.x));
      e.label.setAttribute("y", String(mid.y - 14));
      e.label.setAttribute("text-anchor", "middle");
    }
  }
  private clearEdges() {
    for (const e of this.edges.values()) e.path.classList.remove("on");
  }

  private sticky(o: { x: number; y: number; text: string; c: string; r: number; mine?: boolean; id?: string; w?: number }): HTMLDivElement {
    const s = document.createElement("div");
    s.className = `bd-sticky ${o.c}${o.mine ? " mine" : ""}`;
    s.style.left = `${o.x}px`;
    s.style.top = `${o.y}px`;
    if (o.w) s.style.width = `${o.w}px`;
    s.style.setProperty("--r", `${o.r}deg`);
    s.dataset.c = o.c;
    s.dataset.r = String(o.r);
    const text = document.createElement("span");
    text.className = "bd-st-text";
    text.textContent = o.text;
    s.appendChild(text);
    if (o.mine) {
      s.dataset.id = o.id ?? `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const x = document.createElement("button");
      x.className = "bd-x";
      x.textContent = "×";
      x.setAttribute("aria-label", "Delete note");
      x.onpointerdown = (e) => e.stopPropagation();
      x.onclick = () => {
        s.remove();
        this.persist();
      };
      s.appendChild(x);
      s.addEventListener("dblclick", () => this.edit(text));
      text.addEventListener("blur", () => {
        text.contentEditable = "false";
        this.persist();
      });
    }
    this.world.appendChild(s);
    return s;
  }
  private edit(t: HTMLElement) {
    t.contentEditable = "true";
    t.focus();
    const r = document.createRange();
    r.selectNodeContents(t);
    r.collapse(false);
    const g = getSelection();
    g?.removeAllRanges();
    g?.addRange(r);
  }

  // ---------------------------------------------------------------- code

  private lineHtml(c: CardEl, i: number, cls: string) {
    const changed = c.changed.has(i);
    const body = !changed && c.html?.[i] ? c.html[i] : esc(c.cur[i] ?? "");
    // A safety switch sits on the very line it turns off (shown in Try it).
    const t = this.board.tryIt.toggles.find((x) => x.card === c.data.id && x.line === c.data.start + i);
    const sw = t ? `<button class="bd-ln-sw" data-t="${esc(t.id)}" role="switch" aria-checked="${!changed}" title="${esc(t.label)}: ${esc(t.detail)}"><span>${esc(t.label)}</span><b></b></button>` : "";
    return `<div class="bd-ln ${cls}${t ? " has-sw" : ""}" data-i="${i}"><i>${c.data.start + i}</i><span>${body || " "}</span>${sw}</div>`;
  }
  private renderCode(c: CardEl, hot: number[]) {
    c.code.innerHTML = c.cur.map((_, i) => this.lineHtml(c, i, `${hot.includes(c.data.start + i) ? "hot " : ""}${c.changed.has(i) ? "chg" : ""}`)).join("");
  }
  /** Types the code in, line by line; a click on the card finishes it at once. */
  private async typeCode(c: CardEl, tok: number, hot: number[]) {
    this.typingId = c.data.id;
    c.code.innerHTML = "";
    for (let i = 0; i < c.cur.length; i++) {
      if (tok !== this.tok) return false;
      const row = document.createElement("div");
      row.className = "bd-ln";
      row.innerHTML = `<i>${c.data.start + i}</i><span></span>`;
      c.code.appendChild(row);
      const sp = row.lastElementChild as HTMLSpanElement;
      const t = c.cur[i] ?? "";
      if (!rm() && !this.skip) {
        const car = document.createElement("span");
        car.className = "bd-caret";
        const tn = document.createTextNode("");
        sp.append(tn, car);
        for (let j = 0; j < t.length; j += 2) {
          if (tok !== this.tok) return false;
          if (this.skip) break;
          tn.nodeValue = t.slice(0, j + 2);
          await this.sleep(8 / this.o.rate(), tok);
        }
      }
      row.outerHTML = this.lineHtml(c, i, hot.includes(c.data.start + i) ? "hot" : "");
    }
    c.typed = true;
    if (this.typingId === c.data.id) this.typingId = null;
    return true;
  }
  private async typeText(node: HTMLElement, text: string, tok: number, per: number) {
    node.textContent = "";
    if (rm() || !per) {
      node.textContent = text;
      return;
    }
    const car = document.createElement("span");
    car.className = "bd-caret";
    const tn = document.createTextNode("");
    node.append(tn, car);
    for (let i = 0; i < text.length; i += 2) {
      if (tok !== this.tok) break;
      tn.nodeValue = text.slice(0, i + 2);
      await this.sleep(per, tok);
    }
    tn.nodeValue = text;
    car.remove();
  }
  private async typeNotes(c: CardEl, tok: number) {
    for (const [n, claim] of [[c.why, c.data.why], [c.say, c.data.say]] as const) {
      this.fillNote(n, claim, true);
      await this.typeText(n.querySelector<HTMLElement>(".bd-nt-text")!, claim.text, tok, 10 / this.o.rate());
      if (tok !== this.tok) return;
    }
  }
  /** Opens a card and types its code; its notes too, unless the tour still has questions to ask about it. */
  private async openCard(id: string, tok: number, hot: number[], notes = true) {
    const c = this.cards.get(id);
    if (!c) return false;
    c.root.classList.add("open");
    c.head.setAttribute("aria-expanded", "true");
    c.root.classList.toggle("hold-notes", !notes);
    if (c.typed) {
      this.renderCode(c, hot);
      if (notes) {
        this.fillNote(c.why, c.data.why, false);
        this.fillNote(c.say, c.data.say, false);
      }
      return true;
    }
    this.skip = false;
    await this.sleep(250, tok);
    if (!(await this.typeCode(c, tok, hot))) return false;
    if (notes) await this.typeNotes(c, tok);
    return true;
  }
  private closeCard(id: string) {
    const c = this.cards.get(id);
    if (!c) return;
    c.root.classList.remove("open");
    c.head.setAttribute("aria-expanded", "false");
  }
  // ---------------------------------------------------------------- packets

  private packet(cls = "", text = "") {
    const p = document.createElement("div");
    p.className = `bd-packet ${cls}`;
    p.textContent = text;
    this.world.appendChild(p);
    return p;
  }
  private placePacket(p: HTMLElement, id: string, side: "l" | "r") {
    const a = this.anchor(id, side);
    p.style.transform = `translate(${a.x}px, ${a.y}px)`;
  }
  private travel(p: HTMLElement, key: string, back: boolean, ms: number, tok: number): Promise<void> {
    const e = this.edges.get(key);
    if (!e) return Promise.resolve();
    e.path.classList.add("on");
    const len = e.path.getTotalLength();
    const dur = ms / this.o.rate();
    const at = (q: number) => {
      const pt = e.path.getPointAtLength(len * (back ? 1 - q : q));
      p.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
    };
    if (rm()) {
      at(1);
      return Promise.resolve();
    }
    return new Promise((res) => {
      let t0 = performance.now();
      let pausedAt = 0;
      const f = (n: number) => {
        if (tok !== this.tok) return res();
        if (this.paused) {
          pausedAt ||= n;
          return requestAnimationFrame(f);
        }
        if (pausedAt) {
          t0 += n - pausedAt;
          pausedAt = 0;
        }
        const q = Math.min(1, (n - t0) / dur);
        at(ease2(q));
        if (q < 1) requestAnimationFrame(f);
        else res();
      };
      requestAnimationFrame(f);
    });
  }
  private stat(id: string, text: string, tone: "ok" | "bad" | "neutral" | "", hold = 2600) {
    const c = this.cards.get(id);
    if (!c) return;
    c.stat.textContent = text;
    c.stat.className = `bd-stat show ${tone === "ok" ? "good" : tone === "bad" ? "bad" : ""}`;
    c.root.classList.remove("bad", "good");
    if (tone === "ok") c.root.classList.add("good");
    if (tone === "bad") c.root.classList.add("bad");
    window.clearTimeout(Number(c.stat.dataset.t));
    c.stat.dataset.t = String(window.setTimeout(() => {
      c.stat.classList.remove("show");
      c.root.classList.remove("bad", "good");
    }, hold));
  }

  // ---------------------------------------------------------------- tour

  /** A beat's voice clip, fetched once; a failed fetch is forgotten so it can be tried again. */
  private clip(at: number, beat: number): Promise<VoiceClip | null> {
    const k = `${at}:${beat}`;
    let p = this.clips.get(k);
    if (!p) {
      p = this.o.voice(at, beat).catch(() => null);
      this.clips.set(k, p);
      void p.then((c) => c || this.clips.delete(k));
    }
    return p;
  }
  /** The beat after this one, across steps. */
  private nextBeat(at: number, beat: number): [number, number] | null {
    if (this.board.steps[at]?.beats[beat + 1]) return [at, beat + 1];
    return this.board.steps[at + 1]?.beats[0] ? [at + 1, 0] : null;
  }

  /**
   * The caption, read at the voice's pace when there is a voice: each word appears as it's spoken.
   * Without one it types quickly. Pausing freezes both. True when it was spoken.
   */
  private async narrate(title: string, text: string, at: { at: number; beat: number } | null, tok: number): Promise<boolean> {
    const { title: tEl, text: pEl } = this.o.caption;
    tEl.textContent = title;
    const clip = at === null ? null : await Promise.race([this.clip(at.at, at.beat), new Promise<null>((r) => setTimeout(() => r(null), 4000))]);
    if (tok !== this.tok) return false;
    if (at) {
      const n = this.nextBeat(at.at, at.beat);
      if (n) void this.clip(...n);
    }
    if (!clip) return (await this.typeText(pEl, text, tok, 14 / this.o.rate()), false);
    const words = text.split(/(\s+)/);
    const total = words.filter((w) => w.trim()).length;
    const audio = new Audio(clip.url);
    this.audio?.pause();
    this.audio = audio;
    audio.playbackRate = this.o.rate();
    const draw = (shown: number) => {
      let n = 0;
      pEl.innerHTML = words.map((w) => (w.trim() ? `<span class="${n++ < shown ? "said" : "unsaid"}">${esc(w)}</span>` : w)).join("");
    };
    draw(0);
    try {
      await audio.play();
    } catch {
      return (await this.typeText(pEl, text, tok, 14 / this.o.rate()), false);
    }
    await new Promise<void>((res) => {
      const t = window.setInterval(() => {
        if (tok !== this.tok) {
          audio.pause();
          window.clearInterval(t);
          return res();
        }
        if (this.paused && !audio.paused) audio.pause();
        if (!this.paused && audio.paused && !audio.ended) void audio.play().catch(() => {});
        audio.playbackRate = this.o.rate();
        const spoken = clip.words.filter((w) => w.start <= audio.currentTime).length;
        draw(clip.words.length === total ? spoken : Math.round((spoken / Math.max(1, clip.words.length)) * total));
        if (audio.ended) {
          draw(total);
          window.clearInterval(t);
          res();
        }
      }, 50);
    });
    return true;
  }

  goStep(i: number) {
    this.set({ playing: false });
    this.paused = false;
    void this.runStep(clamp(i, 0, this.board.steps.length - 1), false);
  }
  play() {
    if (this.s.mode !== "tour") return;
    if (this.s.playing) {
      this.paused = !this.paused;
      if (!this.paused) this.audio?.play().catch(() => {});
      else this.audio?.pause();
      this.emit();
      return;
    }
    this.paused = false;
    this.set({ playing: true });
    void this.runStep(this.s.step >= this.board.steps.length - 1 ? 0 : this.s.step, true);
  }
  isPaused() {
    return this.s.playing && this.paused;
  }

  /**
   * One tour step, taught beat by beat: the camera goes to the card (a packet carries the request there),
   * the code types in, then Docent talks, points at lines, asks for a guess and waits, and gives the answer.
   * The card's notes come last, so they never give an answer away before it's asked.
   */
  private async runStep(i: number, auto: boolean) {
    const tok = ++this.tok;
    this.flyId++;
    this.audio?.pause();
    this.set({ step: i, beat: null, quiz: null });
    this.clearEdges();
    this.world.querySelectorAll(".bd-packet").forEach((p) => p.remove());
    const st = this.board.steps[i];
    if (!st) return;
    for (const c of this.cards.values()) c.root.classList.remove("act", "good", "bad");
    for (const id of this.cards.keys()) if (id !== st.card) this.closeCard(id);
    const card = st.card ? this.cards.get(st.card) : null;
    const title = card ? `Step ${i} of ${this.board.steps.length - 1} · ${card.data.title}` : i === 0 ? "The big picture" : "Now you can say it";
    const voiced = auto || this.s.playing;
    // A step that points at lines or asks about them starts with none lit, so nothing is given away.
    const teaches = st.beats.some((b) => b.lines.length);
    let opened: Promise<boolean> = Promise.resolve(true);
    if (!card) {
      void this.fit();
      if (i === this.board.steps.length - 1) for (const e of this.edges.values()) e.path.classList.add("on");
    } else {
      card.root.classList.add("act");
      const fly = this.flyTo(this.fitRect(this.cardRect(card)), 1000);
      let seq = Promise.resolve();
      if (st.route.length) {
        const pk = this.packet();
        this.placePacket(pk, st.route[0]!.split(">")[0]!, "r");
        seq = (async () => {
          for (const k of st.route) {
            await this.travel(pk, k, false, 800, tok);
            if (tok !== this.tok) break;
          }
          pk.remove();
        })();
      }
      await Promise.all([fly, seq]);
      if (tok !== this.tok) return;
      opened = this.openCard(card.data.id, tok, teaches ? [] : card.data.hot, !teaches);
    }
    for (const [b, beat] of st.beats.entries()) {
      if (tok !== this.tok) return;
      if (beat.kind !== "reveal") this.set({ quiz: null });
      this.set({ beat: { i: b, kind: beat.kind } });
      const at = voiced ? { at: i, beat: b } : null;
      if (card && beat.lines.length) await this.codeTyped(card, tok);
      if (tok !== this.tok) return;
      if (beat.kind === "point" && card) {
        this.mark(card, beat.lines);
        void this.leanIn(card, beat.lines);
      }
      if (beat.kind === "predict") {
        this.set({ quiz: { step: i, beat: b, answer: null } });
        await this.narrate(title, beat.text, at, tok);
        await this.waitAnswer(tok);
        if (tok !== this.tok) return;
        if (card && beat.lines.length) {
          this.mark(card, beat.lines);
          void this.leanIn(card, beat.lines);
        }
        await this.sleep(500, tok);
        continue;
      }
      const spoken = await this.narrate(title, beat.text, at, tok);
      // Without a voice, leave time to read before the next sentence replaces this one.
      await this.sleep((spoken ? 350 : 600 + beat.text.split(/\s+/).length * 240) / this.o.rate(), tok);
    }
    if (tok !== this.tok) return;
    if (card && teaches) {
      await opened;
      if (tok !== this.tok) return;
      this.settleMarks(card);
      void this.flyTo(this.fitRect(this.cardRect(card)), 700);
      card.root.classList.remove("hold-notes");
      await this.typeNotes(card, tok);
    }
    if (tok !== this.tok) return;
    this.set({ beat: null });
    if (this.s.playing) {
      await this.sleep(700 / this.o.rate(), tok);
      if (tok !== this.tok) return;
      if (i < this.board.steps.length - 1) void this.runStep(i + 1, true);
      else this.set({ playing: false });
    }
  }

  /** Waits until the card's code has typed in, so its lines can be pointed at. */
  private async codeTyped(c: CardEl, tok: number) {
    while (!c.typed && tok === this.tok) await this.sleep(50, tok);
  }
  /** Docent's hand on the board: these lines get a marker stroke; lines marked earlier in the step stay lit. */
  private mark(c: CardEl, lines: number[]) {
    this.settleMarks(c);
    for (const n of lines) c.code.querySelector(`.bd-ln[data-i="${n - c.data.start}"]`)?.classList.add("pt");
  }
  private settleMarks(c: CardEl) {
    c.code.querySelectorAll(".bd-ln.pt").forEach((r) => r.classList.replace("pt", "hot"));
  }
  /** Leans the camera in on a few lines of a card, as you'd step closer to the whiteboard. */
  private leanIn(c: CardEl, lines: number[]) {
    const rows = lines.map((n) => c.code.querySelector<HTMLElement>(`.bd-ln[data-i="${n - c.data.start}"]`)).filter((r): r is HTMLElement => !!r);
    if (!rows.length) return Promise.resolve();
    const top0 = c.root.getBoundingClientRect().top;
    const k = this.cam.k;
    const top = c.y + (Math.min(...rows.map((r) => r.getBoundingClientRect().top)) - top0) / k;
    const bottom = c.y + (Math.max(...rows.map((r) => r.getBoundingClientRect().bottom)) - top0) / k;
    const h = Math.max(320, bottom - top + 220);
    return this.flyTo(this.fitRect({ x: c.x - 60, y: (top + bottom) / 2 - h / 2, w: W + 120, h }), 700);
  }
  /** Holds the tour on a question until the learner answers it (or skips). */
  private async waitAnswer(tok: number) {
    while (tok === this.tok && this.s.quiz && !this.s.quiz.answer) await new Promise((r) => setTimeout(r, 50));
  }
  /** The learner's guess for the question on screen: a choice, or null to skip to the answer. */
  answer(choice: number | null) {
    const q = this.s.quiz;
    const beat = q && this.board.steps[q.step]?.beats[q.beat];
    if (!q || !beat || q.answer) return;
    this.set({ quiz: { ...q, answer: { choice, ok: choice === null ? null : !!beat.choices[choice]?.correct } } });
  }
  /** A question answered by pointing, waiting for a click on a line. */
  private wantsLine() {
    const q = this.s.quiz;
    return this.s.mode === "tour" && !!q && !q.answer && !!this.board.steps[q.step]?.beats[q.beat]?.lines.length;
  }
  /** The learner pointed: right if it's one of the lines the answer lives on. */
  private guessLine(cardId: string, line: number | null) {
    const q = this.s.quiz!;
    const st = this.board.steps[q.step]!;
    const ok = cardId === st.card && line !== null && st.beats[q.beat]!.lines.includes(line);
    if (!ok) this.cards.get(cardId)?.root.classList.add("bad");
    else this.cards.get(cardId)?.root.classList.add("good");
    this.set({ quiz: { ...q, answer: { choice: null, ok } } });
  }

  // ---------------------------------------------------------------- try it

  /** The scenarios, as buttons on the card where the request starts (shown in Try it). */
  private mkLauncher(first: CardEl) {
    const l = document.createElement("div");
    l.className = "bd-launch";
    l.style.left = `${first.x}px`;
    l.style.top = `${first.y - 132}px`;
    l.innerHTML = `<span>Send one through</span><div></div>`;
    for (const sc of this.board.tryIt.scenarios) {
      const b = document.createElement("button");
      b.textContent = sc.label;
      b.dataset.sc = sc.id;
      b.onpointerdown = (e) => e.stopPropagation();
      b.onclick = () => void this.runScenario(sc.id);
      l.lastElementChild!.appendChild(b);
    }
    this.world.appendChild(l);
    this.launcher = l;
  }

  async runScenario(id: string) {
    const sc = this.board.tryIt.scenarios.find((s) => s.id === id);
    if (!sc) return;
    const tok = ++this.tok;
    this.clearEdges();
    // A switch that's off changes how this scenario ends.
    const off = this.board.tryIt.toggles.find((t) => t.scenario === id && !this.s.toggles[t.id]);
    // With a safety off the request takes the broken path: the writer's own, or (older boards) the real one
    // cut short at its first failure, since what saved it is gone.
    const firstBad = sc.hops.findIndex((h) => h.tone === "bad");
    const hops = off ? (off.offHops?.length ? off.offHops : sc.hops.slice(0, firstBad >= 0 ? firstBad + 1 : sc.hops.length)) : sc.hops;
    const first = hops[0]?.edge.split(">");
    const pk = this.packet();
    this.placePacket(pk, (first?.[hops[0]?.back ? 1 : 0]) ?? "", "r");
    for (const [n, h] of hops.entries()) {
      const last = n === hops.length - 1;
      await this.travel(pk, h.edge, h.back, 700, tok);
      if (tok !== this.tok) return;
      const [a, b] = h.edge.split(">");
      const tone = off && last ? "bad" : h.tone;
      pk.className = `bd-packet ${tone === "bad" ? "bad" : tone === "ok" ? "good" : ""}`;
      this.stat((h.back ? a : b) ?? "", h.stat, tone);
      await this.sleep(350, tok);
    }
    pk.remove();
    const result = off ? off.result : sc.result;
    await this.narrate("What just happened", result.text, null, tok);
  }
  /** Turns a safety off (or back on): the real line changes on its card, and the caption says what that means. */
  async toggle(id: string) {
    const t = this.board.tryIt.toggles.find((x) => x.id === id);
    const c = t && this.cards.get(t.card);
    if (!t || !c) return;
    const on = !this.s.toggles[id];
    this.set({ toggles: { ...this.s.toggles, [id]: on } });
    const tok = ++this.tok;
    const i = t.line - c.data.start;
    c.cur[i] = on ? t.original : t.off;
    if (on) c.changed.delete(i);
    else c.changed.add(i);
    c.root.classList.add("open");
    c.typed = true;
    this.renderCode(c, []);
    this.fillNote(c.why, c.data.why, false);
    this.fillNote(c.say, c.data.say, false);
    void this.flyTo(this.fitRect(this.cardRect(c)), 700);
    c.code.querySelector(`.bd-ln[data-i="${i}"]`)?.classList.add("flash");
    await this.narrate(on ? "Back to normal" : "Changed code", on ? "Restored the original line." : `${t.detail} Run “${this.board.tryIt.scenarios.find((s) => s.id === t.scenario)?.label ?? "the scenario"}” to see what happens.`, null, tok);
  }
  resetTry() {
    this.tok++;
    for (const t of this.board.tryIt.toggles) if (!this.s.toggles[t.id]) void this.toggle(t.id);
    this.clearEdges();
    this.world.querySelectorAll(".bd-packet").forEach((p) => p.remove());
  }

  // ---------------------------------------------------------------- defend

  /**
   * Defend it, by pointing: a question is asked, the learner clicks the card (or the line) where the answer
   * lives, and the board shows where it really is. Knowing where to look is the skill being tested.
   */
  ask(i: number) {
    const d = this.board.defend[i];
    if (!d) return;
    this.tok++;
    this.clearMarks();
    for (const id of this.cards.keys()) this.closeCard(id);
    this.set({ ask: { i, revealed: false, pick: null } });
    void this.fit(700);
  }
  /** The learner pointed at a card (and maybe a line). */
  private pick(cardId: string, line: number | null) {
    const { i, revealed } = this.s.ask;
    const d = this.board.defend[i];
    if (!d || revealed) return;
    const pick: Pick = cardId !== d.card ? "miss" : line !== null && d.lines.includes(line) ? "line" : "card";
    if (pick === "miss") this.cards.get(cardId)?.root.classList.add("bad");
    this.reveal(pick);
  }
  /** Shows where the answer lives: the right card opens on the lines that back it. */
  reveal(pick: Pick | null = null) {
    const { i } = this.s.ask;
    const d = this.board.defend[i];
    const c = d && this.cards.get(d.card);
    this.set({ ask: { i, revealed: true, pick }, picks: pick ? { ...this.s.picks, [i]: pick } : this.s.picks });
    if (!c) return;
    const tok = ++this.tok;
    c.root.classList.add("good", "act");
    void this.openCard(c.data.id, tok, d.lines);
    // The bar grows to show the answer; frame the card once it has, so the bar doesn't cover the lines.
    requestAnimationFrame(() => requestAnimationFrame(() => void this.flyTo(this.fitRect(this.cardRect(c)), 700)));
  }
  /**
   * Points at what an answer rests on: its cards light up, the first one opens on the cited lines, and the
   * camera frames them. Lines outside every card's excerpt are left to the answer's own chips.
   */
  pointAt(cardIds: string[], evidence: { file: string; start: number; end: number }[]) {
    const tok = ++this.tok;
    this.clearMarks();
    const hits = new Map<string, number[]>();
    for (const c of this.cards.values()) {
      const end = c.data.start + c.cur.length - 1;
      const lines = evidence.filter((e) => e.file === c.data.file && e.start <= end && e.end >= c.data.start)
        .flatMap((e) => Array.from({ length: Math.min(e.end, end) - Math.max(e.start, c.data.start) + 1 }, (_, i) => Math.max(e.start, c.data.start) + i));
      if (lines.length) hits.set(c.data.id, lines);
    }
    const ids = [...new Set([...hits.keys(), ...cardIds])].filter((id) => this.cards.has(id));
    if (!ids.length) return false;
    for (const id of ids) this.cards.get(id)!.root.classList.add("act");
    const first = [...hits.keys()][0];
    if (first) void this.openCard(first, tok, hits.get(first)!);
    // Frame the card that opened on the cited lines; the others stay lit where they are.
    const rects = (first ? [first] : ids).map((id) => this.cardRect(this.cards.get(id)!));
    const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
    const R = { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
    requestAnimationFrame(() => requestAnimationFrame(() => void this.flyTo(this.fitRect(R), 700)));
    return true;
  }
  /** Clears what an answer pointed at. */
  unpoint() {
    this.tok++;
    this.clearMarks();
  }
  markDef(k: "yes" | "rev") {
    const { i } = this.s.ask;
    this.s.defended = { ...this.s.defended, [i]: k };
    this.emit();
    this.persist();
    if (i < this.board.defend.length - 1) this.ask(i + 1);
  }
  private clearMarks() {
    for (const c of this.cards.values()) c.root.classList.remove("good", "bad", "act");
  }

  // ---------------------------------------------------------------- modes and tools

  setMode(m: Mode) {
    this.tok++;
    this.flyId++;
    this.paused = false;
    this.audio?.pause();
    this.set({ mode: m, playing: false, beat: null, quiz: null });
    for (const c of this.cards.values()) c.root.classList.remove("hold-notes");
    this.clearEdges();
    this.clearMarks();
    this.stage.dataset.mode = m;
    if (m === "tour") return void this.runStep(this.s.step, false);
    for (const id of this.cards.keys()) this.closeCard(id);
    if (m === "try") {
      // Cards with a safety switch open, so the switch sits next to the line it turns off.
      for (const t of this.board.tryIt.toggles) {
        const c = this.cards.get(t.card);
        if (!c) continue;
        c.root.classList.add("open");
        c.typed = true;
        this.renderCode(c, []);
      }
      void this.fit();
      void this.narrate("Try it", this.board.tryIt.intro, null, this.tok);
    } else this.ask(this.s.ask.i);
  }

  // ---------------------------------------------------------------- pointer

  private clickCard(root: HTMLElement, line: number | null = null) {
    const entry = [...this.cards.values()].find((c) => c.root === root);
    if (!entry) return;
    // In Defend it, clicking a card is the answer: "this is where I'd look".
    if (this.s.mode === "defend") return this.pick(entry.data.id, line);
    if (this.wantsLine()) return this.guessLine(entry.data.id, line);
    if (root.classList.contains("open")) return this.closeCard(entry.data.id);
    const tok = ++this.tok;
    void this.openCard(entry.data.id, tok, this.hotFor(entry));
    void this.flyTo(this.fitRect(this.cardRect(entry)), 700);
  }

  private bindPointer() {
    const P = new Map<number, { x: number; y: number }>();
    let drag: { id: number; sx: number; sy: number; moved: boolean; item: HTMLElement | null; head: HTMLElement | null; ox: number; oy: number; cx: number; cy: number; body: boolean } | null = null;
    let pinch: { d: number } | null = null;
    let line: number | null = null;
    const toWorld = (x: number, y: number) => ({ x: (x - this.cam.x) / this.cam.k, y: (y - this.cam.y) / this.cam.k });
    const st = this.stage;
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("button, input, .bd-mark, a")) return;
      const sEl = t.closest<HTMLElement>(".bd-sticky");
      if (sEl?.querySelector<HTMLElement>(".bd-st-text")?.isContentEditable) return;
      st.setPointerCapture(e.pointerId);
      P.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (P.size === 2) {
        const [a, b] = [...P.values()];
        pinch = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y) };
        drag = null;
        st.classList.remove("pan");
        return;
      }
      const head = t.closest<HTMLElement>(".bd-head");
      // In Defend it, and when the tour asks where something happens, the code of a card counts as pointing at it.
      const point = this.s.mode === "defend" || this.wantsLine() ? t.closest<HTMLElement>(".bd-card") : null;
      const card = head?.parentElement ?? point;
      const item = card ?? sEl;
      const ln = t.closest<HTMLElement>(".bd-ln");
      line = ln && card ? (this.cards.get(card.dataset.id ?? "")?.data.start ?? 0) + Number(ln.dataset.i) : null;
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false, item, head: head ?? point, ox: item?.offsetLeft ?? 0, oy: item?.offsetTop ?? 0, cx: this.cam.x, cy: this.cam.y, body: !head && !point && !!t.closest(".bd-card") };
      if (!item) st.classList.add("pan");
      this.flyId++;
    };
    const move = (e: PointerEvent) => {
      if (!P.has(e.pointerId)) return;
      P.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && P.size === 2) {
        const [a, b] = [...P.values()];
        const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        this.zoomAt((a!.x + b!.x) / 2, (a!.y + b!.y) / 2, d / pinch.d);
        pinch.d = d;
        return;
      }
      if (!drag || drag.id !== e.pointerId) return;
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      if (!drag.item) {
        this.cam.x = drag.cx + dx;
        this.cam.y = drag.cy + dy;
        this.apply();
        return;
      }
      const it = drag.item;
      it.style.left = `${drag.ox + dx / this.cam.k}px`;
      it.style.top = `${drag.oy + dy / this.cam.k}px`;
      const c = [...this.cards.values()].find((x) => x.root === it);
      if (c) {
        c.x = it.offsetLeft;
        c.y = it.offsetTop;
        this.drawEdges();
      }
    };
    const up = (e: PointerEvent) => {
      P.delete(e.pointerId);
      if (P.size < 2) pinch = null;
      if (!drag || drag.id !== e.pointerId) return;
      const d = drag;
      drag = null;
      st.classList.remove("pan");
      if (d.moved) return void (d.item && this.persist());
      if (d.head && d.item) this.clickCard(d.item, line);
      else if (d.body) this.skip = true;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
      else {
        this.flyId++;
        this.cam.x -= e.deltaX;
        this.cam.y -= e.deltaY;
        this.apply();
      }
    };
    // Double-click empty canvas to drop a note there, as on a real whiteboard.
    const dbl = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest(".bd-card, .bd-sticky, .bd-launch, button")) return;
      const w = toWorld(e.clientX, e.clientY);
      const n = this.sticky({ x: w.x - 125, y: w.y - 40, text: "", c: ["", "b", "g", "p"][Math.floor(Math.random() * 4)]!, r: -1 + Math.random() * 2, mine: true });
      this.edit(n.querySelector<HTMLElement>(".bd-st-text")!);
      this.persist();
    };
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest?.("input, textarea, [contenteditable=true]")) return;
      const h = t.closest?.(".bd-head");
      if ((e.key === "Enter" || e.key === " ") && h?.parentElement) {
        e.preventDefault();
        return this.clickCard(h.parentElement);
      }
      if (t.closest?.("button")) return;
      const q = this.s.quiz;
      const choices = q && !q.answer ? this.board.steps[q.step]?.beats[q.beat]?.choices ?? [] : [];
      if (/^[1-9]$/.test(e.key) && Number(e.key) <= choices.length) this.answer(Number(e.key) - 1);
      else if (e.key === " " && this.s.mode === "tour") (e.preventDefault(), this.play());
      else if (e.key === "ArrowRight" && this.s.mode === "tour") this.goStep(this.s.step + 1);
      else if (e.key === "ArrowLeft" && this.s.mode === "tour") this.goStep(this.s.step - 1);
      else if (e.key.toLowerCase() === "f" && !e.metaKey && !e.ctrlKey) void this.fit(600);
    };
    st.addEventListener("pointerdown", down);
    st.addEventListener("pointermove", move);
    st.addEventListener("pointerup", up);
    st.addEventListener("pointercancel", up);
    st.addEventListener("wheel", wheel, { passive: false });
    st.addEventListener("dblclick", dbl);
    const sw = (e: MouseEvent) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>(".bd-ln-sw");
      if (b?.dataset.t) void this.toggle(b.dataset.t);
    };
    st.addEventListener("click", sw);
    this.cleanup.push(() => st.removeEventListener("click", sw));
    document.addEventListener("keydown", key);
    this.cleanup.push(() => {
      st.removeEventListener("pointerdown", down);
      st.removeEventListener("pointermove", move);
      st.removeEventListener("pointerup", up);
      st.removeEventListener("pointercancel", up);
      st.removeEventListener("wheel", wheel);
      st.removeEventListener("dblclick", dbl);
      document.removeEventListener("keydown", key);
    });
  }
}
