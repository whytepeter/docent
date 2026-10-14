# Docent build plan

How Docent gets built, in order. The *what* and *why* live in `DOCENT-BRIEF.md`. This file is the *how*, and it's kept current as milestones land.

## Architecture: feature-based

Code is grouped by **what it does for the user**, not by technical layer. Each feature owns its UI, logic, and data access, and exposes one small public surface.

```
docent/
├── apps/
│   ├── web/                    the local app (React + Vite)
│   │   └── src/
│   │       ├── app/            shell: layout, routing, providers, keyboard
│   │       ├── features/
│   │       │   ├── navigator/      sidebar tree: system → area → file → function
│   │       │   ├── system-map/     the whole repo as areas and how they depend
│   │       │   ├── file-view/      one file: its functions, importers, imports
│   │       │   ├── function-view/  one function: callers, callees, tests (the core screen)
│   │       │   ├── code/           code sheet and excerpts with highlighted lines
│   │       │   ├── evidence/       evidence dots and the sheet behind them
│   │       │   ├── search/         ⌘K jump to any file or function
│   │       │   ├── health/         toolbar badge: stale docs, unused files, guesses
│   │       │   ├── freshness/      which commit, is the repo ahead, re-read
│   │       │   └── episode/        (M4) Learn mode player
│   │       └── shared/         design tokens, UI primitives, API client, hooks
│   └── server/                 local server (Hono)
│       └── src/
│           ├── app.ts          wires features into one Hono app
│           └── features/
│               ├── repo/       open a repo, extract or load cached facts, watch
│               ├── graph/      queries over facts: overview, file, function, search
│               └── source/     read-only file content by range
└── packages/
    ├── extract/                stage 1: facts from code, git and docs (no LLM)
    └── cli/                    `docent <repo>`: starts the server, opens the browser
```

**Rules**
- **Dependency direction:** `app → features → shared`. A feature never imports another feature's internals. If two features need something, it moves to `shared`, or the feature exposes it from its `index.ts`.
- **One public surface per feature:** each feature folder has an `index.ts(x)`. Everything else in the folder is private.
- **The server mirrors the app:** UI features call server features through `shared/api`.
- **Facts are read-only:** nothing writes to the analyzed repo. Cache and outputs live in `~/.docent/repos/<repo>/`.
- **The design system lives in `shared/ui`:** tokens and primitives come from the approved mockup (`mockups/function-view.html`). Features don't invent their own colors or spacing.

## Milestones

### M1: Facts ✅
`packages/extract`: files, symbols, call graph (resolved by the type checker), imports, tests→code, git history and co-change, docs with mentions of missing paths, env vars, markers, unused files. Covered by fixture tests plus a check against kyc-site-main.

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

*Done when:* `docent ~/Documents/code/skaletek/kyc-site-main` opens the app, I can go from the system map to `submitDocument` in three clicks or one ⌘K, and every connection matches the CLI and the mockup.

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
- **`packages/llm`**: one interface, two providers. `claude-code` (default) drives the user's own Claude Code headlessly on their subscription, with structured output and read-only tools; `api` uses the Anthropic SDK. Verified on kyc-site-main: a read-only question answered correctly from the file. `docent doctor` checks the connection.

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

*Done when:* kyc's feature map makes sense to me, and health finds both doc problems from the mockup by itself.

**M3 progress (first pass, verified on kyc-site-main):**
- `packages/analyze`: discovery (fact digest → Claude → mechanical clean-up), verification workers (3 at a time, read-only tools), the citation check, storage under `~/.docent/repos/<repo>/`. Tested: clean-up drops invented paths and accounts for every file; the check demotes claims whose lines don't contain what they name and only accepts commit records that exist.
- CLI: `docent discover | features | approve | verify [id]`.
- Server: `/api/features` (state, links, background jobs), discover, verify, save edits, approve.
- App: overview switches to features (framed by kind, long frames split into columns), review screen (rename, kind, move files, merge, remove, approve), feature view (storyboard of the flow at a readable zoom, summary, analogy, status, claims grouped by kind with evidence chips, issues, files), job pill.
- Real run: discovery proposed 16 sensible features in 60s; verifying "Upload ID document" gave 10 flow steps all passing the check, 12 claims (7 confirmed, 2 records, 2 inferred, 1 unknown), 5 issues including one real medium bug.

