/**
 * The port's stand-in for C# `FormatException`: a string was not in the expected format.
 * Thrown by the non-`try` parse entry points, which mirror Spiceport's `Parse*` wrappers
 * around `TryParse*`.
 */
export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatError";
  }
}
