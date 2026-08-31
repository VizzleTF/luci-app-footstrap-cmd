#
# Copyright (C) 2026
#
# This is free software, licensed under the Apache License, Version 2.0 .
#

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-footstrap-palette
# luci.mk keys hook names on LUCI_NAME, which defaults to the checkout's directory name — a
# differently-named checkout symlinked into the feed would silently skip the Build/Prepare hook.
LUCI_NAME:=luci-app-footstrap-palette

# Version is git-derived; never hardcode PKG_VERSION. CI injects FOOTSTRAP_VERSION from the tag (an
# SDK build has no .git, so it cannot derive one). This package has its own repo and its own tags:
# the number here is the palette's alone and does not track the theme's.
FOOTSTRAP_VERSION?=
ifneq ($(FOOTSTRAP_VERSION),)
PKG_VERSION:=$(FOOTSTRAP_VERSION)
PKG_RELEASE:=1
endif

LUCI_TITLE:=Command palette and section search for the Footstrap theme
# +luci-theme-footstrap: every module here is loaded BY the theme's chrome (it requires whatever
# `footstrap.settings.plugin` names) and three of them require the theme's own fs-menutree,
# fs-router and fs-prefs. Installed without the theme this package is inert, not broken — but there
# is no reason to carry it, so the dependency is stated. +luci-base is transitive, stated for
# clarity.
#
# NO dependency on luci-mod-system or luci-mod-network, deliberately: every command is gated at RUN
# time on the menu node whose `depends.acl` names the group it needs, so a router without those
# modules simply offers fewer commands. A hard dependency would install them instead.
LUCI_DEPENDS:=+luci-base +luci-theme-footstrap
LUCI_PKGARCH:=all
LUCI_MAINTAINER:=VizzleTF <vizzletf47@gmail.com>
LUCI_URL:=https://github.com/VizzleTF/luci-app-footstrap-palette

PKG_LICENSE:=Apache-2.0

# THIS PACKAGE SHIPS NO ACL FILE, and that is the design rather than an omission. Every command it
# offers runs against an ubus object some LuCI module already grants — `rc list`/`rc init` from
# luci-mod-system-init, `system reboot` from luci-mod-system-reboot, `/bin/ping` from
# luci-mod-network-diagnostics — and each is shown only when the MENU NODE that carries that ACL
# group is present in the session's own /admin/menu blob. A grant of its own would hand every
# holder of this package's group a permission their LuCI account was never given.

# RELOAD, NOT RESTART: rpcd holds sessions in memory, so `restart` logs out every LuCI user. This
# package needs no ACL refresh at all, but the module and index caches have to go or the chrome
# keeps serving the page a list of plugins that predates this install.
define Package/luci-app-footstrap-palette/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache* /tmp/luci-modulecache/* >/dev/null 2>&1 || true
}
exit 0
endef

# Removing the package leaves `footstrap.settings.plugin` naming a module that is no longer on disk;
# the chrome logs the failed require and carries on, but the config would stay wrong forever.
define Package/luci-app-footstrap-palette/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	uci -q del_list footstrap.settings.plugin=fs-palette && uci -q commit footstrap
	rm -f /tmp/luci-indexcache* /tmp/luci-modulecache/* >/dev/null 2>&1 || true
}
exit 0
endef

# Absolute, not a relative path: CI rsyncs this package into package/, not into the feed.
include $(TOPDIR)/feeds/luci/luci.mk

# THE LINE BELOW IS LOAD-BEARING AND IT IS NOT A SIGNATURE — do not delete it as boilerplate.
# include/scan.mk builds the package list by GREPPING Makefiles for `call BuildPackage`; luci.mk calls
# it at the include above, but the grep cannot see that, so this literal is what puts the package into
# the SDK's list.
# call BuildPackage - OpenWrt buildroot signature