**Trust fixes (after the second review):**
- **Isolated Claude sessions.** Headless `claude -p` ran inside the analyzed repo with every settings source loaded, so OpenWolf hooks wrote into kyc-site-main's `.wolf/`, and a repo's own hooks or `CLAUDE.md` could run commands or steer answers. Every call now passes `--setting-sources ""`, `--settings` (all hooks off, `.env*` and key files denied to Read/Grep/Glob), `--strict-mcp-config` and `--disable-slash-commands`.
- **Second reader (brief P3).** After the citation check, a separate session with none of the writer's context tries to refute every `confirmed` and `record` claim. Upheld keeps the label; unsure drops to `inferred`; refuted drops to `unknown`, with the reason shown. Claims of absence carry what was searched, and the second reader repeats the search.
- **Citation check tightened:** a citation that names nothing to look for fails.
- **Local API guard:** requests must carry a local `Host` (stops DNS rebinding), and anything that changes state needs an `x-docent` header (stops cross-site requests from starting Claude runs).

**Open any codebase:** `docent` with no folder opens the app on an "Open a codebase" screen: the macOS folder dialog, a pasted path, or a recent one (`~/.docent/recent.json`). The repo name in the map panel switches to another. The server holds a workspace and rebuilds the repo routes on each open. Extraction now skips build output (`dist/`, `build/`, `.next/`, minified bundles) even when a repo commits it.

**Done since:**
- **Merged health report.** One panel gathers the mechanical findings and every verified feature's issues, its doc-vs-code mismatches, claims the check or the second reader took back, and features verified before their code changed. The extractor now flags docs that name code the repo once declared and has since removed, with the commit that removed it (`git log -S`, kept only if that commit deleted a declaration, so EXIF tags and browser APIs aren't flagged). On kyc it finds both mockup errors without being told (`ARCHITECTURE.md:84`; `services/README.md:40` `DocumentUploadError`, removed in `0301b21`) plus one nobody knew about (`hooks/README.md:119` `useDocumentDetectionSocket`, removed in `25780de`).
- **"Part of":** file and function details list the features they belong to and the verified flow steps that run through them, including features that only pass through shared code.
- **Stop a running job:** the job pill has a stop button; Claude sessions in flight are killed and finished features stay saved.

