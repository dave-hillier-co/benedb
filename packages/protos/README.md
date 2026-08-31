# @benedb/protos

The `authzed.api.v1` gRPC contracts, vendored under `protos/authzed/` via
`buf export buf.build/authzed/api`, plus the TypeScript bindings generated from them.

`generated/` is not committed — run `pnpm --filter @benedb/protos generate` (needs `protoc`
on PATH). The vendored `.proto` files are the source of truth for wire compatibility; do not
edit them by hand, re-export them instead.
