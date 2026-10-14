# Docent: Brief for Claude Code

> Read this whole document before writing anything. It explains the idea, the reasoning, and what "done" looks like. Where I name a constraint, treat it as a requirement. Everything else is yours to decide.
>
> A hand-built mockup of the function view exists in `mockups/function-view.html`.

---

## 1. The problem

I own codebases built mostly by AI agents. I didn't write them, so I don't carry their map in my head. The READMEs are long, tedious, and sometimes wrong, because agents leave stale or contradictory documentation behind.

Reading docs doesn't get me to understanding. I need to **own** the code: know what every part does and how it connects, change it myself, and find the cause when a bug shows up later, without asking an agent first.

## 2. The idea

**Docent** is a local app you point at a codebase. It teaches you that codebase the way a senior engineer at a whiteboard would, or a good YouTube explainer: animated diagrams, a calm voice explaining what you're looking at, and the parts lighting up as they're mentioned.

It doesn't stop at the overview. You can zoom from the whole system down to one feature, its flow, one file, one function, and one line. At every level you see what that thing does **and how it connects to everything around it**. That's what makes it possible to change code and debug it yourself.

A good docent in a museum doesn't read the labels aloud. They tell you why the piece matters, how it connects to the rest of the collection, and which one is a forgery. That is the behavior to build.

### Ask Docent

At any point I can chat with Docent about what's on screen. If I don't understand, it explains again, and it can show the answer: highlighting the boxes involved and playing the flow on the canvas with motion, step by step. Answers are grounded in the code, and every reference is checked before I see it.

### Two modes

**Learn mode** is the YouTuber part. These are narrated, animated episodes, one per feature and one per key function. Each episode is a sequence of short scenes, and each scene carries one idea. Data moves along the arrows with labels ("front photo", "signed targets"). The camera zooms from the big picture into the real code, and lines highlight as the voice explains them. The episode pauses to ask me to predict what happens before it shows me. It ends with an exercise.

**Work mode** is what I keep open while editing or debugging:
- **Explore:** click any box or function to see what it is, why it exists, its code, and its connections (what calls it, what it calls, what data goes in and out, what else touches the same data).
- **Change:** pick a likely change from a menu and see every file, feature and test it touches.
- **Break it:** pick a failure ("storage unreachable") and watch it spread: which functions fail, and what the user sees.
- **Debug:** start from a symptom ("upload failed after a long wait") and get where to look first, then next.
- **Health:** which parts are solid, which I shouldn't trust, and where the docs disagree with the code.

### What I experience

1. I run `docent` in a repo. A local app opens in my browser.
2. The home view is a map of the system: features as nodes, dependencies as edges, problem areas marked.
3. I open a feature and watch its episode, or switch to Work mode and click straight into a function.
4. Any box can be opened. Any claim can be expanded to show the exact file, lines, and snippet it rests on.
5. If I go deeper than what was pre-built, I press "explain this deeper". Docent generates that scene on the spot (narration included), caches it, and plays it.
6. After an episode I do a small exercise in the real repo and run a command that tells me whether I understood.

## 3. What success means

After a feature's episode, or a function's deep-dive, I can answer without help:

1. What does it do, in one sentence?
2. How does a request flow through it?
3. Where would I change X?
4. What would break if I did?
5. Where do I look first when it's wrong?

The page shows these five questions as a self-check, with answers hidden until I open them. If the content can't support all five, the feature isn't finished. **Ownership is the bar, not description.** A beautiful animation that doesn't get me there is a failure.

## 4. Principles (non-negotiable)

**P1. Code is the source of truth. Docs are hints.**
Never present a doc's claim as fact unless the code confirms it. When doc and code disagree, that disagreement is itself a finding. (The mockup found two in a single function: §11.)

**P2. Analyze first, narrate second.**
Extract facts mechanically (entry points, import graph, call graph, data models, external services, tests, git history) before any LLM explains anything. The LLM explains facts. It doesn't discover them by wandering.

**P3. Every claim is checkable, and labeled.**
Each statement carries a file and line range and one of these labels:

