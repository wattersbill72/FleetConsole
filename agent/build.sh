#!/usr/bin/env bash
# Cross-compiles the agent for the two supported platforms into dist/, with checksums.
#   ./build.sh [version]
set -euo pipefail
cd "$(dirname "$0")"
VERSION="${1:-0.1.0-dev}"
rm -rf dist && mkdir dist
for target in linux/amd64 darwin/arm64; do
  os="${target%/*}"; arch="${target#*/}"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags "-s -w -X main.version=$VERSION" \
    -o "dist/fleetagent-$os-$arch" ./cmd/fleetagent
done
(cd dist && sha256sum fleetagent-* > SHA256SUMS)
ls -l dist
