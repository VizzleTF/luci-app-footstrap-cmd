# luci-app-footstrap-palette

Command line and section search for [`luci-theme-footstrap`](https://github.com/VizzleTF/luci-theme-footstrap).

Two things the theme's own page search does not do:

- **`:` opens a command line** on the bottom edge — `:restart dnsmasq`, `:ip`, `:log dnsmasq`,
  `:ping 1.1.1.1`, `:set dark`, `:apply`, `:reboot!`. Tab completes over live router data (the init
  scripts come from `rc list`), `!` is force, the history survives a reload.
- **Search finds sections, not only pages** — "footstrap" reaches System › Appearance, "port
  forward" reaches the tab rather than the page that owns it.

## It asks rpcd for nothing

The package ships no ACL file. Every command runs against an object some LuCI module already grants,
and each one is offered only when the menu node carrying that ACL group is present in the session's
own (already ACL-filtered) `/admin/menu`. A restricted account sees fewer commands; it never gains a
permission its LuCI user was not given.

| command | ubus / exec | the group that grants it |
|---|---|---|
| `:restart` `:start` `:stop` `:enable` `:disable` `:services` | `rc list`, `rc init` | `luci-mod-system-init` |
| `:reboot` | `system reboot` | `luci-mod-system-reboot` |
| `:ping` | `/bin/ping` | `luci-mod-network-diagnostics` |
| `:ip` | `network.interface dump` | `luci-base-network-status` |
| `:sys` | `system board`, `system info` | `luci-mod-status-index` |
| `:log` | `log read` | `luci-mod-status-logs` |
| `:apply` `:revert` `:set` `:back` | none beyond the page you are on | — |

## How it attaches to the theme

`uci add_list footstrap.settings.plugin=fs-palette`, written by this package's uci-defaults. The
theme's chrome requires whatever that list names and knows nothing else about it, so the theme never
mentions this package and this package needs no patch to the theme.

The section index registers through `window.__fsSearchSources`, which the theme's palette reads when
it builds its result pool — a global rather than an export, so registering costs nothing on a page
where the palette is never opened.

## What the section index costs

Measured on a stock OpenWrt 25.12 router carrying 20 third-party apps:

| | |
|---|---|
| view files the menu points at | 98 |
| their total size, served uncompressed | 1 189 KB |
| section and tab titles extracted | 214 |
| the resulting index | 6.7 KB |

So it is not fetched in one go. The rendered page is harvested from the DOM on every navigation,
which is free and is also the only source that sees third-party apps and the theme's own Appearance
section; the rest is fetched at idle under a 256 KB per-session budget, recents first, and cached in
`localStorage` under the same `?v=` every asset is served with — so a package upgrade invalidates it
and nothing else has to. Nothing is fetched at all when the browser reports a metered or
data-saving connection.

## Status

Prototype. Strings are not yet in a catalogue, and the command table is a constant rather than a
registration seam.