| Label | Meaning |
|---|---|
| `confirmed` | Read in the code, and the citation passed the mechanical check below |
| `ran it` | Checked by actually running code (tests, a probe) in a scratch copy |
| `inferred` | A reasoned guess from structure |
| `unknown` | Can't be determined from this repo |
| `record` | Comes from history: a commit message, PR, doc, or agent log |

**Citation check:** a script verifies that the cited lines exist and contain the symbols the claim names. If the check fails, the claim drops to `inferred` automatically. The check is necessary but not sufficient: it proves the citation points at the right code, not that the claim about that code is true ("this retries on 403" passes whether or not it retries). So the check can only demote a claim, never promote one. A claim reaches `confirmed` only after a separate verifier pass reads the cited code and fails to refute it. Claims of absence ("nothing cancels the other upload", "there is no preflight") have no symbol to check, so the verifier must say what it searched to conclude the thing is absent. A confident wrong explanation is the worst possible outcome, and a narrator's voice makes wrong things sound more believable. Interaction outcomes (break-it, what-if, predict) carry labels too.

**P4. Honest about "why".**
Reasons live in commit messages, PRs, code comments, TODOs and agent logs. Mine those. If there's no evidence, say "No recorded reason found" and offer a guess labeled as one. Never invent a rationale.

**P5. Honest about the mess.**
Dead code, duplicated logic, half-finished features, and doc/code contradictions are among the most valuable things Docent surfaces. Silence about problems is a bug.

**P6. Content and rendering are separate.**
Claude writes structured content: scene specs, connection data, claims, interactions. One fixed renderer plays any conforming content. The renderer can be built and tested without an LLM.

**P7. Plain words first, real names one click away.**
Narration is written for the ear: no paths, symbols or code read aloud. The screen carries the precise names. Each feature gets one analogy before any file names ("like posting a parcel: get a label, drop it at the depot, hand in the receipt"). Simplicity never overrides correctness.

**P8. Accuracy is the product. Motion and voice are how it's delivered.**
Both are core, but no scene ships with claims that haven't passed P3.

**P9. Never touch my working tree.**
Docent explains and experiments. Anything it runs or changes happens in a scratch copy. Exercises are for me to do.

**P10. A lean, focused app, not another wall of docs.**
Docent must never feel like a README with extra steps. It follows a lean macOS design: show what matters now, and keep everything else one click away.
- **One focus at a time.** The diagram plus one line of narration fill the window. No dashboards, stat chips, legends or tab rows on the main screen.
- **The whole window is the canvas** (as in FigJam). Everything else floats above it on soft panels and collapses out of the way: the map on the left (collapses to a pill), location and search at the top center, a few buttons top right, details on the right. When a panel opens or closes, the picture re-centers in the space that's left. `[` toggles the map, `]` toggles details, and ⌘\ hides or shows all panels.
- **Progressive disclosure.** Details live in collapsed groups, popovers and sheets. Evidence is a small colored dot with a short reference, and the full label, file and snippet appear only when you click it.
- **A developer tool that's friendly to learn in.** Cool slate neutrals, crisp white surfaces, and one indigo accent; green, amber and red only when they mean something (confirmed, a guess, a problem). Each layer of the codebase has its own soft color tag (app indigo, features purple, components teal, shared blue) used the same way in the sidebar and on every map, so structure is visible at a glance. Geist for the interface and Geist Mono for code. Light and dark mode, soft shadows instead of hard borders, instant press feedback, calm motion, and respect for reduced motion.
- **A simple flow.** Overview → area → file → function, with search (⌘K) always in the middle of the toolbar. Each screen answers one question; the details panel holds the rest.
- **Test:** if a screen needs explaining, or shows something I didn't ask for yet, it's wrong.

**P11. Pick the picture that answers the question, not a bigger graph.**
Docent must not become a collection of increasingly elaborate graphs. A graph shows relationships; it doesn't always teach behavior. Each view uses the form that best answers what I'm asking right now:
- **What are the parts and their boundaries?** A map of features or areas.
- **What depends on what?** A connection graph.
- **What happens, in what order?** A step-by-step flow or sequence.
- **How does it actually work?** The code, with the lines that matter highlighted.

