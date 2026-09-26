export const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";
export const FOCUS_RING_WITHIN =
  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-signal";

// Headings that a skip link moves focus to. They take tabindex="-1", and show a ring only when focus
// arrives by keyboard, which is how a skip link is used.
export const HEADING_FOCUS_RING =
  "rounded focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-signal";
export const FINDINGS_HEADING_ID = "findings-heading";
export const TREE_HEADING_ID = "all-fields-heading";
