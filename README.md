# luci-app-footstrap-palette

Command line and section search for [`luci-theme-footstrap`](https://github.com/VizzleTF/luci-theme-footstrap).

Two things the theme's own page search does not do:

- **`:` opens a command line** on the bottom edge — `:restart dnsmasq`, `:ip`, `:log dnsmasq`,
  `:ping 1.1.1.1`, `:route`, `:ps`, `:changes`, `:set dark`, `:apply`, `:reboot!`. Tab completes
  over live router data (the init scripts come from `rc list`), `!` is force, Up filters the
  history by what you have typed, and `:help` lists everything this session may run.
- **`:e` goes to a page** by name or path — `:e wireless`, `:e admin/system/startup` — completing
  over the menu this session actually has. `:q` closes the bar, as in vim.
- **Search finds sections, not only pages** — "footstrap" reaches System › Appearance, "port
  forward" reaches the tab rather than the page that owns it.

## It asks rpcd for nothing

The package ships no ACL file. Every command runs against an object some LuCI module already grants,
and each one is offered only when the menu node carrying that ACL group is present in the session's
own (already ACL-filtered) `/admin/menu`. A restricted account sees fewer commands; it never gains a
permission its LuCI user was not given.

| command | ubus / exec | the group that grants it |
|---|---|---|
| `:restart` `:start` `:stop` `:reload` `:enable` `:disable` `:services` | `rc list`, `rc init` | `luci-mod-system-init` |
| `:reboot` | `system reboot` | `luci-mod-system-reboot` |
| `:time` | `luci setLocaltime` | `luci-mod-system-config` |
| `:ping` `:trace` `:dns` | `/bin/ping`, `/bin/traceroute`, `/usr/bin/nslookup` | `luci-mod-network-diagnostics` |
| `:ifup` `:ifdown` `:wifi` | `/sbin/ifup`, `/sbin/ifdown`, `/sbin/wifi` | `luci-mod-network-config` |
| `:sys` `:conn` | `system board`, `system info`, conntrack counters | `luci-mod-status-index` |
| `:log` `:dmesg` | `log read`, `/bin/dmesg -r` | `luci-mod-status-logs` |
| `:ps` `:kill` | `luci getProcessList`, `/bin/kill` | `luci-mod-status-processes` |
| `:route` `:arp` | `/sbin/ip -[46] route\|neigh show` | `luci-mod-status-routes` |
| `:ip` | `network.interface dump` | `luci-base-network-status` |
| `:apply` `:revert` `:changes` `:set` `:back` `:help` `:e` `:q` | none beyond the page you are on | — |

`:ip` is the one command with no menu node to gate on — nothing in LuCI names
`luci-base-network-status` in a node's `depends.acl` — so it is offered to everyone and reports the
refusal plainly if the session does not hold it. Every free-text argument beginning with `-` is
refused: rpcd execs as root, and `:ping -f` would otherwise be a root flood ping.

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

Built as a real `.apk` and `.ipk`, installed with both package managers on live 24.10 and 25.12
routers, and driven through 42 browser assertions against the installed package — every command
answering with the router's own data.

No CI runs any of that yet, and there is no tag, feed or changelog. The command table is a constant
rather than a registration seam, a long-running command cannot be cancelled (Escape drops the
answer, not the process), and the catalogue ships Russian only — everything else falls through to
English.
