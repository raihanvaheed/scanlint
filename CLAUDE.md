@AGENTS.md

# Working agreement

- Never run `git add`, `git commit`, or `git push`. Commits are checkpoints the repository owner declares after reviewing the work.
- Stop when the described change is complete, then write the pull request description as set out below.
- Record every decision you had to make that the instructions did not specify.
- If an instruction cannot be followed as written, stop and report why. Do not substitute your own approach.
- Do not add features, refactors, or improvements that were not asked for.

# Project invariants

These hold for every change, permanently.

- **File contents never leave the browser.** No network request may ever carry file data. No analytics, telemetry, error reporting, logging services, or third-party scripts may be added anywhere in the application. The privacy statement in the README must remain literally true.
- **Static export only.** `output: "export"` in `next.config.ts` is permanent. No API routes, middleware, rewrites, redirects, or server-side rendering.
- **`README.md` and `LICENSE` are owner-edited.** Do not modify them unless an instruction explicitly says to.

# Pull request description

At the end of every step, fill in `.github/pull_request_template.md` completely and save the result as `.pr-description.md` at the repository root.

- Do not modify the template itself.
- Answer every section. Write "None" where nothing applies. Do not delete sections, except Screenshots on steps with no visible change.
- Paste real command output in Acceptance checks, Invariants and Build status. Never paraphrase or summarise output.
- Include any step-specific checks the prompt asks for under Acceptance checks.
- Leave the Reviewer checklist unticked. It belongs to the repository owner.
- `.pr-description.md` is gitignored and must never be committed.
- Your final message in the session is the full contents of `.pr-description.md`.
