# Docent build plan

How Docent gets built, in order. The *what* and *why* live in [design.md](design.md). This file is the *how*, and it's kept current as milestones land.

## Architecture: feature-based

Code is grouped by **what it does for the user**, not by technical layer. Each feature owns its UI, logic, and data access, and exposes one small public surface.

```
docent/
├── apps/
│   ├── web/                    the local app (React + Vite)
│   │   └── src/
│   │       ├── app/            shell: two routes (#/ home, #/board/<id>), settings, repo switch
│   │       ├── features/
│   │       │   ├── home/           what the project does, then its flows as cards
│   │       │   ├── board/          one flow's whiteboard: camera, the guided tour, chat, tray
│   │       │   ├── ask/            chat threads and streaming answers (used by the board's chat)
│   │       │   ├── code/           code sheet and excerpts with highlighted lines (Shiki)
│   │       │   ├── jobs/           background job state and the job pill
│   │       │   ├── settings/       narrator, Claude, appearance
│   │       │   └── workspace/      open a codebase
│   │       └── shared/         design tokens, UI primitives, API client, stores, theme
│   └── server/                 local server (Hono)
│       └── src/
│           ├── app.ts          wires features into one Hono app
│           └── features/
│               ├── workspace/  which codebase is open, recent ones, the folder picker
│               ├── repo/       extract or load cached facts
│               ├── boards/     flows, overview, boards, background drawing jobs, stop
│               ├── ask/        scoped questions, checked answers (SSE)
│               ├── analysis/   features, verification, episodes (the M3–M4 pipeline)
│               ├── graph/      queries over facts
│               ├── source/     read-only file content by range
│               ├── voice/      narration clips
│               └── settings/   keys, voice, Claude mode
└── packages/
    ├── extract/                stage 1: facts from code, git and docs (no LLM)
    ├── analyze/                Claude stages: features, verify, flows, boards, overview, ask, the checks
    ├── llm/                    Claude Code (subscription) or the API behind one interface
    ├── voice/                  Cartesia and Fish Audio (cloud), Kokoro (local, downloaded to ~/.docent/models)
    ├── contracts/              types shared by server and app
    └── cli/                    `docent <repo>`: starts the server, opens the browser
```

**Rules**
- **Dependency direction:** `app → features → shared`. A feature never imports another feature's internals. If two features need something, it moves to `shared`, or the feature exposes it from its `index.ts`.
- **One public surface per feature:** each feature folder has an `index.ts(x)`. Everything else in the folder is private.
- **The server mirrors the app:** UI features call server features through `shared/api`.
- **Facts are read-only:** nothing writes to the analyzed repo. Cache and outputs live in `~/.docent/repos/<repo>/`.
- **The design system lives in `shared/ui`:** tokens and primitives come from the approved hand-built view. Features don't invent their own colors or spacing.

## Milestones

### M1: Facts ✅
`packages/extract`: files, symbols, call graph (resolved by the type checker), imports, tests→code, git history and co-change, docs with mentions of missing paths, env vars, markers, unused files. Covered by fixture tests plus a check against the test app.

### M2: The local app, no LLM ✅
Everything visible here comes straight from facts, so every link is `confirmed` or `inferred` by the compiler.

| # | Task | Feature |
|---|---|---|
| 1 | Restructure into `apps/web`, `apps/server`, `packages/*` | — |
| 2 | Server: open repo, load or extract facts, cache, serve the API | `repo`, `graph`, `source` |
| 3 | Group files into **areas** (folders that act as units: `features/document-upload`, `shared/services`…) with area→area dependencies. Real *features* replace areas in M3 | `graph` |
| 3b | System map as **lanes** (app → features → components → shared), with links shown only on hover. A full graph of 25 areas and 78 links was unreadable | `system-map` |
| 4 | Shell: sidebar, toolbar, canvas, inspector, URL routing (`#/fn/<id>`), back and forward | `app` |
| 5 | Navigator tree with the current item selected | `navigator` |
| 6 | System map: areas as boxes, dependencies as edges, laid out with ELK | `system-map` |
| 7 | Function view: callers ← function → callees, tests, all clickable | `function-view` |
| 8 | File view: its functions, who imports it, what it imports | `file-view` |
| 9 | Inspector panels: location, docs that name it, history, usually-changes-with, all collapsed | features above |
| 10 | Code sheet with highlighted range (Shiki) | `code` |
| 11 | Evidence dots: compiler-confirmed vs inferred, click to see the line | `evidence` |
| 12 | ⌘K search across functions and files | `search` |
| 13 | Health badge: doc paths that don't exist, unused files, inferred links | `health` |
| 14 | Freshness: commit shown, repo-changed indicator, re-read button | `freshness` |
| 15 | `docent <repo>` starts everything and opens the browser | `cli` |