These are views of the same system and stay linked (click a step to open its code, click a box to see its connections), but no single view tries to show everything. Before adding nodes, edges, layers or overlays to a diagram, ask whether a different, simpler view would answer the question better. Fewer boxes that mean something beat more boxes that are merely accurate.

## 5. Zoom levels

| Level | What it shows | Connections at this level |
|---|---|---|
| System | Features and how they depend on each other | Feature → feature, shared code, external services |
| Feature | What it does, its entry points, its episode | Which flows it contains, which features it uses |
| Flow | The path a request takes, step by step | Page → handler → service → API → storage, with what travels along each arrow |
| File | Its role, its exports, who imports it | Importers, imports, framework wiring that isn't an import |
| Function | What it does, inputs and outputs, invariants, failure modes | Callers, callees, data read and written, shared helpers, tests that cover it |
| Line | A note on why this line matters | The claim and evidence behind it |

The same connection view is used at every level. Going deeper never loses where you are: a breadcrumb shows the path and each step back up is one click.

**Pre-built vs on demand.** A codebase has thousands of functions, so not everything is pre-narrated:
- **Every** file and function gets its connection data up front. This is mechanical and cheap.
- **Every** feature, and the key functions in it, gets a narrated episode up front.
- **Anything else** has an "explain this deeper" button that generates the scene, narration and claims on the spot, runs the citation check, and caches the result.

## 6. How it works (pipeline)

```
repo
 └─► 1. Extract facts          deterministic, no LLM: files, imports, CALL GRAPH, entry points,
 │                             framework wiring, data models, env/SDKs, tests→code map, git signals
 └─► 2. Discover features      LLM clusters facts into 5–15 features
 │      └─► I review the map   rename / merge / split before anything else runs
 └─► 3. Verify features        LLM, one worker per feature, in parallel; claims + citation check
 └─► 4. Merge + health         cross-feature links, duplicates, doc/code contradictions
 └─► 5. Probe (optional)       run tests / small probes in a scratch copy → "ran it" labels
 └─► 6. Write episodes         scene specs, narration, captions, interactions, exercises
 └─► 7. Build audio            voice adapter (Cartesia, Fish Audio…) per step, cached by hash
 └─► 8. Serve                  local app: Learn + Work modes, on-demand deep-dives
```

### Stage notes

**1. Extract facts.** This needs a **function-level call graph**, not only imports, because the deeper levels depend on it. Use language-aware tooling (for TypeScript: the TS compiler API or similar). Framework-implicit links (Nuxt auto-imports, file-based routing, codegen, DI) are resolved where possible. Generated files like `.nuxt/components.d.ts` are a good source. Anything unresolved is recorded as `inferred`, never dropped and never promoted. Map tests to the code they exercise, since tests are the best evidence for invariants and the engine for "ran it". Index docs and agent files (`CLAUDE.md`, `AGENTS.md`, `.wolf/`, `.cursor/`, `.codex/`, transcripts) as hint-only. Agent logs often contain pasted keys, tokens and connection strings, so run a redaction pass over them (and skip `.env*` files entirely) before anything is indexed or sent to Claude.

**2. Discover features.** A feature is something a user or operator would recognize ("Upload ID document"), not a layer ("utils"). Start from entry points. Use the call graph and co-change history for boundaries, not folder names. Shared code becomes explicit shared features. Unreachable files go to `unassigned` with a guess at why. Stable IDs that survive re-runs. **Then show me the proposed map and let me correct it.** This is the cheapest place for a human to prevent errors that would spread everywhere downstream.

**3. Verify.** One worker per feature traces it end to end, confirms or corrects its file set, sets a status (`working`, `partial`, `dead`, `unknown`), records issues, and finds the "why". Every claim goes through the citation check. A worker that can't verify something in a few reads marks it `unknown` and moves on.

