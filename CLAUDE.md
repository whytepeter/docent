# Docent

Read `DOCENT-BRIEF.md` (what and why) and `PLAN.md` (how, milestone by milestone) before working here.

## Rules

- **No AI attribution.** Never add Claude (or any AI) as a co-author, collaborator or contributor. No `Co-Authored-By:` trailers, no "Generated with Claude Code" lines, no AI credit in commit messages, PR descriptions, changelogs, file headers or docs.
- Commit only when asked.
- Never write to an analyzed repo. Docent's own outputs live in `~/.docent/repos/<repo>/`.
- Keep the feature-based structure: `app → features → shared`, one `index.ts` per feature.
- Every claim shown to the user carries evidence and a label (confirmed, ran it, inferred, unknown, record).
