#!/usr/bin/env bash
#
# Runs a command with a JDK on PATH.
#
# The Firebase emulators need Java. Homebrew's openjdk is keg-only — it is not
# symlinked into the system Java wrappers, because that step requires sudo — so
# it has to be put on PATH explicitly. A JDK already on PATH wins.
set -euo pipefail

if ! command -v java >/dev/null 2>&1; then
    for candidate in \
        /opt/homebrew/opt/openjdk/bin \
        /usr/local/opt/openjdk/bin
    do
        if [[ -x "$candidate/java" ]]; then
            export PATH="$candidate:$PATH"
            break
        fi
    done
fi

if ! command -v java >/dev/null 2>&1; then
    echo "error: no Java runtime found. The Firebase emulators need one." >&2
    echo "Install with: brew install openjdk" >&2
    exit 1
fi

exec "$@"