**5. Probe.** Where the repo has tests, Docent can check claims by running them in a scratch copy: break a line and see which tests fail, or add a throwaway probe test to observe a path. Results get the `ran it` label, and a probe that contradicts a claim demotes or corrects it. The mockup did this twice (§11). It never touches my working tree. Probing runs before episodes are written, so narration is built only from claims that have already survived it.

**6. Write episodes.** Using the Docent persona, produce scene specs. A scene step pairs one highlight with one spoken line (~35 words, 10–15 s). A scene runs 20–45 s and carries one idea. An episode runs 2–5 minutes, and a feature that needs more gets split into sub-features. Each step names the nodes, edges and code lines to highlight, the labeled packets that move along edges, the narration, the on-screen caption, and the evidence. Predict steps pause playback until I answer.

**7. Audio.** One clip per step, cached by a hash of text + voice + settings, so changing one sentence regenerates one clip. Real clip duration drives pacing. Use a pronunciation table for code terms (passed to the provider's pronunciation dictionary when it has one).

## 7. The data contract

Write these supporting files from this brief: `tour.schema.json` (the content contract), `feature-discovery.md` (stages 1–4 with quality gates), `docent-persona.md` (voice and teaching rules for stage 5), and the audio build step.

The mockup's data shapes are a tested starting point for the schema. See the `STEPS`, `NODES`, `BREAKS`, `WHATIF`, `LINE_NOTES` and `TABS` objects in `mockups/function-view.template.html`. They cover:
- **Scene steps:** `nodes`, `edges`, `lines`, `packets [edge, label, direction]`, `say` (narration), `cap` (caption), and predict steps with options and a labeled reveal.
- **Node info:** a title, a path, and a list of claims.
- **Break scenarios:** what breaks, what gets hurt, the failure chain step by step, and what the user sees.
- **What-if menu:** each option lists the code it touches.
- **Line notes.**
- **Ownership tabs:** summary with analogy and inputs/outputs, must stay true, if you change it, when it breaks, why, health, try it.

Claims use an inline evidence markup, `[[label|file|lines]]`, that the renderer turns into clickable chips. The real schema should make evidence structured rather than inline, but keep the idea: no claim without a chip.

Shape everything so a Q&A agent could use it later (still a non-goal for now).

## 8. Constraints and decisions

**Decided**
- **Local app.** Started with one command, opened in the browser. It needs a local server because "explain this deeper" generates content on demand. A static export of the pre-built tour is a nice-to-have later.
- **No LLM needed to view pre-built content.** Only on-demand deep-dives call Claude.
- The health report is its own view and an overlay on the system map.
- A feature too large for one episode is split into sub-features, not longer scenes.

**Stack (decided)**
- **TypeScript on Node 22+**, as a pnpm workspace (`packages/*`), run with `tsx`, tested with Vitest.
- **Extraction:** `ts-morph` (the TypeScript compiler API) for symbols, imports, and a function-level call graph resolved by the type checker. Vue single-file components are next (via `@vue/compiler-sfc`), then tree-sitter for other languages. History comes from the `git` CLI.
- **Cache:** facts and stage outputs live in `~/.docent/repos/<repo>/`, keyed by content hash. Nothing is ever written into the analyzed repo.
- **LLM stages:** one `packages/llm` interface with two ways in. **Your Claude subscription** (default): Docent drives your own Claude Code CLI headlessly (`claude -p`, structured JSON output, read-only tools). **An API key** (optional): the Anthropic SDK with Zod-validated structured output. Every stage asks for a Zod schema and never knows which path ran. `docent doctor` shows which one is active.
- **Local app:** a small Hono server (API plus server-sent events for on-demand deep-dives, file watching), and React plus Vite for the UI. **React Flow** for every diagram (pan, zoom, custom HTML nodes, animated links), ELK.js for automatic layout, Motion for springs, Shiki for code, and Phosphor icons. Use a proven library whenever one makes the work easier and better.
- **Voice:** pluggable through a `VoiceAdapter` interface. The first adapters are Cartesia and Fish Audio, and any provider can be added. Clips are cached by hash, and keys come from the environment (`CARTESIA_API_KEY`, `FISH_AUDIO_API_KEY`).
- **Later, optional:** a Tauri shell for a real macOS window.

**Ask me before**
- Adding any service beyond Claude and the voice providers (Cartesia, Fish Audio).
- Sending my source code anywhere other than Claude.

**Secrets and privacy**
- Voice provider keys come from the environment. It must never be written into a repo, content file, log, or served page.
- Voice providers receive narration text only, never source code.
- No claim, caption or narration line may quote a secret found in the repo or its agent logs. Redaction happens in stage 1, and the citation check rejects any snippet that still matches a secret pattern.
- Note: the Cartesia MCP in my setup currently answers "Invalid API key" for speech (listing voices works). Fix the key before M5.

**Voice:** one consistent narrator: calm, direct, a bit opinionated ("this part is solid", "this part I wouldn't trust"). Any provider and voice can be plugged in. Starting candidate: Cartesia "Ricardo" (`8499aae3-022c-4d55-8283-0c2e8adbefb4`). Never use the browser's built-in text-to-speech.

## 9. Freshness

A tour that goes stale becomes another outdated README.
- Record the analyzed commit and show it in the app, along with whether the working tree has moved on.
- Hash each feature's and function's code. On change, re-verify and re-narrate only what changed.
- Freeze the feature map after the first run (with my edits). Re-discover only when entry points change, or when I ask.
- Cache every LLM stage and every audio clip by a hash of its inputs. A re-run on an unchanged repo makes no LLM or TTS calls.
- While the app is running, watch for file changes and mark affected views as stale. This matters because I'll use Work mode while editing.

## 10. Test repos

**First: `~/Documents/code/skaletek/kyc-site-main`.** React 18 + Vite + TypeScript, ~220 source files, ~470 commits.
- It has descriptive commit messages that explain *why* (good for P4).
- It has real tests (`vitest`), so `ran it` probes work.
- It has an `ARCHITECTURE.md`, feature READMEs, and agent files (`CLAUDE.md`, `AGENTS.md`, `.wolf/`), all hint-only.
- Its imports are explicit, so the call graph should be mostly confirmable.

The mockup is built on this repo.

**Second: `~/Documents/code/drawam`.** A pnpm monorepo (`apps/`, `packages/`), Vue plus a server, payments, LiveKit voice, ~1,480 source files, ~250 commits with unusually detailed messages. This is the harder test: several apps, a server boundary, and more framework wiring. Treat drawam as "one app at a time" first.

## 11. What the mockup already proved

`mockups/function-view.html` is the function view for `submitDocument()` in kyc-site-main (`src/shared/services/applicant-api/document-submission.ts`), built by hand from real tracing. Open it by double-clicking. It shows:

- The layout is lean and macOS-style: a sidebar, a canvas, and an inspector you can hide. A floating playback bar, a health badge in the toolbar, and sheets for code and evidence.
- Learn mode: an 8-step episode. The canvas shows only the diagram, with labeled data moving along arrows, and one line of narration. The inspector shows just the code for the current step. One step stops and asks you to predict before revealing.
- Work mode: click any box to see what it is and how it connects. For storage and the API, "What if this fails?" shows how the failure spreads. The function's details (must stay true, if you change it, when it breaks, why, try it) sit in collapsed groups.

Findings the tracing turned up, which are what Docent should find on its own:
- **Docs wrong (confirmed):** `ARCHITECTURE.md:81-84` describes a "preflight" step and an old file path. The code has neither. The services README agrees with the code.
- **Docs wrong (confirmed):** `src/shared/services/README.md:40` names `DocumentUploadError`. That class was removed in commit `0301b21`, when the storage helpers moved to `storage-upload.ts`, and `StorageUploadError` replaced it.
- **Worth knowing (confirmed behavior, inferred impact):** when one side's upload fails, nothing cancels the other side's upload.
- **Why, from history (record):** the submission key exists because an audit found repeated submissions (commit `da1cb63`).
- **Ran it:** removing the key on line 164 makes exactly one test fail (1 failed, 8 passed). Storage refusing twice gives two presign calls, no submit, then `StorageUploadError 403`. Both were run in a scratch copy, so the repo was untouched.

The mockup is hand-written content. The job is to make Docent **produce content of this quality by itself**, for any function, with the same honesty.

## 12. Build order

Thin vertical slices, each one demonstrable. Accuracy is proven before polish, but motion and voice come early because they're the point.

**M0 (done): Hand-built function view.** `mockups/function-view.html`.

**M1: Facts for kyc-site-main.** Files, imports, function-level call graph, entry points, tests→code map, git signals, docs index.
*Done when:* for `submitDocument`, the extracted callers, callees and covering tests match what the mockup shows, and unresolved links are marked `inferred`.

**M2: Work-mode skeleton, no LLM.** The local app renders the zoom levels from facts alone: system map from the graph, file and function connection views, the code, and breadcrumbs.
*Done when:* I can click from the system map down to any function and see its real connections.

**M3: Claims, features, health.** Feature discovery with my review step, verification workers, the citation check, the health report.
*Done when:* every claim has evidence, the citation check demotes bad citations, and the health report finds the two doc problems in §11 without being told.

**M4: Episodes (Learn mode).** Scene-spec generation and the player: highlights, moving packets, captions, predict, step-through, zoom from flow into code. Placeholder timing from word count.
*Done when:* a generated episode for the document-upload feature is at least as clear and accurate as the hand-built mockup.

**M5: Voice.** Pluggable voice adapters (Cartesia and Fish Audio first), audio per step, hash-cached, with pacing from real durations and a pronunciation table.
*Done when:* the episode plays with real narration, changing one sentence regenerates one clip, and no secret appears in any output.

**M6: Work-mode depth.** What-if, break-it, debug-from-symptom, exercises, `ran it` probes in a scratch copy, and "explain this deeper" on demand.
*Done when:* I can pick any function, get a narrated deep-dive within a reasonable wait, and every outcome carries a label.

**M7: Freshness.** Hashing, stage caching, incremental re-runs, and file watching while the app runs.
*Done when:* editing one function re-generates only what depends on it, and an unchanged re-run makes no LLM or TTS calls.

**M8: drawam.** Run the whole thing on the second repo, one app at a time, and fix what breaks.

## 13. How to know it's good

Pick a feature in a test repo I don't understand well:
- Watch its episode. Can I answer the five questions?
- Do its exercise. Did the code behave the way Docent said it would?
- Spot-check ten claims chosen at random, including at least three `inferred` and one interaction outcome. Are all the `confirmed` ones right? Was every guess labeled as one?
- Use Work mode to make a real change. Did "if you change it" list everything that actually broke?
- Use "when it breaks" on a real bug. Did it point to the right place first?
- Does the health report catch at least one real problem I didn't know about?
- Does it invent a "why" anywhere without evidence? (That's a P4 violation. Fix it.)
- Is any scene longer than ~45 seconds or carrying more than one idea?

If an explanation is smooth but wrong, that's worse than no explanation. When in doubt, favor accuracy over fluency.

## 14. Non-goals (for now)

- Editing or refactoring my code. Docent explains and experiments in scratch copies only.

- Hosting, accounts, or sharing.
- Perfect support for every language on day one. TypeScript (React, Vue, Node) first.

## 15. Open questions

- **Wait time for "explain this deeper":** generating claims, narration and audio for an unseen function takes time. What's acceptable: 20 seconds, a minute? Should Docent pre-generate deep-dives for all functions in a feature in the background after the first episode?
- **Cost ceiling:** a full first run on drawam could be expensive. Should there be a budget per run, with a preview of the estimate?
- **Agent logs:** kyc-site-main and drawam both have `.wolf/`, `.claude/`, `.codex/` and `.cursor/` folders. Which of these hold real session history worth mining for "why"?
- **Existing tools:** a quick look at what DeepWiki, CodeSee-style maps and code-tour tools do well or badly, before M4, so we learn from them instead of rebuilding them.

---

*Name: **Docent**: one who guides you through the collection, explains why each piece matters, and tells you which one is a forgery.*
