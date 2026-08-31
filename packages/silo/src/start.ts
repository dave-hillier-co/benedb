import { main } from "./program";

/**
 * The silo-only host's entry point -- no gRPC surface; the keyed check grains activate here. Run it
 * with `pnpm --filter @spacedb/silo start`.
 *
 * See `packages/api/src/start.ts` for why the invocation lives in this file and `program.ts` has no
 * module-scope side effect: the `process.argv[1]` entry guard the C#'s top-level statements suggest
 * is silently skipped under vite-node and fires TWICE when bundled.
 */
await main();
