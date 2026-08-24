#!/usr/bin/env bash
#
# Generates the RSA key that pins QuickPaste's extension ID.
#
# Chrome derives an unpacked extension's ID from its filesystem path, so it
# differs on every machine. Google OAuth clients are bound to one specific
# extension ID, so the ID has to be pinned via the manifest "key" field before
# sign-in can work.
#
# This is a ONE-TIME step for the whole project, not something to run per
# device: EXT_PUBLIC_KEY is committed in .env, so every device that builds
# this repo already gets the same pinned ID. Only run this again if you are
# deliberately starting a brand-new project (which requires re-registering a
# new OAuth client too) or intentionally rotating the ID.
#
# Writes quickpaste.pem (gitignored, SECRET) and prints the public value that
# goes into .env (or .env.local, if you're pointing at your own project).
#
set -euo pipefail

PEM="${1:-quickpaste.pem}"

if [[ -e "$PEM" ]]; then
    echo "error: $PEM already exists — refusing to overwrite it." >&2
    echo "Regenerating changes the extension ID and breaks OAuth for every" >&2
    echo "existing user. Delete it deliberately if that is really what you want." >&2
    exit 1
fi

umask 077
openssl genrsa 2048 > "$PEM" 2>/dev/null

pubkey() { openssl rsa -in "$PEM" -pubout -outform DER 2>/dev/null; }

EXT_PUBLIC_KEY="$(pubkey | openssl base64 -A)"

# Extension ID: first 128 bits of SHA-256 over the DER public key, with each
# hex digit remapped 0-f -> a-p.
EXT_ID="$(pubkey | openssl dgst -sha256 -binary | xxd -p -c 32 | cut -c1-32 | tr '0-9a-f' 'a-p')"

cat <<OUT

Wrote $PEM  — keep this secret, keep a backup, never commit it.

Extension ID (register this in Google Cloud Console):

    $EXT_ID

Put this in .env (commit it — it's the public half, safe to share) if
starting a new project, or in .env.local if you're pointing at your own
Firebase project without changing the shared one:

    EXT_PUBLIC_KEY=$EXT_PUBLIC_KEY

OUT