*Done when:* `docent <the test app>` opens the app, I can go from the system map to the hand-traced function in three clicks or one ⌘K, and every connection matches the CLI and the hand tracing.

**Notes from M2:** the "areas" stand-in works but isn't a feature model; M3 replaces it. Diagrams never shrink below 80% of their real size (the canvas scrolls instead). The production bundle is about 1.8 MB, mostly Shiki and ELK, which is fine for a local app.

### Ideas adopted from the external review (ChatGPT, Oct 2026)
It agreed with almost everything here: source-grounded diagrams, validated references, structured steps rendered deterministically (no AI video), TypeScript first, read-only, freshness, not overwhelming the user. What it added, and where each lands:
- **Flows as first-class objects** ("what happens when a user does X"): M3 discovers flows from entry points (UI handlers, routes), not just features. Files and functions show **"Participates in"** the flows they belong to.
- **Interrupt and return:** pause an episode, explore any box, come back to the exact step. An exploration trail is kept (M4).
- **Learning path and progress:** a quiet sidebar section with lessons per feature, "mark as understood", and resume where you left off (M4).
- **Ask about this:** a question scoped to what's on screen, answered from the facts with references validated before display. This moves Q&A from a non-goal to M6, but scoped, not a free chat.
- **Answer by pointing:** understanding checks where you click the function or line where you'd investigate (M6).
- **"Worth investigating" notes** (for example a possible race between a check and a write), labeled separately from confirmed behavior (M3 claims).
- **SQLite** for the fact graph once incremental re-indexing needs it (M7). JSON is fine until then.

From the second review (Oct 2026):
- **Not a collection of ever more elaborate graphs** (brief P11). Each view picks the form that answers the current question: map for boundaries, graph for dependencies, step-by-step flow for order, code for implementation. Ask Docent scenes and episodes follow the same rule: highlight and sequence what's there, don't pile on more boxes.

Deliberately not adopted for now: Electron (local web app first; a desktop shell later if wanted), Monaco (read-only Shiki fits "not another IDE"; the graph already does go-to-definition), the avatar and dashboard-style cards from its mockup image (they conflict with the lean design rule). React Flow was adopted after all (see M2.5).

### M2.5: Warm redesign, React Flow, your Claude subscription ✅
- All diagrams moved to **React Flow** (custom HTML card nodes, pan and pinch-zoom, links that flow when you point at a box, auto-fit when panels open). ELK and our lane and column layouts still decide positions.
- **Palette and type** (revised after review: the first warm version read too brown): cool slate neutrals with an indigo accent, layer color tags (app, features, components, shared) shared by the sidebar and every map, Geist and Geist Mono, Phosphor icons. The whole window is the canvas (FigJam-style): a floating, collapsible map panel, a floating location and search bar, floating details, and the picture re-centered in the open space whenever a panel changes. Shortcuts: `[`, `]`, ⌘\.
- **`packages/llm`**: one interface, two providers. `claude-code` (default) drives the user's own Claude Code headlessly on their subscription, with structured output and read-only tools; `api` uses the Anthropic SDK. Verified on the test app: a read-only question answered correctly from the file. `docent doctor` checks the connection.

