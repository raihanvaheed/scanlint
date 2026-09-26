import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { basicProfileAction, lookupAnnexE } from "./annex-e";
import { normalizeTag } from "./tag";
import type { Finding } from "./types";

const MANIFEST_PATH = path.resolve(__dirname, "../../fixtures/single.manifest.json");

type Manifest = { files: { file: string; expectedFindings: Finding[] }[] };

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
const annexEFindings = manifest.files.flatMap((f) =>
  f.expectedFindings.filter((finding) => finding.kind === "annex-e"),
);

// The manifest's actions were hand-declared in the generator; the table's come from
// the standard's own XML. A disagreement means one of them is wrong.
describe("fixture manifest agrees with the extracted Annex E table", () => {
  it("has annex-e findings to check", () => {
    expect(annexEFindings.length).toBeGreaterThan(0);
  });

  it("every annex-e finding's tag exists in the table", () => {
    const missing = annexEFindings
      .filter((finding) => lookupAnnexE(normalizeTag(finding.tag)) === undefined)
      .map((finding) => `${finding.path} (${finding.keyword ?? finding.tag})`);
    expect(missing).toEqual([]);
  });

  it("every annex-e finding's action equals the table's basic profile action", () => {
    const disagreements = annexEFindings
      .map((finding) => ({
        path: finding.path,
        keyword: finding.keyword ?? finding.tag,
        manifest: finding.action,
        table: basicProfileAction(normalizeTag(finding.tag)),
      }))
      .filter((row) => row.manifest !== row.table)
      .map(
        (row) =>
          `${row.path} ${row.keyword}: manifest ${String(row.manifest)} vs table ${String(row.table)}`,
      );
    expect(disagreements).toEqual([]);
  });
});
