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
