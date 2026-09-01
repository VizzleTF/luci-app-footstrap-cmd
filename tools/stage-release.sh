#!/bin/sh
# Put into dist/ the one asset that is not a package — the installer — and write the release notes
# where the release workflow can read them. Runs BEFORE the manifest, since whatever is in dist/ is
# signed with everything else.
#
# The installer ships as an asset because the documented one-liner fetches it from
# raw.githubusercontent.com, which GitHub rate-limits for unauthenticated callers — so the very user
# whose address has run out of budget fails to download the installer meant to rescue them. Release
# assets are served from the release CDN and carry no such budget. Being in dist/ also means it is
# covered by the signature, which is the only way to check it before running it as root.
#
# The notes are the tag's CHANGELOG section. They fill the release page and are NOT an asset: an
# asset nothing reads is one more file to sign, mirror and keep true.
set -eu
cd "$(dirname "$0")/.."
mkdir -p dist

# BESIDE dist/, never inside it: everything in dist/ becomes a release asset, and the notes are the
# release BODY. The path is workspace-relative because that is the only kind a reusable workflow's
# `with:` can be handed.
sh tools/release-notes.sh "${GITHUB_REF_NAME#v}" > release-notes.md
cat release-notes.md

cp install.sh dist/install.sh