### M2.6: Canvas polish from design research ✅
References: FigJam (sections, floating chrome), Eraser (pastel group tints, soft shadows, clean sans and mono), Microsoft Research's Code Canvas (one zoomable surface where going deeper feels like zooming, not paging), React Flow's guidance (rounded orthogonal connectors for flows, particles only where direction matters).
- **Section frames:** tinted, labeled frames group boxes by layer on the overview, by subfolder in an area (wrapping into a grid; "Used by" first, "Uses" last), and as "Called by" / "Calls" around a function or file.
- **Connectors:** a custom React Flow edge. Rounded steps in function and file views with line labels and slow particles showing call direction; soft curves on maps, lit with particles on hover.
- **Fluid motion:** clicking a box glides the camera into it before moving on; the next view arrives as a zoom in (deeper) or zoom out (back up). Panel changes re-center with an eased camera move. Reduced motion turns all of it off.
- **Cards:** a tinted layer chip with an icon for what the item is (area, file, function, component), and compact stats with icons instead of a truncated line.
- **Thin custom scrollbars** everywhere.

### M3: Features, flows, claims, health — in progress
Runs on your Claude subscription through `packages/llm` (an API key is optional).
- Feature discovery (Claude) from entry points, the call graph and co-change, then **a review screen where I rename, merge or split**. The map is frozen after that.
- One verification worker per feature (Agent SDK, read-only tools): it traces the flow, sets a status, and writes claims with evidence.
- **Citation check:** a claim stays `confirmed` only if the cited lines exist and contain the symbols it names.
- "Why" from commits, comments and docs, or "No recorded reason found."
- A merged health report. Areas in the app become features.

*Done when:* the test app's feature map makes sense to me, and health finds both doc problems from the hand tracing by itself.

**M3 progress (first pass, verified on the test app):**
- `packages/analyze`: discovery (fact digest → Claude → mechanical clean-up), verification workers (3 at a time, read-only tools), the citation check, storage under `~/.docent/repos/<repo>/`. Tested: clean-up drops invented paths and accounts for every file; the check demotes claims whose lines don't contain what they name and only accepts commit records that exist.
- CLI: `docent discover | features | approve | verify [id]`.
- Server: `/api/features` (state, links, background jobs), discover, verify, save edits, approve.
- App: overview switches to features (framed by kind, long frames split into columns), review screen (rename, kind, move files, merge, remove, approve), feature view (storyboard of the flow at a readable zoom, summary, analogy, status, claims grouped by kind with evidence chips, issues, files), job pill.
- Real run: discovery proposed 16 sensible features in 60s; verifying "Upload ID document" gave 10 flow steps all passing the check, 12 claims (7 confirmed, 2 records, 2 inferred, 1 unknown), 5 issues including one real medium bug.

**Trust fixes (after the second review):**
- **Isolated Claude sessions.** Headless `claude -p` ran inside the analyzed repo with every settings source loaded, so OpenWolf hooks wrote into the analyzed repo's `.wolf/`, and a repo's own hooks or `CLAUDE.md` could run commands or steer answers. Every call now passes `--setting-sources ""`, `--settings` (all hooks off, `.env*` and key files denied to Read/Grep/Glob), `--strict-mcp-config` and `--disable-slash-commands`.
- **Second reader (brief P3).** After the citation check, a separate session with none of the writer's context tries to refute every `confirmed` and `record` claim. Upheld keeps the label; unsure drops to `inferred`; refuted drops to `unknown`, with the reason shown. Claims of absence carry what was searched, and the second reader repeats the search.
- **Citation check tightened:** a citation that names nothing to look for fails.
- **Local API guard:** requests must carry a local `Host` (stops DNS rebinding), and anything that changes state needs an `x-docent` header (stops cross-site requests from starting Claude runs).

**Open any codebase:** `docent` with no folder opens the app on an "Open a codebase" screen: the macOS folder dialog, a pasted path, or a recent one (`~/.docent/recent.json`). The repo name in the map panel switches to another. The server holds a workspace and rebuilds the repo routes on each open. Extraction now skips build output (`dist/`, `build/`, `.next/`, minified bundles) even when a repo commits it.

