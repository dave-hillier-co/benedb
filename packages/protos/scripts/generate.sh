#!/usr/bin/env bash
# Regenerate the TypeScript bindings for BOTH vendored contract surfaces.
#
# The protos under protos/authzed/ are vendored from buf.build/authzed/api via
# `buf export`; protos/authzed is the proto root, so the google/api, buf/validate
# and protoc-gen-openapiv2 import dependencies resolve without extra include paths.
#
# protos/permissions.proto is Spiceport's OWN earlier surface (`package spiceport.v0`),
# not a vendored one, and its header says so: "Minimal, NOT authzed v1 byte-compatible
# yet." It is generated because Spiceport still serves it alongside authzed v1
# (PermissionsGrpcService, WatchGrpcService, BulkGrpcService) and eight behavioural
# suites are written against it. It sits OUTSIDE the authzed root and imports only a
# well-known type, so it needs its own invocation with its own -I rather than a wider
# include path on the first: adding protos/ to that one would let an authzed file
# resolve a same-named import from the wrong root.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$here/protos/authzed"
out="$here/generated"

# Shared across both surfaces: `forceLong=string` is the load-bearing one — a proto
# int64/uint64 becomes a string rather than a `Long`, so a revision keeps full 64-bit
# precision on the wire instead of quantising through a float64.
opts=outputServices=grpc-js,esModuleInterop=true,useOptionals=messages,useExactTypes=false,forceLong=string

rm -rf "$out"
mkdir -p "$out"

protoc \
  --plugin="$here/node_modules/.bin/protoc-gen-ts_proto" \
  --ts_proto_out="$out" \
  --ts_proto_opt="$opts" \
  -I "$root" \
  $(find "$root/authzed/api/v1" -name '*.proto')

protoc \
  --plugin="$here/node_modules/.bin/protoc-gen-ts_proto" \
  --ts_proto_out="$out" \
  --ts_proto_opt="$opts" \
  -I "$here/protos" \
  "$here/protos/permissions.proto"

echo "generated $(find "$out" -name '*.ts' | wc -l | tr -d ' ') files into $out"
