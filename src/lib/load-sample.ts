// The single permitted exception to the "no network API in src" rule (see src/invariants.test.ts).
//
// The invariant is that file contents never leave the browser. This module cannot break it: every
// fetch here is a single-argument GET for a file this site ships, sends no data, and the site is a
// static export with no server, so there is no endpoint that could receive anything. The invariants
// test now asserts that property directly - every call is a literal, same-origin, bundled `.dcm`
// path, closing parenthesis immediately after the string - rather than just counting occurrences.
//
// Two functions, each with its own literal `fetch` call to its own literal path - not one function
// taking a name. A variable path is exactly what the invariant's literal-string check is built to
// refuse, so a second sample means a second function, not a parameter.

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

export async function loadBurnedInSample(): Promise<ArrayBuffer> {
  let response: Response;
  try {
    response = await fetch("/samples/burned-in.dcm");
  } catch (e) {
    throw new Error(`Could not load the sample file: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!response.ok) {
    throw new Error(`Could not load the sample file: the server answered ${response.status}.`);
  }
  return response.arrayBuffer();
}