**Done since:**
- **Merged health report.** One panel gathers the mechanical findings and every verified feature's issues, its doc-vs-code mismatches, claims the check or the second reader took back, and features verified before their code changed. The extractor now flags docs that name code the repo once declared and has since removed, with the commit that removed it (`git log -S`, kept only if that commit deleted a declaration, so EXIF tags and browser APIs aren't flagged). On kyc it finds both mockup errors without being told (`ARCHITECTURE.md:84`; `services/README.md:40` `DocumentUploadError`, removed in `0301b21`) plus one nobody knew about (`hooks/README.md:119` `useDocumentDetectionSocket`, removed in `25780de`).
- **"Part of":** file and function details list the features they belong to and the verified flow steps that run through them, including features that only pass through shared code.
- **Stop a running job:** the job pill has a stop button; Claude sessions in flight are killed and finished features stay saved.

- **Copied code:** extraction finds functions copied across files: "exact" (same body, comments and spacing aside: confirmed) and "same shape" (names and literals changed: inferred, and only for real logic, so thin wrappers configuring one shared component don't count). The test app has none.
- **All 16 of the test app's features verified** through the citation check and the second reader (map approved by the user).

**M3 is done.**

**Secrets (brief §8):** every prompt is redacted before it reaches Claude (private keys, provider tokens, JWTs, connection-string passwords, values assigned to `*_SECRET` / `*_TOKEN` / `*_PASSWORD` / `*_API_KEY`), tuned to leave ordinary code alone. Claude's read tools can't open `.env*`, key files, `.npmrc`/`.netrc`, or agent session folders (`.wolf/`, `.claude/`, `.cursor/`, `.codex/`, `.agents/`). The citation check fails any citation whose lines hold a secret, and claim, issue, narration and caption text is redacted before it's stored. Trade-off: agent logs are no longer read for "why"; commit messages, comments and docs still are. A redacted excerpt path for agent logs can come later if they prove worth it.

**Monorepo overview:** a package's `src` root is named after the package and merged with its other folders, so pnpm workspaces no longer show a row of "Top level" boxes.

**Backlog found along the way:**
- Cancel a running job (a mis-click started a duplicate verification with no way to stop it).
- Unused-export detection: today only files nothing imports are flagged; a file re-exported by a barrel but never used (e.g. `components/base/UploadFile.tsx`) is missed. Discovery's guess about it was half right, which is why guesses stay labeled.

### One flow for newcomers (Oct 15, user decision)
A first-timer shouldn't have to know about discovery, review, approval, verification and episode writing. Now:
- **One button,** "Learn this codebase", on a codebase's first open: a single `prepare` job finds the features, then checks every one that isn't ready (3 at a time). Features are usable as soon as each is checked.
- **No approval gate.** The map is used as soon as it's found; "Edit the map" is optional, and saving edits re-checks only the features that changed. (Overrides the brief's "review before anything else runs".)
- **Episodes make themselves:** opening a feature's episode writes it (or checks the feature first) without a click, on its own lane beside the prepare job. The wait shows what's already known: summary, analogy, the flow.
- **Waits say what's happening:** every job reports a plain-words stage, the features in flight, and a time estimate refined from real progress; the progress bar moves with time and never goes back.
- **Pacing:** playback speed (1×, 1.25× default, 1.5×, 1.75×) for voice and text; shorter gaps between steps; the next two clips are fetched ahead, and the first two while the intro shows.

### M3.5: Ask Docent (chat that explains with the canvas) — first version done
Built: `/` or the chat button opens a panel scoped to the current view. The server builds the context from the view (facts, the function's code, what verification established for the features it belongs to) and Claude answers with read-only tools. Every paragraph goes through the citation check and the second reader, like verification claims. Progress streams (reading, answering, checking). The diagram publishes its boxes; Claude sees them as short refs (b1, b2…) and can only point at those (P11: no new boxes). "Show me" plays the scene: boxes light, links animate in their real direction, the camera follows, and the panel shrinks to the caption. "Explain simpler" asks again with an analogy first. Threads are kept per view while the app is open.
Checked on the test app's hand-traced function: "What happens if the storage upload fails for one side?" gave 5 labeled paragraphs and a 5-step scene. On its own it found that the other side's upload isn't cancelled (the hand tracing's finding, labeled inferred), and the second reader caught an overstatement about which errors show a message.
Next for it: answers that jump to a view that would show more when the current one can't; keeping threads across reloads.

