# Changelog

## 0.1.0 — 2026-09-01

First tagged release. The package existed before this as a prototype; what changed is that the
claims in it are now checked.

### Fixed — the stylesheet never reached a real install intact

Three independent failures, none of which a dev stand can show, because `owlab sync` copies the
source tree and never runs `Build/Prepare`:

- The `<link>` was marked `data-fs-chrome`, which is the theme's DOM fence attribute. A sheet is
  exempted from view-scoping by **`data-fs-shell`**. Without it the theme judged our sheet invasive
  on insertion (`el.sheet` is null before it loads), rehosted it into an `@import` shim owned by
  whatever page happened to be open, and the next navigation's `scopeToCurrentPage()` disabled it
  for the life of the document. The bar lost its styling on page two, not on load.
- `LUCI_MINIFY_CSS` defaults to 1, which runs **csstidy** over every `*.css` — and csstidy predates
  `@layer` by fifteen years. Measured on this package's sheet: 3851 bytes in, 1327 out, **exit 0**,
  with the `@layer theme { … }` wrapper and the `.fs-cmd` rule inside it gone, `@keyframes` reduced
  to a stray `to{…}` selector and the reduced-motion query rewritten into something invalid.
- Of the 21 private `--fs-*` names the sheet reads, **15 do not survive a package build**: the
  theme's `mangle-tokens.sh` derives its reserved set from the theme's own sources, which this
  package is not in. Verified against a built theme — `--fs-glass`, `--fs-z-popover` and
  `--fs-space-2` occur 0 times while `--fs-accent` (77) and `--fs-text` (81) remain. Every `var()`
  now falls back to the export tier for colour and to the theme's own value at density 1 otherwise.

The sheet also carries a `?v=` now, and moved from the too-generic `/www/luci-static/palette/` to
`footstrap-cmd/`.

### Fixed — commands that answered wrongly

`rpc.declare` defaults to *resolving* with the ubus status code, which made two commands lie: the
`:log` fallback to `syslog-wrapper` was dead in exactly the case it exists for, and `:reboot!`
could put up an unclosable "Rebooting…" modal over a router that had refused the call. Every
declaration whose answer is worth trusting now carries `reject: true`.

Also: `run()` waits on `rc list` instead of answering "no init script named dnsmasq" before it has
arrived; `rc init`'s ubus status is printed through `getStatusText()` rather than as a bare number
that reads like the script's own exit code; `:sys` and `:log` are gated on the nodes that grant
them; `:REST` no longer lists the whole table; and every free-text argument beginning with `-` is
refused, because rpcd execs as root and `:ping -f` was a root flood ping.

### Fixed — the section index disagreed with the theme's

The walk started at the tree root rather than inside each mode, so every page came out one level
deeper than `fs-search`'s own rows and every trail was prefixed with "Administration" — which
skewed ranking by a constant and made "administration" match every section and no page. It also
stopped one level short of `MAX_DEPTH` and never reached a sub-tab: 52 pages / 87 rows before,
71 / 163 after, on the same stand.

A network error while harvesting was cached as "this page has no sections" until the next package
upgrade; only a 404 is a permanent miss now. The source harvest could overwrite the richer DOM
harvest. A hung fetch stalled the queue forever. `jobs()` was documented as walked once and was not
memoised.

### Fixed — the ACL gate had never refused anything

`reachable()` tested whether a menu node was PRESENT in `/admin/menu`. That blob is not the
pre-filtered tree this package assumed: it carries every node and marks the reachable ones with
`satisfied`. Presence was therefore always true, the gate was wired to a condition that cannot
fail, and a session holding none of the relevant groups was offered `:restart`, `:ifup`, `:wifi`,
`:reboot` and the rest.

It was invisible because every test ran as root, where every node is satisfied — a gate wired to an
always-true condition looks exactly like a working one. Nothing could be executed through it (rpcd
refuses the call whatever the bar offers), so it was a false promise rather than a privilege
escalation, but the promise is in this README and it is the entire reason the package ships no
`acl.d`.

`tools/acl-gate.sh` now creates a restricted login, runs the bar against it and asserts the exact
split — 11 commands offered, 21 gone — and removes the login again.

