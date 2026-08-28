/**
 * An opaque consistency cursor handed to clients. Encodes a revision plus optional schema hash
 * and datastore id. The `token` string is opaque; decode it via `zed-tokens.ts`.
 */
export interface ZedToken {
  /** The opaque (base64-encoded) token string. */
  readonly token: string;
}
