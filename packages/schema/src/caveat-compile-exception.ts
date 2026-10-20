/**
 * Thrown by the caveat compiler and `caveat-parameter-types` when a caveat does not compile: an
 * invalid parameter type, a CEL syntax or type error, or a non-boolean expression. The message is
 * SpiceDB's (`pkg/caveats/compile.go`, `pkg/caveats/types/typeset.go`), including cel-go's
 * rendering of its issues.
 *
 * Ported from Spiceport `Engine/CaveatCompileException.cs`.
 *
 * Port decisions:
 *   * `Object.setPrototypeOf` re-pins the prototype so `instanceof` survives downlevelling, as
 *     `SchemaCompileException` does.
 */
export class CaveatCompileException extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "CaveatCompileException";
  }
}
