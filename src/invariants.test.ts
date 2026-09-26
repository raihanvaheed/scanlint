import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import nextConfig from "../next.config";

const SRC_DIR = path.join(__dirname);
const ROOT = path.resolve(__dirname, "..");

// The only source file allowed to use a network API. See the assertions at the bottom.
const NETWORK_ALLOWLIST = ["src/lib/load-sample.ts"];

const FORBIDDEN_TERMS = [
  "fetch(",
  "XMLHttpRequest",
  "sendBeacon",
  "WebSocket",
  "EventSource",
];

function listSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...listSourceFiles(fullPath));
      continue;
    }

    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;

    files.push(fullPath);
  }

  return files;
}

describe("project invariants", () => {
  it("next.config.ts declares a static export", () => {
    expect(nextConfig.output).toBe("export");
  });

  it("no source file touches the network", () => {
    const files = listSourceFiles(SRC_DIR);

    for (const file of files) {
      if (NETWORK_ALLOWLIST.includes(path.relative(ROOT, file).split(path.sep).join("/"))) continue;

      const content = fs.readFileSync(file, "utf8");

      for (const term of FORBIDDEN_TERMS) {
        expect(
          content.includes(term),
          `${file} contains forbidden network term "${term}"`,
        ).toBe(false);
      }
    }
  });

  describe("the import boundary around the worker", () => {
    const UI_DIRS = ["src/app", "src/components"];
    const importSpecifiers = (content: string) =>
      [...content.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
    const isWorkerOnly = (spec: string) =>
      spec === "dicom-parser" ||
      ["walk", "handle", "phi", "dictionary"].includes(spec.split("/").pop()!.replace(/\.[jt]sx?$/, ""));
    const filesIn = (dirs: string[]) => dirs.flatMap((dir) => listSourceFiles(path.join(ROOT, dir)));

    it("no file under src/app or src/components imports the parser, the rules, or the dictionary", () => {
      for (const file of filesIn(UI_DIRS)) {
        const offending = importSpecifiers(fs.readFileSync(file, "utf8")).filter(isWorkerOnly);
        expect(
          offending,
          `${path.relative(ROOT, file)} imports ${offending.join(", ")}. The page must not load the ` +
            "parser, the rules or the 5,000-entry dictionary: they belong in the worker, so that " +
            "the first screen stays small and file contents are only ever handled off the main thread.",
        ).toEqual([]);
      }
    });

    it("nothing outside a test refers to dictionary-keywords", () => {
      const scanned = filesIn(["src/app", "src/components", "src/parse", "src/model", "src/rules", "src/lib"]);
      expect(scanned.length).toBeGreaterThan(0);
      for (const file of scanned) {
        expect(
          fs.readFileSync(file, "utf8").includes("dictionary-keywords"),
          `${path.relative(ROOT, file)} refers to dictionary-keywords. That file is test data (Part 6 ` +
            "keywords, about 230 KB) and exists only so tests can check names against the fixture manifest. " +
            "If the app imports it, it ships to every visitor.",
        ).toBe(false);
      }
    });

    it("the import check does catch a forbidden import (guards against it going blind)", () => {
      const source = 'import x from "../model/dictionary";\nimport y from "dicom-parser";\nconst z = await import("../parse/walk");\nimport t from "../model/tree";';
      expect(importSpecifiers(source).filter(isWorkerOnly)).toEqual(["../model/dictionary", "dicom-parser", "../parse/walk"]);
    });
  });

  describe("the one network exception", () => {
    const allowlisted = NETWORK_ALLOWLIST.map((file) => ({
      file,
      content: fs.readFileSync(path.join(ROOT, file), "utf8"),
    }));

    it("is a single file", () => {
      expect(
        NETWORK_ALLOWLIST.length,
        "The network allowlist must have exactly one entry. An allowlist that can grow silently " +
          "is not an allowlist: every extra file is a place file contents could be sent from, " +
          "so adding one needs a deliberate change to this test that a reviewer will see.",
      ).toBe(1);
    });

    it("contains exactly one fetch call", () => {
      for (const { file, content } of allowlisted) {
        expect(
          content.split("fetch(").length - 1,
          `${file} must contain exactly one "fetch(". It exists only to load the bundled sample; ` +
            "a second call is a second place that could send data, and this file is exempt from the scan.",
        ).toBe(1);
      }
    });

    it("only ever makes a single-argument GET of a bundled sample, using no other network API", () => {
      for (const { file, content } of allowlisted) {
        expect(
          /fetch\(\s*["']\/samples\/[A-Za-z0-9._-]+\.dcm["']\s*\)/.test(content),
          `${file} must call fetch with exactly one string literal, a same-origin /samples/*.dcm path, ` +
            "and nothing else. The closing parenthesis directly after the literal is deliberate: a " +
            "second argument is how a request gains a method or a body, which is how data leaves the browser.",
        ).toBe(true);

        for (const term of FORBIDDEN_TERMS.filter((t) => t !== "fetch(")) {
          expect(
            content.includes(term),
            `${file} contains "${term}". The exception covers one fetch call for the bundled ` +
              "sample and no other network API.",
          ).toBe(false);
        }
      }
    });
  });
});
