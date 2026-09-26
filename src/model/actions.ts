/** What each Annex E action code means, in the words the interface shows. */
export const ACTION_GLOSS: Readonly<Record<string, string>> = {
  X: "remove",
  U: "replace with a new UID",
  D: "replace with a dummy value",
  Z: "blank, or replace with a dummy",
  K: "keep",
  C: "clean",
  "Z/D": "blank, or a dummy where the field cannot be empty",
  "X/Z": "remove, or blank",
  "X/D": "remove, or replace with a dummy",
  "X/Z/D": "remove, blank, or replace with a dummy",
  "X/Z/U*": "remove, blank, or replace with a new UID",
};