- **Copied code:** extraction finds functions copied across files: "exact" (same body, comments and spacing aside: confirmed) and "same shape" (names and literals changed: inferred, and only for real logic, so thin wrappers configuring one shared component don't count). kyc has none.
- **All 16 kyc features verified** through the citation check and the second reader (map approved by the user).

**M3 is done.**

**Secrets (brief §8):** every prompt is redacted before it reaches Claude (private keys, provider tokens, JWTs, connection-string passwords, values assigned to `*_SECRET` / `*_TOKEN` / `*_PASSWORD` / `*_API_KEY`), tuned to leave ordinary code alone. Claude's read tools can't open `.env*`, key files, `.npmrc`/`.netrc`, or agent session folders (`.wolf/`, `.claude/`, `.cursor/`, `.codex/`, `.agents/`). The citation check fails any citation whose lines hold a secret, and claim, issue, narration and caption text is redacted before it's stored. Trade-off: agent logs are no longer read for "why"; commit messages, comments and docs still are. A redacted excerpt path for agent logs can come later if they prove worth it.

**Monorepo overview:** a package's `src` root is named after the package and merged with its other folders, so drawam-style workspaces no longer show a row of "Top level" boxes.

**Backlog found along the way:**
- Cancel a running job (a mis-click started a duplicate verification with no way to stop it).
- Unused-export detection: today only files nothing imports are flagged; a file re-exported by a barrel but never used (e.g. `components/base/UploadFile.tsx`) is missed. Discovery's guess about it was half right, which is why guesses stay labeled.

### M3.5: Ask Docent (chat that explains with the canvas) — first version done
Built: `/` or the chat button opens a panel scoped to the current view. The server builds the context from the view (facts, the function's code, what verification established for the features it belongs to) and Claude answers with read-only tools. Every paragraph goes through the citation check and the second reader, like verification claims. Progress streams (reading, answering, checking). The diagram publishes its boxes; Claude sees them as short refs (b1, b2…) and can only point at those (P11: no new boxes). "Show me" plays the scene: boxes light, links animate in their real direction, the camera follows, and the panel shrinks to the caption. "Explain simpler" asks again with an analogy first. Threads are kept per view while the app is open.
Checked on kyc's `submitDocument` view: "What happens if the storage upload fails for one side?" gave 5 labeled paragraphs and a 5-step scene. On its own it found that the other side's upload isn't cancelled (the mockup's finding, labeled inferred), and the second reader caught an overstatement about which errors show a message.
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

kyc document upload: 6 scenes, 20 steps, 7 boxes, 26 claims (24 confirmed, 1 taken back by the second reader), written in about 2.5 minutes.

*Done when* is your call: watch it and compare it with `mockups/function-view.html`. Pacing is placeholder (word count) until M5 voice.

- Scene-spec schema (steps: nodes, edges, lines, packets, narration, caption, evidence, predict).
- Episode writer (Claude) with the Docent persona.
- Player in `features/episode`: moving packets, captions, predict pauses, the code inspector following along.

*Done when:* a generated episode for document upload is as clear and accurate as the hand-built mockup.

### M5: Voice (pluggable) — built, waiting on a Cartesia key
Built: `packages/voice` with the `VoiceAdapter` interface below and a Cartesia adapter (`/tts/sse`, `sonic-3.6`, word timestamps), WAV clips cached in `~/.docent/voice/` by a hash of text + provider + voice. The server speaks a step only by episode and step number, so only narration text reaches the provider. The player's narration types word by word on the voice's clock (each word appears when it's spoken); pause freezes voice and text mid-line, play carries on, and the step moves on when the voice ends. Without a key it falls back to an estimated pace (2.6 words/s) and the speaker button explains why. Mute is remembered. The next line is fetched while the current one plays.
Checked with a stand-in voice in the browser; not yet with Cartesia itself. To hear it: put `CARTESIA_API_KEY` in Docent's `.env` (gitignored; see `.env.example`) and restart. The CLI and the dev server both load it; a key already in the shell wins. Since then:
- **Settings panel** (gear, top right): pick the narrator's provider (Cartesia or Fish Audio), paste or replace its key (tested by speaking a word before it's saved; stored in Docent's `.env`; only a masked hint comes back), search and preview voices (yours first) and choose one per provider, narration speed, an "expressive" switch, and Claude by subscription or API key.
- **Fish Audio adapter** (`s2.1-pro`, falling back to the free `s2.1-pro-free` when the account has no API credit). Fish returns no word timings, so words are spread over the real clip length.
- **Expression:** each episode step carries a tone (calm, warm, curious, concerned, emphatic) that the writer chooses; Cartesia gets an emotion and pace, Fish an inline `[cue]`. Older episodes infer it. Predict questions are spoken too, in a curious tone.
- **Pronunciation table:** defaults for terms voices stumble on (JPEG, SHA-256, KYC, CORS, presign…) plus your own lines in Settings; only the audio changes, the screen keeps the real word.
- **`docent voice <repo> <id>`** speaks every line ahead of time (kyc document upload: 20 lines, 4 min 15 s of narration, built in 52 s; a re-run makes no calls).
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

### M6: Work-mode depth
- Must stay true, if you change it, when it breaks, break-it, and exercises, generated per function.
- `ran it` probes in a scratch copy, never the real repo.
- "Explain this deeper" on demand, streamed, then cached.

### M7: Freshness
- Hash-based stage caching, incremental re-runs, a file watcher marking stale views.

### M8: drawam
- Vue single-file components, workspace (multi-app) repos, per-app entry points.

## Working agreements
- Every milestone ends with tests passing, a typecheck, and a check against kyc-site-main.
- No new external service without asking first.
- Commits only when asked.
