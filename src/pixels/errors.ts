// Three small, typed refusals (3.6, 3.6a), so handleDecode can classify what decodeImage threw
// without pattern-matching its message - see protocol.ts's DecodeOutcome for why that distinction
// exists. decodeImage still throws; these are what it throws for the cases that are a stated
// limitation of ScanLint rather than a defect in the file. A plain Error is everything else: a
// genuine failure.
//
// 3.6a: NoPixelDataError exists because its message is user-facing text, and this very step
// reworded five other user-facing strings elsewhere in this file's callers. A message compared by
// equality to classify an outcome is exactly the kind of thing a wording pass breaks without
// noticing - the next person editing that string will be improving it, not thinking about
// dispatch. Typing all three is what makes "nothing branches on message text" actually true.
//
// Their own module, not decode.ts, because jpeg.ts and pixel-data.ts need to throw
// UnsupportedFormatError too, and decode.ts already imports all three.

export class UnsupportedSyntaxError extends Error {
  readonly transferSyntaxUid: string;

  constructor(message: string, transferSyntaxUid: string) {
    super(message);
    this.name = "UnsupportedSyntaxError";
    this.transferSyntaxUid = transferSyntaxUid;
  }
}

export class UnsupportedFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedFormatError";
  }
}

export class NoPixelDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoPixelDataError";
  }
}
