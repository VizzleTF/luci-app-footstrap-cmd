#!/bin/sh
# luci-app-footstrap-cmd installer for OpenWrt 24.10 (opkg) and 25.12+ (apk).
#
#   wget -qO- https://raw.githubusercontent.com/VizzleTF/luci-app-footstrap-cmd/main/install.sh | sh
#
# The same script is attached to every release and served from the release CDN, which has no
# per-address budget — the address raw.githubusercontent.com rate-limits is the one a user behind
# CGNAT shares with everyone else. That copy is signed, so it can be verified before it is run as
# root:
#
#   wget -qO- https://github.com/VizzleTF/luci-app-footstrap-cmd/releases/latest/download/install.sh | sh
#
# It adds the owfeed-packages feed and installs from it, so `apk upgrade` / `opkg upgrade` carries
# the package forward afterwards; the feed index is verified by the package manager against the key
# pinned below. Running it again upgrades. Licensed Apache-2.0.
#
# This package is INERT without luci-theme-footstrap, which is a hard dependency and is pulled from
# the same feed — and inert again if that theme is installed but not SELECTED, because the chrome is
# what requires the plugin. The closing lines check for both rather than reporting success over a
# router where nothing will happen.

set -e

FEED_HOST="https://repo.owfeed.org"
FEED_NAME="owfeed-packages"
FEED_KEY_OPKG="9040356b214084da"
PKG="luci-app-footstrap-cmd"
THEME_PKG="luci-theme-footstrap"
I18N_PREFIX="luci-i18n-footstrap-cmd"
REPO="VizzleTF/luci-app-footstrap-cmd"
# `releases/latest/download/…` and never api.github.com: the API is rate-limited per source IP
# (60/hour, shared by everyone behind one NAT) and needs JSON parsing on a box that may have no
# jsonfilter. These redirect to the newest tag's assets.
RELEASE_BASE="https://github.com/$REPO/releases/latest/download"
# The RELEASE key, pinned in the script that uses it: a key fetched beside the file it verifies
# proves nothing. usign's key id travels inside the signature, so a rotation is a visible failure
# here rather than a silent acceptance.
#
# It is the THEME's key, and the embedded comment says so. One author signs both packages, and
# owfeed-packages already pins this public half — a second key would be one more thing to rotate
# and one more way for the two halves of one install to disagree about who signed them.
RELEASE_PUBKEY='untrusted comment: luci-theme-footstrap release key
RWQYxjhl4rz41tNZc3dXmnRplRO1ydN1q8as++iPUjZc6SRUCb952L/T'

info() { printf '[*] %s\n' "$1"; }
ok()   { printf '[+] %s\n' "$1"; }
err()  { printf '[-] %s\n' "$1" >&2; }
warn() { printf '[!] %s\n' "$1" >&2; }

# Every downloader on the box, in turn, until one SUCCEEDS — not the first one that EXISTS.
#
# `uclient-fetch` needs libustream-mbedtls (or -openssl) to speak https at all, and a router with
# the binary and without the library is ordinary. Choosing by existence therefore turns "this ONE
# tool cannot do TLS here" into "the feed has no branch for this router".
#
# Certificates are always verified: this runs as root from `wget | sh`, and a failed verification is
# the MITM case rather than a reason to retry insecurely. Falling through to the next tool is not a
# downgrade — each one verifies, and none is ever asked to skip the check.
fetch() {	# <url> <outfile>
	command -v uclient-fetch >/dev/null 2>&1 && uclient-fetch -T 30 -qO "$2" "$1" && return 0
	command -v wget >/dev/null 2>&1 && wget -q -T 30 -O "$2" "$1" && return 0
	command -v curl >/dev/null 2>&1 && curl -fsSL --proto =https --max-time 30 -o "$2" "$1" && return 0
	return 1
}

# The package manager's chatter is not the user's business — until it fails. Never `>/dev/null`: a
# silent failure is a router left half-installed with a green message.
pm_quiet() {	# <command...>
	_pmlog="/tmp/fs-cmd-install-pm.$$"
	if "$@" >"$_pmlog" 2>&1; then rm -f "$_pmlog"; return 0; fi
	err "\`$*\` failed:"
	tail -15 "$_pmlog" | sed 's/^/    /' >&2
	rm -f "$_pmlog"
	return 1
}

