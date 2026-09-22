<!--
Filled by Claude Code at the end of every step and saved to .pr-description.md,
which is gitignored. Paste that file here, or use:
  gh pr create --base main --body-file .pr-description.md

The reviewer checklist at the bottom is for the repository owner.
-->

## Step

<!-- Plan step number and name, e.g. "1.3 — Parser and recursive walker". -->

## Summary

<!-- Two or three sentences: what this PR does and why. -->

## Changes

<!-- Every file created, modified or deleted, from `git status --short`, one line each with a short reason. -->

## Decisions not specified by the prompt

<!-- Every choice made that the prompt did not dictate. Write "None" only if there were genuinely none. -->

## Deviations from the prompt

<!-- Anything done differently from what the prompt said, and why. Write "None" if none. -->

## Acceptance checks

<!-- Each check from the prompt: the command run and its actual output. Paste real output. Do not paraphrase. -->

## Tests

<!-- Tests added or changed, what each covers, and the full test run result with passed, failed and skipped counts. Before step 0.2, write "Not yet configured". -->

## Review focus

<!-- Where bugs are most likely to hide in this diff. Start from the plan's review focus for this step, then add anything discovered while working. -->

## Invariants

<!-- Answer each with evidence, not a tick. -->

**Network surface.** Output of:

```
grep -rnE "fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource" src
```

Must be empty. Any hit must be explained.

**Dependencies.** Every package added, removed or upgraded, from `git diff main -- package.json`, with the reason for each. "None" if unchanged.

**Static export.** Confirm `next.config.ts` still has `output: "export"`, and that no API routes, middleware, rewrites or redirects were added.

**Owner files.** Output of `git diff main -- README.md LICENSE`. Must be empty unless this step explicitly edits them.

## Build status

- `pnpm lint`:
- `npx tsc --noEmit`:
- `pnpm test`:
- `pnpm build`:

## Screenshots

<!-- UI steps only. Delete this section on steps with no visible change. -->

## Known issues and follow-ups

<!-- Anything left incomplete, fragile, or worth revisiting later. Write "None" if none. -->

---

## Reviewer checklist

- [ ] Read the review focus and checked those parts of the diff
- [ ] Ran the acceptance checks locally
- [ ] Every decision and deviation is acceptable
- [ ] Network surface and dependency changes are acceptable
- [ ] CI is green
- [ ] Checked the preview deployment, if anything visible changed
