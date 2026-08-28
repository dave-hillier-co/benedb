#!/usr/bin/env bash
# Regenerate the TypeScript bindings for the vendored authzed.api.v1 contracts.
#
# The protos under protos/authzed/ are vendored from buf.build/authzed/api via
# `buf export`; protos/authzed is the proto root, so the google/api, buf/validate
# and protoc-gen-openapiv2 import dependencies resolve without extra include paths.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$here/protos/authzed"
out="$here/generated"

rm -rf "$out"
mkdir -p "$out"

protoc \
  --plugin="$here/node_modules/.bin/protoc-gen-ts_proto" \
  --ts_proto_out="$out" \
  --ts_proto_opt=outputServices=grpc-js,esModuleInterop=true,useOptionals=messages,useExactTypes=false,forceLong=string \
  -I "$root" \
  $(find "$root/authzed/api/v1" -name '*.proto')

echo "generated $(find "$out" -name '*.ts' | wc -l | tr -d ' ') files into $out"
