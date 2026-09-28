// Minimal shapes of the File and Directory Entries API. Not in lib.dom.d.ts (it is a legacy,
// Chromium-originated API), and narrow enough here that a local type is clearer than a large
// ambient declaration.
export type FileSystemFileEntryLike = {
  isFile: true;
  isDirectory: false;
  name: string;
  file: (success: (file: File) => void, error: (e: Error) => void) => void;
};
export type FileSystemDirectoryEntryLike = {
  isFile: false;
  isDirectory: true;
  name: string;
  createReader: () => {
    readEntries: (success: (entries: FileSystemEntryLike[]) => void, error: (e: Error) => void) => void;
  };
};
export type FileSystemEntryLike = FileSystemFileEntryLike | FileSystemDirectoryEntryLike;

export type EntryFile = { file: File; relativePath: string };

/**
 * `DataTransferItemList` is only valid synchronously, inside the drop event. Call this first,
 * directly in the handler, before any `await`; walk the result afterwards with `collectEntries`.
 */
export function extractEntries(items: DataTransferItemList): FileSystemEntryLike[] {
  const entries: FileSystemEntryLike[] = [];
  for (let i = 0; i < items.length; i++) {
    const getEntry = (items[i] as { webkitGetAsEntry?: () => FileSystemEntryLike | null }).webkitGetAsEntry;
    const entry = getEntry?.call(items[i]);
    if (entry) entries.push(entry);
  }
  return entries;
}

function readFile(entry: FileSystemFileEntryLike): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

// A directory reader returns entries in batches and must be called again until a batch comes
// back empty; a single call is not guaranteed to return everything in a large directory.
function readAllEntries(reader: ReturnType<FileSystemDirectoryEntryLike["createReader"]>): Promise<FileSystemEntryLike[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntryLike[] = [];
    function next(): void {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        next();
      }, reject);
    }
    next();
  });
}

async function walk(entry: FileSystemEntryLike, prefix: string, out: EntryFile[]): Promise<void> {
  const path = `${prefix}${entry.name}`;
  if (entry.isFile) {
    out.push({ file: await readFile(entry), relativePath: path });
    return;
  }
  const children = await readAllEntries(entry.createReader());
  for (const child of children) await walk(child, `${path}/`, out);
}

/** Walks already-extracted entries (files and directories, recursively) into a flat file list. */
export async function collectEntries(entries: FileSystemEntryLike[]): Promise<EntryFile[]> {
  const out: EntryFile[] = [];
  for (const entry of entries) await walk(entry, "", out);
  return out;
}
