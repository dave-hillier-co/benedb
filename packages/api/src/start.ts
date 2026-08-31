import { main } from "./program";

/**
 * The development entry point for the API host: gRPC on {@link GRPC_LISTEN_ADDRESS} and the root
 * HTTP endpoint on {@link HTTP_LISTEN_PORT}. Run it with `pnpm --filter @spacedb/api start`.
 *
 * WHY THIS FILE EXISTS, when `program.ts` already ends in the usual entry-point guard.
 *
 * That guard is `process.argv[1] === fileURLToPath(import.meta.url)`, which is correct for a
 * COMPILED `node program.js` — and this repository never produces one. `tsconfig.base.json` sets
 * `noEmit`, every package exports its `.ts` sources directly, and the relative imports are
 * extensionless (a bundler convention Node's ESM resolver rejects), so the only thing that can
 * execute this tree is the SWC pipeline behind vitest / vite-node. Under vite-node `process.argv[1]`
 * is the vite-node CLI, never `program.ts`, so the guard is FALSE and `main()` silently never runs:
 * the module loads, does nothing, and the process exits successfully. That failure is quiet, which
 * is what makes it worth a file rather than a flag.
 *
 * So the invocation is explicit here instead of inferred there. `program.ts`'s guard is deliberately
 * left alone: it is what keeps an IMPORT of that module inert, which is the property that stops a
 * test booting a host — and a backgrounded host orphans and runs forever.
 *
 * This is a DEVELOPMENT entry point. It is not a deployment artifact: there is no build step behind
 * it, and it runs TypeScript through vite-node.
 */
await main();
