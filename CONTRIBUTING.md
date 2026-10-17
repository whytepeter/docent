# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome. For anything larger than a fix, open an issue first so we can agree on the shape before you build it.

## Set up

You need Node.js 22+, pnpm 10 (`corepack enable` gives you the right one), git, and an AI provider signed in (see the [README](README.md#what-it-needs)).

```bash
pnpm install
pnpm dev
```

`pnpm dev` runs the API on 4477 and the web app on 5173. To run a second copy beside one you're using, set `DOCENT_PORT` (and point Vite at it with `DOCENT_API_PORT`).

## Layout

```text
apps/web          the React app (the welcome page, a project's home, the board, chat, settings)
apps/server       the local Hono server: workspace, flows and boards, chat, voice, settings
packages/extract  facts from the code without AI: files, symbols, call graph, tests, git history, docs
packages/analyze  the AI stages: overview, flows, boards, chat, the citation check and the second reader
packages/llm      one interface over Claude Code, Codex and the Anthropic API, plus secret redaction
packages/voice    voice adapters: Kokoro (local), Cartesia and Fish Audio
packages/cli      the `docent` command, and the npm package that bundles everything
docs/             the design (what and why) and the roadmap (what's built, what's next)
```

Code is organized by feature: `app → features → shared`, with one `index.ts` per feature.

## Rules that keep Docent honest

- **Never write to the analyzed repo.** Docent's own outputs live in `~/.docent/repos/<repo>/`.
- **Every claim shown to the user carries evidence and a label** (confirmed, inferred, record, unknown). If it can't be backed up, it says so.
- **No secrets leave the machine.** Prompts go through `redact()`, and providers can't read the files in `SECRET_FILES`.
- **Keep it plain.** Short sentences, everyday words, the real names one click away.

## Checks

Run these before you open a pull request. CI runs the same three.

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Releasing (maintainers)

```bash
pnpm build
cd packages/cli
npm publish --access public
```

`pnpm build` builds the web app, then bundles the CLI, the server and the packages into `packages/cli/dist`. Try the package before publishing: `npm pack`, then `npm install` the tarball in an empty folder and run `npx docent` inside a project.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
