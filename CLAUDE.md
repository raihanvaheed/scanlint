@AGENTS.md

# CLAUDE.md

## What this is

ScanLint is a browser-based inspector for DICOM medical imaging files. It reads a scan's metadata, shows every field at every depth, and flags the ones that could identify a patient. It must never transmit file contents anywhere.

## Commands

Run these yourself. Never assume a check passes.

- Install: `pnpm install`
- Dev: `pnpm dev`
- Test: `pnpm test` — single file: `pnpm vitest run src/path/to/file.test.ts`
- Lint: `pnpm lint`
- Types: `pnpm typecheck`
- Build: `pnpm build`
- Deploy dry run: `npx wrangler deploy --dry-run`
- Regenerate fixtures: `python3 scripts/make-sample-study.py`

`typecheck` runs `next typegen` before `tsc` because `LayoutProps` and `PageProps` are generated into `.next/types` and do not exist on a fresh checkout.

## Architecture

Only what the file tree does not already show.

- `scripts/make-sample-study.py` writes both `public/samples/*.dcm` and `fixtures/*.manifest.json` from **one** declarative list of planted items. The manifest is the test oracle for the parser and rules engine. Never hand-edit a manifest, and never let the file-writing and manifest-writing paths diverge — a drifted manifest silently invalidates every test in the project.
- Tag paths are the project's universal identifier for a location in a dataset: tag segments are 8 lowercase hex characters, sequence item segments are zero-based indices, joined by `/` (e.g. `04000561/0/04000550/0/00080090`). The walker, the rules engine, the manifest and the UI all use this exact format. A finding identified by tag number alone is a bug — the same tag occurs at several depths.
- Tag numbers appear in several textual forms (`(0010,0010)`, `00100010`, `x00100010`, mixed case). Every comparison goes through one normalisation function. A raw string comparison anywhere is a silent detection failure.
- Parsing runs in Web Workers, never on the main thread. Metadata parsing stops before the pixel data tag `(7FE0,0010)`; pixel data is read only when a specific slice is displayed. This split is why a several-hundred-megabyte series can be scanned in seconds, and it must not be collapsed for convenience.
- `wrangler.jsonc` deliberately has **no** `main` field. Its absence is what tells Wrangler this is a static-assets deployment and stops it detecting Next.js and reaching for the OpenNext adapter.

## Invariants

Permanent. A change that breaks one is wrong even if it works and the tests pass.

- File contents never leave the browser. No request may carry user data. No analytics, telemetry, error reporting, logging services, or third-party scripts anywhere in the application. The privacy statement in the README must remain literally true. `src/invariants.test.ts` enforces this — never weaken its term list or its file scan.
- Static export only. `output: "export"` in `next.config.ts` is permanent. No API routes, middleware, rewrites, redirects, or server-side rendering.
- Sample data is synthetic and generated. Never commit a real DICOM file, and never commit a file obtained from a patient, a hospital, or a clinical dataset.
- `README.md`, `LICENSE` and `.github/pull_request_template.md` are owner-edited. Do not modify them unless an instruction says to.
- Secrets live in `.env` and never appear in output, logs, tests, fixtures, or committed files.

## Conventions

Only the ones the existing code does not already demonstrate.

- Fixture generation is deterministic. Fixed seeds, fixed UID constants, fixed dates. Never `generate_uid()` without arguments, never `datetime.now()`. Running the generator twice must produce byte-identical output.
- Dark theme only. There is no light mode and no `prefers-color-scheme` branching. Colour tokens are declared in `src/app/globals.css`.
- A new dependency needs approval first. Prefer the standard library and what is already here. In a privacy-sensitive tool every added package is a potential exfiltration path, so each one is named and justified in the PR description.

## Working agreement

- Never run `git add`, `git commit`, `git push`, or anything that rewrites history or discards work
  (`git reset --hard`, `git checkout -- .`, `git clean`, `--amend`). Commits are checkpoints the owner
  declares after reviewing the work.
- Do the described change, then stop. No unrequested features, refactors, renames, dependency bumps,
  or formatting sweeps.
- Read a file before editing it. Search for an existing helper before writing a new one.
- If an instruction cannot be followed as written, stop and report why. Do not substitute your own approach.
- If the task turns out to be larger or different from how it was described, stop and say so before continuing.
- Record every decision you had to make that the instructions did not specify.
- Never weaken a check to make it pass: no edited assertions, deleted or skipped tests, `any`,
  `# type: ignore`, `--no-verify`, or mocked-away failures. A failing check is a finding. Report it.
- Breakage you find that is unrelated to the task: report it, do not fix it.
- Leave nothing behind: no dead code, commented-out blocks, scratch files, or debug logging.

## Definition of done

Before the final message, all of these are true.

1. The change is complete and scoped to exactly what was asked.
2. Test, lint, type and build commands were run, and their real output is included.
3. New behaviour has a test that fails without the change.
4. No invariant was weakened.
5. Unspecified decisions and open questions are written down.

## Final message

Fill in `.github/pull_request_template.md` completely and save the result as `.pr-description.md` at the
repository root. Do not modify the template. Answer every section, writing "None" where nothing applies;
do not delete sections, except Screenshots on steps with no visible change. Paste real command output in
Acceptance checks, Invariants and Build status; never paraphrase or summarise it. Include any
step-specific checks the prompt asks for under Acceptance checks. Leave the reviewer checklist unticked —
it belongs to the repository owner. `.pr-description.md` is gitignored and must never be committed. Your
final message in the session is the full contents of that file.

Never state that something works if you did not run it.