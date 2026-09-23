import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import nextConfig from "../next.config";

const SRC_DIR = path.join(__dirname);

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
      const content = fs.readFileSync(file, "utf8");

      for (const term of FORBIDDEN_TERMS) {
        expect(
          content.includes(term),
          `${file} contains forbidden network term "${term}"`,
        ).toBe(false);
      }
    }
  });
});
