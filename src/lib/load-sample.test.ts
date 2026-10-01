import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadBurnedInSample, loadSample } from "./load-sample";

const fixture = new Uint8Array(fs.readFileSync(path.resolve(__dirname, "../../public/samples/single.dcm")));
const burnedInFixture = new Uint8Array(fs.readFileSync(path.resolve(__dirname, "../../public/samples/burned-in.dcm")));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadSample", () => {
  it("resolves with the fixture's bytes as an ArrayBuffer, from one same-origin request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(fixture));
    vi.stubGlobal("fetch", fetchMock);

    const bytes = await loadSample();

    expect(bytes).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(bytes)).toEqual(fixture);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/samples/single.dcm");
  });

  it("throws a clear error when the response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 404 })));

    await expect(loadSample()).rejects.toThrow("Could not load the sample file: the server answered 404.");
  });

  it("throws a clear error when fetch itself rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(loadSample()).rejects.toThrow("Could not load the sample file: Failed to fetch");
  });

  it("throws a clear error when fetch rejects with something that is not an Error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("offline"));

    await expect(loadSample()).rejects.toThrow("Could not load the sample file: offline");
  });
});

describe("loadBurnedInSample", () => {
  it("resolves with burned-in.dcm's bytes as an ArrayBuffer, from one same-origin request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(burnedInFixture));
    vi.stubGlobal("fetch", fetchMock);

    const bytes = await loadBurnedInSample();

    expect(bytes).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(bytes)).toEqual(burnedInFixture);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/samples/burned-in.dcm");
  });

  it("throws a clear error when the response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 404 })));

    await expect(loadBurnedInSample()).rejects.toThrow("Could not load the sample file: the server answered 404.");
  });
});
