# Docent

Docent takes you through a codebase. Pick a flow, such as "upload a document" or "sign in", and Docent draws it on a whiteboard from the real code. Then it walks you through it, card by card: one request from start to end, what happens when it goes wrong, and why it's built that way. It's a better way in than reading a stack of README files.

Every claim Docent shows carries evidence (the file and lines it came from) and a label that says how sure it is:

| Label | Meaning |
| --- | --- |
| **confirmed** | The cited code says so, and a second reader with no other context couldn't refute it. |
| **inferred** | Reasoned from the code, but not proven. |
| **record** | From the project's history (a commit message, a doc). |
| **unknown** | Docent couldn't back it up. |

## Quick start

From the project you want to understand:

```bash
npx @whytepeter/docent
```

Docent reads the code, opens in your browser at `http://127.0.0.1:4477` and shows what the project does and the flows worth learning. You can also give it a path (`npx @whytepeter/docent ~/code/my-app`), or open a GitHub link or a `.zip` from the welcome page.

To install it once and use `docent` everywhere:

```bash
npm install -g @whytepeter/docent
```

### What it needs

- **Node.js 22** or newer, and **git**.
- **An AI provider.** Docent uses one you already have:
  - **Claude Code** on a Claude Pro or Max plan. [Install it](https://docs.claude.com/en/docs/claude-code/setup), then run `claude` once to sign in.
  - **Codex** on a ChatGPT plan: `npm install -g @openai/codex`, then `codex login`.
  - **An Anthropic API key** (pay per use), pasted in Settings → AI.

Run `docent doctor` to see which provider Docent will use and whether it's signed in.

### Voice (optional)

Docent can read the tour aloud. In Settings → Voice, choose:

- **Kokoro**: runs on your computer. One download (about 110 MB of weights, plus the onnxruntime package) and nothing leaves your machine after that.
- **Cartesia** or **Fish Audio**: cloud voices. Paste your API key in Settings.

Without a voice, the tour plays as text at reading pace.

## What stays on your machine

- Docent runs a local server bound to `127.0.0.1` only. It never writes to your repo. Everything it makes (facts, boards, answers, audio) lives in `~/.docent/`.
- It sends code to the AI provider you chose, as your own Claude Code or Codex session would. Before anything is sent, secrets are redacted (keys, tokens, private keys, passwords in config). The AI can't open `.env` files, keys or agent session folders.
- Narration text (never code) goes to the cloud voice, if you pick one.
- API keys you paste in Settings are saved in `~/.docent/.env`, readable only by you.

## Commands

```text
docent                     open the app for the current folder
docent <repo>              open the app for a repo
docent --port <n>          use another port than 4477
docent doctor              check which AI provider Docent uses
docent extract <repo>      read the repo and save its facts (no AI)
docent fn <repo> <name>    show a function's callers, callees and tests
docent stats <repo>        summarize the saved facts
```

## Languages

TypeScript and JavaScript (React, Node, and similar) are supported today; the call graph comes from the TypeScript compiler. Vue single-file components and other languages are on the [roadmap](docs/roadmap.md).

## Develop

```bash
git clone https://github.com/whytepeter/docent.git
cd docent
pnpm install
pnpm dev
```

`pnpm dev` runs the API on port 4477 and the web app on 5173 (it proxies `/api`). Open a codebase from the welcome page. See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout and the checks.

## License

[MIT](LICENSE)
