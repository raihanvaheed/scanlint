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

    // Resolves one relative import specifier to the file it names, the way node/TS module
    // resolution would - only relative specifiers are followed; a bare package name (dicom-parser,
    // react, ...) has no file of ours to walk into.
    const resolveImport = (fromFile: string, spec: string): string | undefined => {
      if (!spec.startsWith(".")) return undefined;
      const base = path.resolve(path.dirname(fromFile), spec);
      const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.json`, path.join(base, "index.ts")];
      return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    };

    // Every file reachable from `entryFiles` by following relative imports, transitively - the
    // actual graph a bundler would walk, not just each file's own direct imports.
    const collectImportGraph = (entryFiles: string[]): Set<string> => {
      const visited = new Set<string>();
      const queue = entryFiles.map((f) => path.resolve(f));

      while (queue.length > 0) {
        const file = queue.pop()!;
        if (visited.has(file)) continue;
        visited.add(file);
        if (!/\.tsx?$/.test(file)) continue;

        const content = fs.readFileSync(file, "utf8");
        for (const spec of importSpecifiers(content)) {
          const next = resolveImport(file, spec);
          if (next !== undefined && !visited.has(next)) queue.push(next);
        }
      }

      return visited;
    };

    const relOf = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

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

    // A positive control for collectImportGraph itself, over the same root the test below uses:
    // src/parse genuinely does reach the dictionary (handle.ts) and annex-e (via rules/phi.ts), so
    // if the traversal ever stopped following imports, this would fail rather than letting the
    // tests below pass vacuously.
    it("the transitive graph walker does find the dictionary from src/parse (guards against it going blind)", () => {
      const graph = [...collectImportGraph(listSourceFiles(path.join(ROOT, "src/parse")))].map(relOf);
      expect(graph).toContain("src/model/dictionary.ts");
      expect(graph).toContain("src/model/annex-e.ts");
    });

    // src/pixels re-parses the file with dicom-parser directly, on purpose (see 3.2). It must never
    // need the 604 KB dictionary or the Annex E rules to turn bytes into pixels - and, looking
    // ahead to 3.5, it must never need a codec either, in the other direction.
    it("nothing reachable from src/pixels is the dictionary, annex-e, or a rule", () => {
      const graph = collectImportGraph(listSourceFiles(path.join(ROOT, "src/pixels")));
      const offending = [...graph]
        .map(relOf)
        .filter((rel) => rel === "src/model/dictionary.ts" || rel === "src/model/dictionary.json" || rel === "src/model/annex-e.ts" || rel === "src/model/annex-e.json" || rel.startsWith("src/rules/"));

      expect(
        offending,
        `src/pixels reaches ${offending.join(", ")}. The image path must stay independent of the ` +
          "standards tables and the PHI rules - pulling them in defeats the point of keeping them out.",
      ).toEqual([]);
    });

    it("nothing reachable from the metadata parser is src/pixels", () => {
      const graph = collectImportGraph(listSourceFiles(path.join(ROOT, "src/parse")));
      const offending = [...graph].map(relOf).filter((rel) => rel.startsWith("src/pixels/"));

      expect(
        offending,
        `the metadata parser reaches ${offending.join(", ")}. src/pixels re-parses the file on its ` +
          "own; the metadata path must not depend on the pixel-decoding path (or, from 3.5, its codecs).",
      ).toEqual([]);
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
