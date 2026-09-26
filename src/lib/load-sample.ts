// The single permitted exception to the "no network API in src" rule (see src/invariants.test.ts).
//
// The invariant is that file contents never leave the browser. This module cannot break it: it
// makes one same-origin GET for a file this site ships, sends no data, and the site is a static
// export with no server, so there is no endpoint that could receive anything. The invariants
// test pins this file to exactly one such call with a single literal path argument, so it can
// never gain a second argument (and with it a method or a body) without a test failing.

export async function loadSample(): Promise<ArrayBuffer> {
  let response: Response;
  try {
    response = await fetch("/samples/single.dcm");
  } catch (e) {
    throw new Error(`Could not load the sample file: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!response.ok) {
    throw new Error(`Could not load the sample file: the server answered ${response.status}.`);
  }
  return response.arrayBuffer();
}
