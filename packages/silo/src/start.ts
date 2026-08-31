import { main } from "./program";

/**
 * The development entry point for the silo-only host — no gRPC surface; the keyed check grains
 * activate here. Run it with `pnpm --filter @spacedb/silo start`.
 *
 * See `packages/api/src/start.ts` for why an explicit entry point is needed even though
 * `program.ts` ends in the usual `process.argv[1]` guard: under vite-node, which is the only thing
 * in this repository that can execute TypeScript, that guard never matches and `main()` is silently
 * skipped.
 *
 * This is a DEVELOPMENT entry point, not a deployment artifact.
 */
await main();
