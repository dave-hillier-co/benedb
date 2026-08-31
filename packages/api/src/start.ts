import { main } from "./program";

/**
 * The API host's entry point: gRPC on `GRPC_LISTEN_ADDRESS` and the root HTTP endpoint on
 * `HTTP_LISTEN_PORT`. Run it with `pnpm --filter @spacedb/api start`.
 *
 * THIS FILE IS THE ENTRY POINT, and `program.ts` has none of its own. That split is deliberate and
 * has been wrong twice in the other direction.
 *
 * The C# runs `Program.cs` as top-level statements, so the natural port is a
 * `process.argv[1] === fileURLToPath(import.meta.url)` guard at the end of the module. That idiom
 * is correct for a compiled `node program.js`, and it fails in BOTH directions here. Under
 * vite-node -- the only thing in this repository that can execute TypeScript, since `noEmit` is set
 * and every package exports its `.ts` sources -- `argv[1]` is the vite-node CLI, so the guard never
 * matches and `main()` silently never runs. Bundled, everything is inlined into one file, so
 * `import.meta.url` and `argv[1]` are BOTH that file, the guard fires during module evaluation, and
 * the explicit call here then starts a SECOND host once the first returns: an artifact that shuts
 * down on SIGTERM and immediately comes back up serving, needing a second signal to die.
 *
 * So the invocation is explicit and singular, and `program.ts` has no module-scope side effect at
 * all. Importing it starts nothing BY CONSTRUCTION rather than by a heuristic a bundler defeats --
 * which is the property that stops a test booting a host, and a backgrounded host orphans and runs
 * forever.
 */
await main();
