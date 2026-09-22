@AGENTS.md

# Working agreement

- Never run `git add`, `git commit`, or `git push`. Commits are checkpoints the repository owner declares after reviewing the work.
- Stop when the described change is complete. Report what changed, file by file.
- List every decision you had to make that the instructions did not specify.
- If an instruction cannot be followed as written, stop and report why. Do not substitute your own approach.
- Do not add features, refactors, or improvements that were not asked for.

# Project invariants

These hold for every change, permanently.

- **File contents never leave the browser.** No network request may ever carry file data. No analytics, telemetry, error reporting, logging services, or third-party scripts may be added anywhere in the application. The privacy statement in the README must remain literally true.
- **Static export only.** `output: "export"` in `next.config.ts` is permanent. No API routes, middleware, rewrites, redirects, or server-side rendering.
- **`README.md` and `LICENSE` are owner-edited.** Do not modify them unless an instruction explicitly says to.
