/**
 * The port's stand-in for C# `ArgumentException`: an argument was missing, empty, or otherwise
 * not usable. One class, reused everywhere Spiceport throws `ArgumentException`, so the API
 * layer has a single thing to map onto gRPC `InvalidArgument`.
 */
export class InvalidArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidArgumentError";
  }
}
