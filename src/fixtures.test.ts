import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(ROOT, "fixtures", "single.manifest.json");
const DICOM_REL = "public/samples/single.dcm";
const DICOM_PATH = path.join(ROOT, DICOM_REL);

interface Manifest {
  manifestVersion: number;
  files: { file: string; sha256: string }[];
}

function readManifest(): Manifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

describe("single-file fixture integrity", () => {
  it("manifest parses as JSON and has manifestVersion 1", () => {
    expect(readManifest().manifestVersion).toBe(1);
  });

  it("DICOM file exists and its SHA-256 matches the manifest", () => {
    expect(fs.existsSync(DICOM_PATH)).toBe(true);

    const entry = readManifest().files.find((f) => f.file === DICOM_REL);
    expect(entry, `manifest has no entry for ${DICOM_REL}`).toBeDefined();

    const digest = crypto
      .createHash("sha256")
      .update(fs.readFileSync(DICOM_PATH))
      .digest("hex");
    expect(digest).toBe(entry?.sha256);
  });

  it("first 132 bytes are a 128-byte preamble followed by ASCII DICM", () => {
    const head = Buffer.alloc(132);
    const fd = fs.openSync(DICOM_PATH, "r");
    let bytesRead: number;
    try {
      bytesRead = fs.readSync(fd, head, 0, 132, 0);
    } finally {
      fs.closeSync(fd);
    }

    expect(bytesRead).toBe(132);
    expect(head.subarray(128, 132).toString("ascii")).toBe("DICM");
  });
});
