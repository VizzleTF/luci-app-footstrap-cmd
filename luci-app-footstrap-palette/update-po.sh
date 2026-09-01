#!/bin/sh
# Rescan this package's sources into po/templates/footstrap-palette.pot and merge it into every
# po/<lang>/footstrap-palette.po. Run after adding or changing ANY _('…') string.
#
#   ./update-po.sh            rescan, merge, report what is still untranslated
#   ./update-po.sh --check    change nothing; fail if the .pot is stale or a string is untranslated
#
# A missing translation cannot fail loudly — an uncompiled _() falls through to its English msgid
# and renders in English with nothing reporting it — so --check is a gate rather than a suggestion.
#
# The directory is `po/`, which is what luci.mk's LUCI_LANGUAGES globs and what Weblate translates.
# Anything else stops luci.mk emitting the per-language packages.
#
# Nothing here runs on the buildbot — luci.mk calls po2lmo itself. This needs perl and gettext,
# which the OpenWrt build does not have.
#
# The scanner is LuCI's OWN build/i18n-scan.pl rather than a grep: it understands the `_('x', 'ctx')`
# second argument and would cover a .ut template if this package ever grew one. A grep would choke
# on the first apostrophe inside a string.
#
# Unlike the theme's copy of this script there is no pinned-and-checksummed download: this package
# ships no luci-upstream.pin and borrows nothing from openwrt/luci, so the scanner is taken from a
# local checkout and the script says so plainly when there is none. A gate that silently executes
# whatever a branch pushed last is worse than a gate that is skipped on purpose.
set -eu

cd "$(dirname "$0")"

POT='po/templates/footstrap-palette.pot'
CHECK=0
[ "${1:-}" = '--check' ] && CHECK=1

for tool in perl xgettext msgmerge msgfmt msginit; do
	command -v "$tool" >/dev/null || { echo "update-po: $tool not found (install perl + gettext)" >&2; exit 1; }
done

scanner=''
for c in "${LUCI_SRC:-}/build/i18n-scan.pl" ../../luci/build/i18n-scan.pl ../../luci-fork/build/i18n-scan.pl; do
	[ -f "$c" ] && { scanner="$c"; break; }
done
[ -n "$scanner" ] || {
	echo "update-po: no i18n-scan.pl found — set LUCI_SRC to an openwrt/luci checkout" >&2
	exit 1
}

fresh=''; old_ids=''; new_ids=''
# shellcheck disable=SC2064  # expand nothing now: the names are assigned as the script proceeds
trap 'rm -f "$fresh" "$old_ids" "$new_ids"' EXIT INT TERM

mkdir -p po/templates
fresh="$(mktemp)"
perl "$scanner" htdocs >"$fresh"

# Compare the msgids only. The .pot carries a POT-Creation-Date and source line numbers, so a byte
# comparison reports every run as a change and the gate becomes noise.
ids() { grep '^msgid ' "$1" | sort; }

if [ "$CHECK" = 1 ]; then
	[ -f "$POT" ] || { echo "update-po: $POT is missing" >&2; exit 1; }
	old_ids="$(mktemp)"; new_ids="$(mktemp)"
	ids "$POT" >"$old_ids"; ids "$fresh" >"$new_ids"
	diff -u "$old_ids" "$new_ids" || {
		echo "update-po: $POT is stale — run ./update-po.sh" >&2
		exit 1
	}
else
	cp "$fresh" "$POT"
fi

rc=0
for d in po/*/; do
	lang="${d%/}"; lang="${lang##*/}"
	[ "$lang" = 'templates' ] && continue
	po="$d/footstrap-palette.po"
	if [ "$CHECK" = 0 ]; then
		if [ -f "$po" ]; then
			msgmerge --quiet --update --backup=none "$po" "$POT"
		else
			msginit --no-translator --locale="$lang" --input="$POT" --output-file="$po"
		fi
	fi
	[ -f "$po" ] || { echo "update-po: $po is missing" >&2; rc=1; continue; }
	msgfmt --check --statistics -o /dev/null "$po" 2>&1 | sed "s/^/$lang: /"
	# an empty msgstr is a string that will render in English on a translated UI
	untranslated=$(msgattrib --untranslated "$po" | grep -c '^msgid "' || true)
	if [ "$untranslated" -gt 1 ]; then
		echo "$lang: $((untranslated - 1)) untranslated" >&2
		[ "$CHECK" = 1 ] && rc=1
	fi
done

exit "$rc"
