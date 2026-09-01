#!/bin/sh
# The ACL gate, checked against a session that does not hold the permissions.
#
#   tools/acl-gate.sh <container> [base-url]
#   tools/acl-gate.sh owlab-luci-app-footstrap-palette-pal2512 http://localhost:8040
#
# Creates a restricted rpcd login on the router, runs tools/acl-probe.mjs against it, and removes
# the login again whether the probe passed or not. Nothing else in this repository exercises the
# gate: every other test runs as root, where every menu node is reachable and a gate wired to an
# always-true condition looks exactly like a working one.
#
# The password is `$p$root`, which tells rpcd to authenticate against the SYSTEM user root — empty
# on an owlab stand. That is a dev-stand convenience and the reason this script is not something to
# point at a real router.
set -eu
cd "$(dirname "$0")/.."

C="${1:?usage: acl-gate.sh <container> [base-url]}"
BASE="${2:-http://localhost:8040}"

cleanup() {
	docker exec "$C" sh -c '
		while uci -q delete rpcd.@login[1] 2>/dev/null; do :; done
		uci -q commit rpcd
		/etc/init.d/rpcd restart >/dev/null 2>&1
	' 2>/dev/null || true
}
trap cleanup EXIT INT TERM

docker exec "$C" sh -c '
	while uci -q delete rpcd.@login[1] 2>/dev/null; do :; done
	s=$(uci add rpcd login)
	uci -q set "rpcd.$s.username=viewer"
	uci -q set "rpcd.$s.password=\$p\$root"
	uci -q add_list "rpcd.$s.read=luci-base"
	uci -q add_list "rpcd.$s.read=luci-theme-footstrap"
	uci -q add_list "rpcd.$s.read=luci-mod-status-index"
	uci -q add_list "rpcd.$s.write=luci-base"
	uci -q add_list "rpcd.$s.write=luci-theme-footstrap"
	uci -q commit rpcd
	/etc/init.d/rpcd restart >/dev/null 2>&1
' >/dev/null

# rpcd needs a moment after a restart before it will answer a login
sleep 3

BASE="$BASE" USER_NAME=viewer node tools/acl-probe.mjs