### Fixed — pages that were indexed and never findable

`jobs()` tested `action.type === 'view'`, but Status → Overview is a `template` action pointing at
`admin_status/index`. It was therefore not in the index, so its sections were harvested from the
DOM on every visit, written to `localStorage`, and returned by no search. It now asks the theme —
`tree.viewClassFor(node)` — which is the same answer the router uses to decide what it can render.

### Added — the command line is usable with a screen reader

The candidate strip existed only visually: no role, and Tab appeared to change the field's value
for no announced reason. The input is a `combobox` over a `listbox` now, with `aria-expanded` and
`aria-activedescendant` tracking the cycled candidate, and the help line moved out of the list —
a listbox whose children are not all options is an invalid tree.

### Fixed — the command line

Closes on navigation (it used to ride a Back onto the next page still showing the previous page's
output); returns focus to where it was opened from instead of dropping it on `<body>`; the wildmenu
is clickable rather than keyboard-only; Up filters history by what has been typed.

### Added — seventeen commands

`:reload` · `:ifup` · `:ifdown` · `:wifi` · `:conn` · `:dmesg` · `:ps` · `:kill` · `:route` ·
`:arp` · `:trace` · `:dns` · `:time` · `:changes` · `:help` · `:e` · `:q`

Each is gated on a menu node read off the shipped `menu.d` JSON, and none needs a grant this
package does not already inherit. **This package still ships no `acl.d` of its own.**

### Added — packaging, i18n and gates

- `LUCI_MINIFY_CSS:=0`, a `postrm` guard on `*upgrade*`, an `rpcd reload` in `postinst`, `LICENSE`
  and `PKG_LICENSE_FILES`, `LUCI_DESCRIPTION`.
- `uci-defaults` matches the plugin name as a whole token (`grep -qw` treated `-` as a word
  boundary, so `fs-cmd-anything` counted as `fs-cmd` and the registration was skipped) and
  creates `/etc/config/footstrap` when the theme has not got there first.
- `po/`, with a complete Russian catalogue (93 strings) and `update-po.sh --check` as the gate.
- `tools/t0.sh`, `tools/probe.mjs` (67 assertions against a live router), `tools/i18n-probe.mjs`,
  `tools/t2-inspect.sh`, `tools/t2-install.sh`, `owlab.yaml` with a router per package manager,
  and a CI workflow running T0, the catalogue gate, the Makefile's load-bearing lines and
  shellcheck.
- `luci-upstream.pin`: jsmin.c and i18n-scan.pl are downloaded and then EXECUTED as gates, so both
  are pinned by commit and checksummed — verified whether they were fetched or found in a local
  checkout, because a checkout on another commit is the drift the pin exists to catch.

### Known limitations

- **A long-running command cannot be cancelled.** `L.Request` in luci-base creates its own XHR and
  exposes no abort, so Escape discards the *answer* while `/bin/ping -c 3` keeps running on the
  router. Nothing that takes minutes may be added until this changes.
- **A release cannot be cut through `owlab build`.** `luci.mk`'s `findrev` reads
  `git log -1 --format="%ct %h"` — the last COMMIT's timestamp and hash, never a tag — and falls
  back to file mtimes when there is no `.git`, which is the case inside `owlab build`: the package
  is copied into the SDK container without it. So an owlab build is `0.<yymmdd>.<secs>` and differs
  run to run, and a tag does not change that. `FOOTSTRAP_VERSION` pins it — verified by building in
  the same SDK image by hand, which produced `luci-app-footstrap-cmd_0.1.0-r1_all.ipk` — but
  `owlab build` does not forward the variable into the container, so a release needs its own path.
- **`po/ru` only**; every other language falls through to English. The Russian catalogue is proved
  to actually load on a router by `tools/i18n-probe.mjs` (806 Cyrillic characters in `:help`),
  which reading the files cannot settle: an uncompiled `_()` falls through to its English msgid in
  silence.
- **The command table is a constant**, not a seam a third package could extend.
- **`:ip` has no gate** — nothing in LuCI names `luci-base-network-status` in a menu node's
  `depends.acl`, so there is nothing to test for. It is offered to everyone and reports the refusal.
