#!/bin/sh
# Fleet Console agent installer. Served by your console. Contains no secrets.
#   curl -fsSL @@CONSOLE@@/install.sh | sudo sh -s -- --token <token>
set -eu

CONSOLE="@@CONSOLE@@"

fail() { echo "install failed: $1" >&2; exit 1; }

TOKEN=""
# Take --token out of the arguments; everything else is passed on to the installer unchanged.
n=$#
i=0
while [ "$i" -lt "$n" ]; do
  a="$1"; shift; i=$((i + 1))
  case "$a" in
    --token)
      [ "$i" -lt "$n" ] || fail "--token needs a value"
      TOKEN="$1"; shift; i=$((i + 1)) ;;
    --token=*) TOKEN="${a#--token=}" ;;
    *) set -- "$@" "$a" ;;
  esac
done
[ -n "$TOKEN" ] || fail "no enrolment token. Generate one in the console (Add node) and run the command it shows."

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) PLATFORM=linux-amd64 ;;
  Darwin-arm64) PLATFORM=darwin-arm64 ;;
  *) fail "unsupported machine: $(uname -s) $(uname -m). Supported: Ubuntu 24.04 (x86-64) and macOS (Apple silicon)." ;;
esac
command -v curl >/dev/null 2>&1 || fail "curl is required"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
trap 'exit 1' INT TERM

fetch() {
  # The token goes to curl on stdin so it never appears in a process list.
  printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" |
    curl -fsSL -K - -o "$2" "$CONSOLE/api/agent/download?file=$1" ||
    fail "could not download $1 from the console (is the token still valid? tokens last one hour and work once)"
}

echo "Downloading the agent for $PLATFORM..."
fetch "SHA256SUMS" "$TMP/SHA256SUMS"
fetch "fleetagent-$PLATFORM" "$TMP/fleetagent"

WANT="$(awk -v f="fleetagent-$PLATFORM" '$2 == f { print $1 }' "$TMP/SHA256SUMS")"
[ -n "$WANT" ] || fail "no checksum published for $PLATFORM"
if command -v sha256sum >/dev/null 2>&1; then
  GOT="$(sha256sum "$TMP/fleetagent" | awk '{ print $1 }')"
else
  GOT="$(shasum -a 256 "$TMP/fleetagent" | awk '{ print $1 }')"
fi
[ "$WANT" = "$GOT" ] || fail "checksum mismatch: the download is corrupt or was tampered with. Nothing was installed."
chmod 755 "$TMP/fleetagent"

FLEETAGENT_TOKEN="$TOKEN" "$TMP/fleetagent" install --console "$CONSOLE" "$@"
