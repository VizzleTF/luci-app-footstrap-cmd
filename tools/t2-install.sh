#!/bin/sh
# T2 half two: install the BUILT package on a real router, with the router's own package manager.
#
#   t2-install.sh <container> <pkgfile-on-host> <apk|opkg>
#
# Three runs, in this order, because the middle one is the whole reason the pair of routers exists:
#
#   1. install       — uci-defaults must run and register the plugin
#   2. re-install    — the UPGRADE path. opkg runs the OLD package's postrm with "upgrade" here, and
#                      an unguarded postrm de-registers the plugin at exactly this moment, leaving
#                      the upgraded package installed and doing nothing. apk never does this, which
#                      is why one package manager cannot stand in for the other.
#   3. remove        — the plugin must be de-registered, and the files gone
set -u
C="$1"; PKG="$2"; PM="$3"
base=$(basename "$PKG")
fail=0; pass=0

ok() {
	if [ "$1" = 0 ]; then printf 'PASS  %s\n' "$2"; pass=$((pass+1))
	else printf 'FAIL  %s  %s\n' "$2" "${3:-}"; fail=$((fail+1)); fi
}

R() { docker exec "$C" sh -c "$1" 2>&1; }

plugin() { R 'uci -q get footstrap.settings.plugin'; }
installed() { case "$PM" in apk) R "apk list -I 2>/dev/null | grep -c luci-app-footstrap-palette" ;; *) R "opkg list-installed 2>/dev/null | grep -c luci-app-footstrap-palette" ;; esac; }

echo "===== $C ($PM) <- $base ====="
docker cp "$PKG" "$C:/tmp/$base" >/dev/null || { echo "cannot copy package into $C"; exit 2; }

# a stand synced from the working tree already has the files and the registration; start clean so
# the install is what puts them there
R 'uci -q delete footstrap.settings.plugin >/dev/null 2>&1; uci -q commit footstrap; rm -rf /www/luci-static/footstrap-palette /www/luci-static/resources/fs-palette*.js /etc/uci-defaults/40_luci-app-footstrap-palette' >/dev/null

case "$PM" in
	apk)  INSTALL="apk add --allow-untrusted /tmp/$base"; REMOVE='apk del luci-app-footstrap-palette' ;;
	*)
		# The owlab 24.10 image ships an /etc/opkg.conf with NO `arch` lines, so opkg knows no
		# architecture at all and rejects an `all` package with "incompatible with the architectures
		# configured". A real router has these two lines; this is a stand defect, not a package one,
		# and adding them is restoring the stock file rather than relaxing the test.
		R 'grep -q "^arch " /etc/opkg.conf || printf "arch all 100\narch noarch 100\narch x86_64 200\n" >> /etc/opkg.conf' >/dev/null
		INSTALL="opkg install --force-checksum /tmp/$base"; REMOVE='opkg remove luci-app-footstrap-palette' ;;
esac

echo "--- 1. install ---"
out=$(R "$INSTALL")
echo "$out" | tail -5
[ "$(installed)" -ge 1 ]; ok $? "package is installed"
[ -n "$(R 'ls /www/luci-static/footstrap-palette/palette.css 2>/dev/null')" ]; ok $? "palette.css landed"
[ -n "$(R 'ls /www/luci-static/resources/fs-palette.js 2>/dev/null')" ]; ok $? "fs-palette.js landed"
# uci-defaults are run by default_postinst at install time and then deleted
p=$(plugin); case " $p " in *" fs-palette "*) ok 0 "uci-defaults registered the plugin  [$p]" ;; *) ok 1 "uci-defaults registered the plugin" "got [$p]" ;; esac
[ -z "$(R 'ls /etc/uci-defaults/40_luci-app-footstrap-palette 2>/dev/null')" ]; ok $? "uci-defaults script was consumed"
# the design rule, checked on the router this time
[ -z "$(R 'ls /usr/share/rpcd/acl.d/ 2>/dev/null | grep -i palette')" ]; ok $? "no acl.d of ours on the router"

echo "--- 2. re-install (the upgrade path) ---"
out=$(R "$INSTALL")
echo "$out" | tail -5
p=$(plugin)
case " $p " in
	*" fs-palette "*) ok 0 "plugin still registered after an upgrade  [$p]" ;;
	*) ok 1 "plugin still registered after an upgrade" "postrm de-registered it: [$p]" ;;
esac
# and exactly once: an add_list that is not idempotent lists it twice and the chrome requires it twice
n=$(printf '%s\n' $p | grep -c '^fs-palette$')
[ "$n" = 1 ]; ok $? "listed exactly once, not duplicated  [$p]"

# opkg only runs the old postrm with "upgrade" when the version actually differs, and a re-install
# of the same version is a no-op ("already up to date") — so the step above proves nothing on its
# own. Call the installed postrm with the exact argument opkg passes, which IS the contract: exit 0
# and change nothing. apk has no equivalent (it uses the new package's pre/post-upgrade), so this is
# skipped there rather than faked.
if [ "$PM" != apk ]; then
	echo "--- 2b. the postrm guard, called the way opkg calls it ---"
	PR=/usr/lib/opkg/info/luci-app-footstrap-palette.postrm
	R "sh $PR upgrade" >/dev/null
	p=$(plugin)
	case " $p " in
		*" fs-palette "*) ok 0 "postrm 'upgrade' left the registration alone  [$p]" ;;
		*) ok 1 "postrm 'upgrade' left the registration alone" "de-registered: [$p]" ;;
	esac
fi

echo "--- 3. remove ---"
out=$(R "$REMOVE")
echo "$out" | tail -5
p=$(plugin)
case " $p " in
	*" fs-palette "*) ok 1 "postrm de-registered the plugin" "still [$p]" ;;
	*) ok 0 "postrm de-registered the plugin  [${p:-empty}]" ;;
esac
[ -z "$(R 'ls /www/luci-static/resources/fs-palette.js 2>/dev/null')" ]; ok $? "files are gone"

echo
echo "$C: $pass passed, $fail failed"
exit $([ "$fail" = 0 ] && echo 0 || echo 1)