# Say the version. "Installed from the … feed" is equally true of a router that kept the version it
# already had — `apk add` alone does not upgrade — so a stale install and a fresh one would print
# the same line. The number is the one thing that tells them apart.
installed_version() {	# [package], defaulting to this one
	_ivp="${1:-$PKG}"
	if [ "$PM" = "apk" ]; then
		apk list -I 2>/dev/null | sed -n "s/^$_ivp-\([0-9][^ ]*\) .*/\1/p" | head -1
	else
		opkg list-installed 2>/dev/null | sed -n "s/^$_ivp - \([^ ]*\).*/\1/p" | head -1
	fi
}

# --- the release, for a router the feed cannot serve ------------------------------------------
#
# The feed is still the install path: it is what makes `apk upgrade` / `opkg upgrade` carry the
# package forward, and everything below is only reached when the feed cannot be read at all — an
# architecture owfeed does not publish, a host this router cannot resolve or reach, a network that
# intercepts it.
#
# Picked from the SIGNED MANIFEST, never by guessing an asset's name: `manifest.txt` names exactly
# one file per format with its size and digest, and it is signed, so the name comes from the same
# statement the signature covers.
#
# The chain fails CLOSED and in this order: verified TLS, then usign against the key pinned above,
# then the manifest's own sha256 over the artifact. A missing usign, a missing signature or a digest
# that does not match is a refusal, never a downgrade. `apk`'s --allow-untrusted only says the .apk
# carries no APK signature of its own; the usign signature over the manifest is what this path
# trusts, and it is checked before the file is handed over.
install_from_release() {	# [package] [base]
	_want="${1:-$PKG}"
	_base="${2:-$RELEASE_BASE}"
	command -v usign >/dev/null 2>&1 || {
		err "usign is not installed, so a release artifact cannot be verified here."
		return 1
	}
	_tmp=$(mktemp -d /tmp/fs-cmd-install.XXXXXX) || return 1
	printf '%s\n' "$RELEASE_PUBKEY" > "$_tmp/release.pub"
	info "Fetching the signed release manifest..."
	if ! fetch "$_base/manifest.txt" "$_tmp/manifest.txt" ||
	   ! fetch "$_base/manifest.txt.sig" "$_tmp/manifest.txt.sig"; then
		err "Could not download the release manifest from $_base."
		rm -rf "$_tmp"; return 1
	fi
	if ! usign -V -q -p "$_tmp/release.pub" -x "$_tmp/manifest.txt.sig" -m "$_tmp/manifest.txt"; then
		err "The release manifest is not signed by the pinned key — refusing to install."
		rm -rf "$_tmp"; return 1
	fi
	# one line per format: `pkg <name> <format> <file> <size> <sha256> <arch>`
	_file=$(awk -v p="$_want" -v f="$PM_FMT" '$1=="pkg" && $2==p && $3==f { print $4 }' "$_tmp/manifest.txt")
	_sha=$(awk -v p="$_want" -v f="$PM_FMT" '$1=="pkg" && $2==p && $3==f { print $6 }' "$_tmp/manifest.txt")
	if [ -z "$_file" ] || [ -z "$_sha" ]; then
		err "The manifest names no $PM_FMT artifact for $_want."
		rm -rf "$_tmp"; return 1
	fi
	info "Downloading $_file..."
	if ! fetch "$_base/$_file" "$_tmp/$_file"; then
		err "Could not download $_base/$_file."
		rm -rf "$_tmp"; return 1
	fi
	_have=$(sha256sum "$_tmp/$_file" | cut -d' ' -f1)
	if [ "$_have" != "$_sha" ]; then
		err "$_file does not match the digest the signed manifest gives for it — refusing to install."
		err "  manifest: $_sha"
		err "  download: $_have"
		rm -rf "$_tmp"; return 1
	fi
	ok "Signature and digest verified."
	info "Installing $_file..."
	if [ "$PM" = apk ]; then
		pm_quiet apk add --allow-untrusted "$_tmp/$_file" || { rm -rf "$_tmp"; return 1; }
	else
		pm_quiet opkg install "$_tmp/$_file" || { rm -rf "$_tmp"; return 1; }
	fi
	rm -rf "$_tmp"
	return 0
}