The user can chat with Docent whenever something isn't clear, and the answer can show, not just tell.
- **Scoped:** a chat panel that knows what's on screen (system, area, file, function, a flow step or a line) and answers from the facts plus the feature analyses, reading code read-only when needed. Runs on the user's subscription.
- **Checked:** every reference in an answer goes through the citation check before it is shown; guesses are labeled.
- **Explains with the canvas:** an answer can include a short "scene": which boxes to highlight, which links to animate, in what order, with one caption per step. The canvas plays it with the same motion as episodes (camera glides, particles along links). "Show me" replays it; "explain simpler" asks again with an analogy first.
- **Remembers the thread** per view, and lets the user jump from an answer straight to the box or line it mentions.

### M4: Episodes (Learn mode) — first episode built, waiting on your review
Built:
- **Content** (`packages/analyze/episode.ts`, `EpisodeSchema`): Claude writes from the feature's verified analysis: a plain intro, an analogy, a cast of 3–8 boxes each tied to real files and lines, 4–7 scenes with one objective each, steps pairing lit boxes with ~35 spoken words, a caption, the code lines, labeled packets, and a claim with evidence. One or two predict steps, the five self-check questions, and a hands-on exercise with a way to check it. A mechanical clean-up drops boxes that don't stand for real code (and the links, packets and ranges that point at them); every claim goes through the citation check and the second reader.
- **Player** (`features/episode`, route `#/episode/<id>`): intro card, then the cast on the canvas laid out in lanes. Each step lights its boxes, plays its packets one after another in causal order (looping), frames the camera on them, and the code panel follows. Predict pauses until answered, then reveals with evidence. Space, ← and → drive it. Clicking a box pauses and shows its code with "Open in Work mode"; a "Back to the episode, step N" pill returns to the same step from anywhere, and position survives reloads. The map folds away while playing (P10). The end card holds the self-check (answers hidden) and the exercise.
- Shared with Ask Docent: the same scene store and diagram, now with packets.
- `docent episode <repo> <id>`; the feature view has "Watch the episode"; the server writes episodes as a background job and marks them stale when the feature's code changes.

the test app's document upload: 6 scenes, 20 steps, 7 boxes, 26 claims (24 confirmed, 1 taken back by the second reader), written in about 2.5 minutes.

*Done when* is your call: watch it and compare it with the hand tracing. Pacing is placeholder (word count) until M5 voice.

- Scene-spec schema (steps: nodes, edges, lines, packets, narration, caption, evidence, predict).
- Episode writer (Claude) with the Docent persona.
- Player in `features/episode`: moving packets, captions, predict pauses, the code inspector following along.

*Done when:* a generated episode for document upload is as clear and accurate as the hand tracing.

