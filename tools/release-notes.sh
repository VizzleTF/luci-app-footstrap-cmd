#!/bin/sh
# The GitHub-release body, taken from CHANGELOG.md — generated, never hand-written, so the
# changelog stays the single source and the release page cannot drift from it.
#
#   tools/release-notes.sh 0.1.0 [changelog]     (version WITHOUT the leading v)
#
# Prints the `## <version>` section verbatim, headers and prose and all, and stops at the next
# `## `. Verbatim rather than the theme's bold-lead extraction: this changelog's sections are
# already written as release-page prose, and a filter that kept only bold leads would silently drop
# every paragraph that has none — which here is most of them.
#
# Pure sh and awk, so the release job needs no node.
set -eu

ver="${1:?usage: release-notes.sh <version> [changelog]}"
changelog="${2:-CHANGELOG.md}"
[ -f "$changelog" ] || { echo "release-notes: no such changelog: $changelog" >&2; exit 1; }

out=$(awk -v ver="$ver" '
	# `## 0.1.0 — 2026-09-01`: match the version as a whole field so 0.1.0 cannot match 0.1.01
	/^## / {
		if (inside) exit
		inside = ($2 == ver)
		next
	}
	inside { print }
' "$changelog")

# An empty body is a release page that says nothing about the release, and the tag is already
# pushed by the time this runs — so it fails rather than publishing silence.
printf '%s' "$out" | grep -q '[^[:space:]]' || {
	echo "release-notes: $changelog has no '## $ver' section" >&2
	exit 1
}

printf '%s\n' "$out"