# --- the catalogue for the language this router is set to ---------------------------------------
install_language() {	# <feed|release>
	_lang=$(uci -q get luci.main.lang 2>/dev/null || true)
	case "$_lang" in
		''|auto|en) return 0 ;;
	esac
	_lpkg="$I18N_PREFIX-$_lang"
	# ASKED FOR FIRST, then installed. Most languages have no catalogue, and letting the install
	# fail instead prints fifteen lines of the package manager's own diagnosis in front of a message
	# that says nothing is wrong.
	_in_feed=no
	if [ "$1" = feed ]; then
		if [ "$PM" = apk ]; then
			apk list "$_lpkg" 2>/dev/null | grep -q . && _in_feed=yes
		else
			opkg list "$_lpkg" 2>/dev/null | grep -q . && _in_feed=yes
		fi
	fi

	if [ "$_in_feed" = yes ]; then
		info "Fetching the $_lang translation ($_lpkg)..."
		if [ "$PM" = apk ]; then
			pm_quiet apk add --upgrade "$_lpkg" || {
				warn "Could not install $_lpkg — the commands stay in English."; return 0; }
		else
			pm_quiet opkg install "$_lpkg" || pm_quiet opkg upgrade "$_lpkg" || {
				warn "Could not install $_lpkg — the commands stay in English."; return 0; }
		fi
	else
		# The catalogue is pinned to the TAG THE INSTALLED PACKAGE CAME FROM, not to `latest`: the
		# feed trails the release by up to a day, and a catalogue knows only the strings of its own
		# version, rendering the rest in English with nothing reporting it.
		_lbase="$RELEASE_BASE"
		if [ "$1" = feed ]; then
			info "The feed carries no $_lpkg yet; taking it from the signed release."
			_lver=$(installed_version)
			[ -n "$_lver" ] && _lbase="https://github.com/$REPO/releases/download/v${_lver%-r*}"
		fi
		info "Fetching the $_lang translation ($_lpkg)..."
		install_from_release "$_lpkg" "$_lbase" || {
			warn "No $_lpkg in the release either — the commands stay in English."
			return 0; }
	fi
	ok "Translation installed: $_lang"
}

printf '\n=== luci-app-footstrap-cmd installer ===\n\n'

# --- compatibility --------------------------------------------------------
[ -f /etc/openwrt_release ] || { err "Not an OpenWrt system."; exit 1; }
# shellcheck disable=SC1091  # a router file; it does not exist on the machine shellcheck runs on
. /etc/openwrt_release
ok "Detected: ${DISTRIB_DESCRIPTION:-OpenWrt}"

# PM_FMT is the manifest's word for the same thing, and the two are deliberately separate: the
# manager is `apk`/`opkg`, the artifact is `.apk`/`.ipk`, and opkg is the pair where they differ.
if command -v apk >/dev/null 2>&1; then PM=apk; PM_FMT=apk; INDEX=packages.adb
elif command -v opkg >/dev/null 2>&1; then PM=opkg; PM_FMT=ipk; INDEX=Packages.gz
else err "Neither apk nor opkg found."; exit 1; fi
ok "Package manager: $PM"

_before=$(installed_version)

if [ "$PM" = apk ]; then
	ARCH=$(cat /etc/apk/arch) || { err "Cannot read /etc/apk/arch."; exit 1; }
else
	ARCH="${DISTRIB_ARCH:-}"
	[ -n "$ARCH" ] || { err "DISTRIB_ARCH is empty in /etc/openwrt_release."; exit 1; }
fi

# --- version --------------------------------------------------------------
# The floor is the THEME's floor: 24.10. This package is a plugin the theme's chrome loads, so
# whatever the theme cannot run on, this cannot either — and unlike the theme there is no frozen
# release for an older line, because there has never been one that supported it.
FALLBACK_BRANCHES_APK="25.12"
FALLBACK_BRANCHES_OPKG="24.10"