### M5: Voice (pluggable) — built, waiting on a Cartesia key
Built: `packages/voice` with the `VoiceAdapter` interface below and a Cartesia adapter (`/tts/sse`, `sonic-3.6`, word timestamps), WAV clips cached in `~/.docent/voice/` by a hash of text + provider + voice. The server speaks a step only by episode and step number, so only narration text reaches the provider. The player's narration types word by word on the voice's clock (each word appears when it's spoken); pause freezes voice and text mid-line, play carries on, and the step moves on when the voice ends. Without a key it falls back to an estimated pace (2.6 words/s) and the speaker button explains why. Mute is remembered. The next line is fetched while the current one plays.
Checked with a stand-in voice in the browser; not yet with Cartesia itself. To hear it: put `CARTESIA_API_KEY` in Docent's `.env` (gitignored; see `.env.example`) and restart. The CLI and the dev server both load it; a key already in the shell wins. Since then:
- **Settings panel** (gear, top right): pick the narrator's provider (Cartesia or Fish Audio), paste or replace its key (tested by speaking a word before it's saved; stored in Docent's `.env`; only a masked hint comes back), search and preview voices (yours first) and choose one per provider, narration speed, an "expressive" switch, and Claude by subscription or API key.
- **Fish Audio adapter** (`s2.1-pro`, falling back to the free `s2.1-pro-free` when the account has no API credit). Fish returns no word timings, so words are spread over the real clip length.
- **Expression:** each episode step carries a tone (calm, warm, curious, concerned, emphatic) that the writer chooses; Cartesia gets an emotion and pace, Fish an inline `[cue]`. Older episodes infer it. Predict questions are spoken too, in a curious tone.
- **Pronunciation table:** defaults for terms voices stumble on (JPEG, SHA-256, KYC, CORS, presign…) plus your own lines in Settings; only the audio changes, the screen keeps the real word.
- **`docent voice <repo> <id>`** speaks every line ahead of time (the test app's document upload: 20 lines, 4 min 15 s of narration, built in 52 s; a re-run makes no calls).
- The document-upload episode was rewritten with tones chosen by the writer (mostly calm; concerned through "what can go wrong").

#### Original M5 plan
- A `packages/voice` package with one small interface, so any provider plugs in:
  ```ts
  interface VoiceAdapter {
    id: string;                                   // "cartesia", "fish-audio", …
    synthesize(text: string, opts: { voice: string; speed?: number; pronunciations?: Record<string, string> }): Promise<{ audio: Uint8Array; mime: string; durationMs: number }>;
    listVoices?(): Promise<{ id: string; name: string; description?: string }[]>;
  }
  ```
- The first adapters are **Cartesia** (`CARTESIA_API_KEY`) and **Fish Audio** (`FISH_AUDIO_API_KEY`). Pick the provider and voice in `~/.docent/config.json` or with `--voice cartesia:<voice-id>`.
- Clips are cached by a hash of text + provider + voice + settings, so switching provider regenerates the audio but leaves content untouched.
- Pacing comes from the real clip length. The pronunciation table is applied as text substitution by default, or passed to the provider when it supports dictionaries.
- Providers only ever receive narration text, never code. Keys come only from the environment.

### M5.5: The board is the app ✅
The map-and-inspector screens gave way to one idea: pick a flow of the codebase, and Docent draws it as a whiteboard from the real code and takes you through it.
- **Flows** (`packages/analyze/src/board.ts`): `proposeFlows` (about 25 s) suggests the flows worth learning; `writeBoard` (about 2 min) draws one as cards, links and a tour; `citeBoard` runs the citation check on every card (instant); `checkBoard` is the second reader, running behind the open board.
- **Home** (`features/home`): what the project does (`packages/analyze/src/overview.ts`, cited and double-checked, cached in `overview.json`), then the flow cards tagged Ready, Drawing, or not drawn yet.
- **Board** (`features/board`): a plain-DOM camera on a FigJam dot canvas with a zoom pill (+, −, fit). The tour narrates step by step; `pointAt` frames any card or line. Claims, labels and line references render as chips (`Said.tsx`).
- **Ask Docent on the board:** the Ask button or `/`. The chat is scoped to the tour step and reuses `/api/ask` with `Route { view: "board" }`. Answers go through the citation check and the second reader, and the board opens the cited card on the cited lines.
- **Background drawing:** boards draw as server jobs. A tray (bottom left) shows progress, says when one is ready with an open button, and its × cancels, hides or stops. `POST /api/boards/:id/stop` aborts the Claude run.
- **Look and feel:** light, dark and system theme from one cycling button (`data-theme` on `<html>`); Lucide icons; Atkinson Hyperlegible Next with Geist Mono for code; the Lucide `Presentation` mark with a lowercase "docent" wordmark; responsive at 375 px and 768 px.
- **Tidy-up:** the old screens (system map, navigator, area, file, function and feature views, feature review, episode player, search, health badge, freshness) and the React Flow and ELK diagram layer were removed from the app, along with `@xyflow/react`, `elkjs`, `motion` and Phosphor. Their server routes and CLI commands remain.

**One guided tour (Oct 17, user decision).** Docent takes you through your code; it doesn't test you or set homework. A hands-on exercise ("Do it") was built and removed, and the board's tabs went with it:
- The board is one tour in five parts: **intro** (one concrete request and the question the tour answers), **flow** (one step per card, following that request), **when it goes wrong** (the packet runs the path a failure really takes, each card shows its status, then the code that decides it), **why it's built this way** (a reviewer's question, answered with evidence), and **close** (the one sentence to say out loud).
- Each step is beats: **say**, **point** (a marker stroke on 1–3 lines while it's said, the camera leaning in), **ask** (the question a newcomer would have; Docent answers it itself after a moment) and **reveal** (the answer, with its label and evidence under the caption). A card's notes wait until its step is told.
- Try it's failure scenarios and Defend it's questions became tour steps; boards written before this are upgraded on load, keeping their checked claims.

**The tour, improved (Oct 17):**
- **Drawn as it goes.** The whole board is in view from the start (an empty start was tried and rejected); cards the story hasn't reached are faded. Each step draws the arrow the request travels along, brings the card it reaches to full strength, then sends the packet in. Jumping shows the board as it is at that step at once.
- **The example's values on the code.** Point and reveal beats can write what the intro's example request holds at a line ("file.size = 3 MB → passes") beside it, so a step reads as a trace of one real request.
- **Why?** beside the caption pauses the tour and asks Docent about the sentence on screen; the answer is checked and pointed at on the board, and "Back to the tour" restarts the step, playing on if it was.
- **Narration per beat** with a real voice (Cartesia): words appear on the audio's clock, the next beat's clip is fetched ahead, and a question gets a short pause before its answer.
- **Progress** is kept per tour in the browser: the board opens where you stopped, and home says "stopped at step 4 of 14" or "watched".
- **Chat answers show sooner and type in.** After the instant citation check the answer is sent as a draft and types in paragraph by paragraph; its labels read "checking" until the second reader settles them in place (about 20 s later), and the board points at the cited lines as soon as the draft lands. Nothing is shown before its citations are checked.
- **Faster (Oct 17).** The board writer gets the flow's files in its prompt, numbered, instead of opening each one with a tool (a board on the test app: 188 s → 126 s). The second reader runs at low effort in batches of 6 claims, 3 at once, everywhere it's used (board double-check about 70 s → 15 s; chat about 23 s → 6.5 s), and still refutes what it should. Chat answers on a board are kept on disk per board (`~/.docent/repos/<repo>/answers/`), valid while the board and the commit are unchanged: a repeated question is answered at once, and the conversation comes back after a reload.
- No reading holds between cards (tried and rejected: the learner pauses when they want to read). The open card sits above the cards it grows over. The code sheet is always dark, like the code on the cards.

**Backlog:** a stop button on the board's own drawing screen; chat answers kept across reloads.

### M6: Work-mode depth
- Must stay true, if you change it, when it breaks, break-it, and exercises, generated per function.
- `ran it` probes in a scratch copy, never the real repo.
- "Explain this deeper" on demand, streamed, then cached.

### Open source and npm (Oct 17)
- **One package, `@whytepeter/docent`:** `packages/cli/build.mjs` bundles the CLI, the server and Docent's packages into `dist/docent.js` (esbuild), with the built web app beside it in `dist/web`. npm packages stay imports, and the build fails if one isn't listed in the package's dependencies. The tarball is about 2.5 MB; an install is about 60 MB.
- **`docent` alone opens the current folder** when it looks like a project (a `.git` or `package.json`), and the browser lands on that project's page. `--port` picks another port; if 4477 is taken, any free port is used.
- **Keys live in `~/.docent/.env`** when installed; a checkout keeps using its own `.env`.
- **The local voice's runtime comes with its weights.** onnxruntime-node (about 290 MB) and phonemizer aren't in the install; downloading Kokoro in Settings installs them into `~/.docent/models/kokoro/runtime` with npm. A checkout uses the workspace's copies.
- README, MIT license, CONTRIBUTING and a CI workflow (typecheck, tests, build). The private test repos' names and the hand-built mockup are out of the repo.

### M7: Freshness
- Hash-based stage caching, incremental re-runs, a file watcher marking stale views.

### M8: Monorepos
- Vue single-file components, workspace (multi-app) repos, per-app entry points.

## Working agreements
- Every milestone ends with tests passing, a typecheck, and a check against the test app.
- No new external service without asking first.
- Commits only when asked.
