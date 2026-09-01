#!/bin/sh
# T2 half one, the assertions: what is IN the built package.
#
# Everything here is invisible to `owlab sync`, which copies the source tree and never runs
# Build/Prepare — so every one of these is a claim that had no gate at all until now.
set -u
DIST="${1:-/tmp/pal-dist}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
fail=0
pass=0

ok() {
	if [ "$1" = 0 ]; then printf 'PASS  %s\n' "$2"; pass=$((pass+1))
	else printf 'FAIL  %s\n' "$2"; fail=$((fail+1)); fi
}

# apk (v3) is a gzipped tar; ipk is an ar archive holding data.tar.gz, or a plain tar.gz on newer
# opkg. Try each rather than branching on the extension, which lies often enough.
unpack() {
	pkg="$1"; dest="$2"
	mkdir -p "$dest"
	# apk v3 is OpenWrt's ADB container ("ADBd" magic), not an archive tar can read. Unpack it with
	# the apk on a running 25.12 router — the only apk-tools v3 within reach.
	if [ "$(head -c 4 "$pkg")" = 'ADBd' ]; then
		C="${APK_CONTAINER:-owlab-luci-theme-footstrap-agent-agent2512}"
		docker exec "$C" sh -c 'rm -rf /tmp/t2x && mkdir -p /tmp/t2x' 2>/dev/null || return 1
		docker cp "$pkg" "$C:/tmp/t2x.apk" >/dev/null 2>&1 || return 1
		docker exec "$C" sh -c 'cd /tmp/t2x && apk extract --allow-untrusted --destination . /tmp/t2x.apk >/dev/null 2>&1 || tar -xf /tmp/t2x.apk 2>/dev/null' || true
		docker cp "$C:/tmp/t2x/." "$dest" >/dev/null 2>&1 || return 1
		return 0
	fi
	if tar -xzf "$pkg" -C "$dest" 2>/dev/null; then
		# an ipk unpacks to control.tar.gz + data.tar.gz; an apk unpacks straight to the filesystem
		[ -f "$dest/data.tar.gz" ] && { mkdir -p "$dest/data"; tar -xzf "$dest/data.tar.gz" -C "$dest/data" 2>/dev/null; }
		[ -f "$dest/control.tar.gz" ] && { mkdir -p "$dest/control"; tar -xzf "$dest/control.tar.gz" -C "$dest/control" 2>/dev/null; }
		return 0
	fi
	( cd "$dest" && ar x "$pkg" ) 2>/dev/null || return 1
	[ -f "$dest/data.tar.gz" ] && { mkdir -p "$dest/data"; tar -xzf "$dest/data.tar.gz" -C "$dest/data" 2>/dev/null; }
	[ -f "$dest/control.tar.gz" ] && { mkdir -p "$dest/control"; tar -xzf "$dest/control.tar.gz" -C "$dest/control" 2>/dev/null; }
	return 0
}

# where the payload ended up, whichever layout it was
rootof() {
	[ -d "$1/data" ] && { echo "$1/data"; return; }
	echo "$1"
}