# The feed has no snapshot channel, and not by omission: the two lines owfeed-packages serves ARE
# the package-format split (apk from 25.12, ipk on 24.10). A snapshot has no branch of its own, so
# it gets the newest one its package manager can read.
#
# What makes that sound for THIS package and not in general: it is noarch and its whole dependency
# list is `+luci-base +luci-theme-footstrap`, so nothing in it was compiled against the branch it is
# fetched from. A package carrying a binary, or a versioned dependency, must not take this path.
#
# Newest first, and each candidate is probed rather than assumed: a branch listed here before it is
# published — or one that does not carry this router's architecture — falls through to the next
# instead of writing a repository entry that 404s on every update.
newest_feed_branch() {	# <candidates> -> the first branch that answers
	for _branch in $1; do
		if fetch "$FEED_HOST/releases/$_branch/$ARCH/$INDEX" /dev/null 2>/dev/null; then
			printf '%s' "$_branch"
			return 0
		fi
	done
	return 1
}

BRANCH=$(printf '%s' "${DISTRIB_RELEASE:-}" | cut -d. -f1,2)
case "$BRANCH" in
[0-9][0-9].[0-9][0-9])
	MAJ=${BRANCH%%.*}; MIN=${BRANCH##*.}
	if [ "$MAJ" -lt 24 ] || { [ "$MAJ" -eq 24 ] && [ "$MIN" -lt 10 ]; }; then
		err "$PKG requires OpenWrt 24.10 or newer (detected $DISTRIB_RELEASE)."
		err "That is the Footstrap theme's floor, and this package is a plugin the theme loads."
		exit 1
	fi
	;;
*)
	# SNAPSHOT, or a release string this cannot parse.
	if [ "$PM" = apk ]; then _cands="$FALLBACK_BRANCHES_APK"; else _cands="$FALLBACK_BRANCHES_OPKG"; fi
	BRANCH=$(newest_feed_branch "$_cands") || {
		err "No feed branch carries $ARCH, and ${DISTRIB_RELEASE:-this release} names none."
		exit 1
	}
	info "No branch in ${DISTRIB_RELEASE:-the release string}; using the newest the feed serves: $BRANCH"
	;;
esac

# --- feed -----------------------------------------------------------------
# keep.d is not bookkeeping: sysupgrade wipes the key unless something claims it, and the package
# would come back unupgradable. The repository line itself needs no entry — both managers'
# customfeeds files are conffiles of the manager, and sysupgrade backs up every conffile whose
# checksum has moved.
if [ "$PM" = apk ]; then
	# customfeeds.list rather than a file of our own under repositories.d/. apk reads every *.list
	# in that directory, so both work for installing — but LuCI's package manager reads exactly
	# three paths, so a feed in any other file is invisible in "Configure APK" and cannot be edited
	# or removed there.
	APK_LIST=/etc/apk/repositories.d/customfeeds.list
	if ! grep -q "$FEED_HOST" "$APK_LIST" 2>/dev/null; then
		info "Adding the $FEED_NAME feed..."
		apk add --quiet ca-bundle libustream-mbedtls >/dev/null 2>&1 || true
		mkdir -p /etc/apk/keys /etc/apk/repositories.d /lib/upgrade/keep.d
		printf '%s/releases/%s/%s/packages.adb\n' "$FEED_HOST" "$BRANCH" "$ARCH" >> "$APK_LIST"
		ok "Feed added: $FEED_HOST/releases/$BRANCH/$ARCH"
	else
		info "The $FEED_NAME feed is already configured."
	fi
	# The KEY is fetched on every run, not only when the feed line is written: otherwise a rotation
	# could never be repaired by the documented one-liner — the feed would be "already configured",
	# the key never re-fetched, and `apk update` would fail verification from then on.
	mkdir -p /etc/apk/keys /lib/upgrade/keep.d
	fetch "$FEED_HOST/owfeed-packages.pem" /etc/apk/keys/owfeed-packages.pem
	printf '%s\n' /etc/apk/keys/owfeed-packages.pem > /lib/upgrade/keep.d/owfeed-packages
	info "Updating the package index..."
	pm_quiet apk update || exit 1
	# `apk add` ALONE DOES NOT UPGRADE: apk 3 reads `add` as "make sure this is present", so a
	# package already satisfied stays at the version it is at and the command still exits 0.
	# `--upgrade` is what asks for the newest the feed carries, and it installs on a router that
	# does not have the package yet — one line covers both paths.
	info "Installing $PKG..."
	pm_quiet apk add --upgrade "$PKG" || exit 1
else
	if ! grep -q "$FEED_NAME" /etc/opkg/customfeeds.conf 2>/dev/null; then
		info "Adding the $FEED_NAME feed..."
		opkg update >/dev/null 2>&1 || true
		opkg install ca-bundle libustream-mbedtls >/dev/null 2>&1 || true
		mkdir -p /etc/opkg/keys /lib/upgrade/keep.d
		printf 'src/gz %s %s/releases/%s/%s\n' "$FEED_NAME" "$FEED_HOST" "$BRANCH" "$ARCH" \
			>> /etc/opkg/customfeeds.conf
		ok "Feed added: $FEED_HOST/releases/$BRANCH/$ARCH"
	else
		info "The $FEED_NAME feed is already configured."
	fi
	# Same as the apk leg: the key on every run, so a rotation is repairable by re-running. Here the
	# key ID is part of the PATH, so a rotation changes the filename too — the old one is left alone
	# rather than removed, since opkg reads the whole directory and a stale key verifies nothing.
	mkdir -p /etc/opkg/keys /lib/upgrade/keep.d
	fetch "$FEED_HOST/$FEED_KEY_OPKG" "/etc/opkg/keys/$FEED_KEY_OPKG"
	printf '%s\n' "/etc/opkg/keys/$FEED_KEY_OPKG" > /lib/upgrade/keep.d/owfeed-packages
	info "Updating the package index..."
	pm_quiet opkg update || exit 1
	# `opkg install` on an installed package is a no-op even when the feed has a newer version, so a
	# second run has to ask for the upgrade explicitly. Up to date is not an error for `opkg upgrade`.
	info "Installing $PKG..."
	if opkg list-installed | grep -q "^$PKG "; then
		pm_quiet opkg upgrade "$PKG" || exit 1
	else
		pm_quiet opkg install "$PKG" || exit 1
	fi
fi

install_language feed

# Both caches, as postinst does: a stale /tmp/luci-modulecache bites exactly here, on a package
# whose whole payload is JS the chrome requires. reload, never restart — restart logs out every
# LuCI session.
rm -f /tmp/luci-indexcache* 2>/dev/null || true
rm -rf /tmp/luci-modulecache 2>/dev/null || true
if [ -x /etc/init.d/rpcd ]; then /etc/init.d/rpcd reload >/dev/null 2>&1 || true; fi

printf '\n'
_have=$(installed_version)
if [ -z "$_have" ]; then
	ok "Installed from the $FEED_NAME feed — \`$PM upgrade\` will keep it current."
elif [ -z "$_before" ]; then
	ok "Installed $PKG $_have — from the $FEED_NAME feed, \`$PM upgrade\` will keep it current."
elif [ "$_before" != "$_have" ]; then
	ok "Upgraded $PKG $_before -> $_have — \`$PM upgrade\` will keep it current."
else
	ok "Already current: $PKG $_have — the feed carries nothing newer."
fi

# A blank line between WHAT HAPPENED and WHAT TO DO NEXT.
printf '\n'

# This package is loaded BY the theme's chrome. Installed onto a router whose active theme is
# something else it does nothing at all, and would otherwise report success over a router where
# pressing `:` will never open anything. The dependency guarantees the theme is INSTALLED; only the
# admin can make it the one LuCI renders.
_media=$(uci -q get luci.main.mediaurlbase 2>/dev/null || true)
case "$_media" in
	*/footstrap)
		info "Press \`:\` on any LuCI page to open the command line, and \`:help\` to list what"
		info "this session may run. Search now reaches sections inside a page, not only pages."
		info "Then hard-reload the page (Ctrl+F5)."
		;;
	*)
		warn "The active LuCI theme is not Footstrap, and this package is loaded by its chrome —"
		warn "nothing will happen until you select it."
		info "Select \"Footstrap\" in System -> System -> Language and Style -> \"Design\","
		info "then hard-reload (Ctrl+F5) and press \`:\`."
		;;
esac

_tver=$(installed_version "$THEME_PKG")
[ -n "$_tver" ] || warn "$THEME_PKG is not installed — that should not happen, it is a hard dependency."