for pkg in $(find "$DIST" -type f \( -name 'luci-app-footstrap-palette*' \) | sort); do
	base=$(basename "$pkg")
	echo
	echo "##### $base"
	d="$WORK/$(echo "$base" | tr -c 'A-Za-z0-9' '_')"
	unpack "$pkg" "$d" || { ok 1 "$base unpacks"; continue; }
	R=$(rootof "$d")

	CSS="$R/www/luci-static/footstrap-palette/palette.css"
	[ -f "$CSS" ]; ok $? "palette.css is at /www/luci-static/footstrap-palette/"

	if [ -f "$CSS" ]; then
		# The csstidy assertions. csstidy drops the @layer wrapper AND the rule inside it, reduces
		# @keyframes to a bare `to{…}` and rewrites the media query into something invalid.
		grep -q '@layer theme' "$CSS"; ok $? "  @layer theme survived the build"
		grep -q '\.fs-pal[ ,{]' "$CSS"; ok $? "  the .fs-pal rule survived"
		grep -q 'position:[[:space:]]*fixed' "$CSS"; ok $? "  .fs-pal still has position:fixed"
		grep -q '@keyframes[[:space:]]*fs-pal-flash' "$CSS"; ok $? "  @keyframes fs-pal-flash survived"
		grep -q 'prefers-reduced-motion:[[:space:]]*reduce' "$CSS"; ok $? "  the reduced-motion query is still valid"
		# the token fallbacks: without them 15 of 21 names resolve to nothing on a mangled theme
		grep -q 'var(--fs-glass,[[:space:]]*var(--background-color-high))' "$CSS"; ok $? "  colour falls back to the export tier"
		grep -q 'var(--fs-z-popover,[[:space:]]*850)' "$CSS"; ok $? "  z-index has a literal fallback"
	fi

	for f in fs-palette.js fs-palette-sections.js fs-palette-cmdline.js fs-palette-commands.js; do
		J="$R/www/luci-static/resources/$f"
		[ -f "$J" ] || { ok 1 "  $f shipped"; continue; }
		# jsmin ran (comments gone) and the result still parses — the regex-after-return trap
		# truncates the file and exits 0, so parsing the OUTPUT is the only real check
		if grep -q 'the entry point\|Sections as search results\|The command table, and nothing' "$J"; then
			ok 1 "  $f was minified (comments still present)"
		else
			ok 0 "  $f was minified"
		fi
		node -e "new Function(require('fs').readFileSync('$J','utf8'))" 2>/dev/null
		ok $? "  $f parses after minification"
	done

	UCID="$R/etc/uci-defaults/40_luci-app-footstrap-palette"
	[ -f "$UCID" ]; ok $? "  uci-defaults script shipped"

	# the design rule: no acl.d of our own, ever
	! find "$R" -path '*rpcd/acl.d*' -name '*.json' | grep -q .; ok $? "  ships NO acl.d file"

	# control scripts: the two guards that only exist in the built package
	# OpenWrt writes the PACKAGE's own postinst to CONTROL/postinst-pkg and generates a CONTROL/
	# postinst that calls default_postinst (which runs uci-defaults and then postinst-pkg). Reading
	# the bare `postinst` therefore finds the wrapper and never our script. apk names them
	# post-install / post-upgrade / pre-deinstall instead.
	# apk keeps its scripts inside the ADB container rather than as files, so they are read back
	# with `apk adbdump` on the router; ipk keeps them as CONTROL/ members.
	if [ "$(head -c 4 "$pkg")" = 'ADBd' ]; then
		ADB=$(docker exec "${APK_CONTAINER:-owlab-luci-theme-footstrap-agent-agent2512}" sh -c 'apk adbdump /tmp/t2x.apk' 2>/dev/null)
		CTRL="$ADB"; CTRLI="$ADB"
		case "$ADB" in *"license: Apache-2.0"*) LIC=0 ;; *) LIC=1 ;; esac
		case "$ADB" in *"luci-theme-footstrap"*) ok 0 "  depends on the theme" ;; *) ok 1 "  depends on the theme" ;; esac
	else
		CTRL=$(cat "$d"/control/postrm "$d"/postrm 2>/dev/null)
		CTRLI=$(cat "$d"/control/postinst-pkg "$d"/postinst-pkg 2>/dev/null)
		grep -q 'luci-theme-footstrap' "$d"/control/control 2>/dev/null; ok $? "  depends on the theme"
		LIC=1
		find "$d" -name 'LICENSE' | grep -q . && LIC=0
		grep -qi 'Apache-2.0' "$d"/control/control 2>/dev/null && LIC=0
	fi
	ok "$LIC" "  licence is declared"

	case "$CTRL" in
		*upgrade*) ok 0 "  postrm guards on *upgrade*" ;;
		*) [ -z "$CTRL" ] && ok 1 "  postrm present" || ok 1 "  postrm guards on *upgrade*" ;;
	esac
	case "$CTRLI" in
		*"rpcd reload"*) ok 0 "  postinst reloads rpcd" ;;
		*) [ -z "$CTRLI" ] && ok 1 "  postinst present" || ok 1 "  postinst reloads rpcd" ;;
	esac
done

echo
echo "##### i18n"
# `owlab build -out` copies out only the NAMED package, so the i18n subpackage never reaches dist/
# even when the SDK builds it. The proof is in the build log: luci.mk runs po2lmo per language and
# stages luci-i18n-footstrap-palette-<lang>. Point $T2_BUILD_LOG at it.
LOG="${T2_BUILD_LOG:-}"
if [ -n "$LOG" ] && [ -f "$LOG" ]; then
	grep -q 'po2lmo .*po/ru/footstrap-palette\.po' "$LOG"; ok $? "po2lmo compiled the ru catalogue"
	grep -q 'i18n/footstrap-palette\.ru\.lmo' "$LOG"; ok $? "it produced footstrap-palette.ru.lmo"
	grep -q 'luci-i18n-footstrap-palette-ru' "$LOG"; ok $? "the luci-i18n-footstrap-palette-ru subpackage was staged"
else
	echo "  (skipped: set T2_BUILD_LOG to the owlab build log)"
fi

echo
echo "$pass passed, $fail failed"
exit $([ "$fail" = 0 ] && echo 0 || echo 1)
