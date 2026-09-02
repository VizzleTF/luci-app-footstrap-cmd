# CLAUDE.md

`luci-app-footstrap-cmd` — a companion package for **`luci-theme-footstrap`**, adding the two
things the theme's own page search does not do: a **`:` command line** and **search over the
sections inside a page**. Client-side only: four JS modules, one stylesheet, one uci-defaults
script. No server code, no ACL file, no menu entry.

**Communicate in Russian.** Code, comments, commit messages and PR text stay in English.

**The floor is the theme's floor: OpenWrt 24.10 and newer** (and ImmortalWrt). What the theme cannot
run on, this cannot either.

**Repo root is the workspace**; the shipped package is `luci-app-footstrap-cmd/` one level down
— same name, one level apart, so a path is ambiguous unless it is absolute or rooted. The theme is a
sibling checkout at `../luci-theme-footstrap`, and its `docs/` is the reference for the chrome, the
router, the CSS layers and the stands. **Do not re-derive what a theme doc already settled.**

| Touching | Read (in the theme's checkout) |
|---|---|
| what LuCI expects of a theme, where the boundary runs | `docs/architecture.md` |
| dev routers, pushing a change, proving it, the stands' own traps | `docs/development.md` |
| cascade layers, tokens, why no colour literals | `docs/css.md`, `docs/design-system.md` |
| client navigation, the two-`L` trap, prefetching | `docs/spa-router.md` |
| foreign `luci-app-*`, the fence, zone 1 | `docs/third-party-apps.md` |
| Makefile, uci-defaults, postinst/postrm | `docs/package.md` |

## How it attaches to the theme

Six seams, all of them the theme's, none of them naming this package:

1. **`footstrap.settings.plugin`** — a uci list. `header.ut` whitelists each entry to the shape of a
   LuCI module name and prints `window.__fsPlugins`; the chrome requires each name at the end of its
   init. This package's uci-defaults adds `fs-cmd`; its postrm removes it.
2. **`window.__fsSearchSources`** — an array of functions returning palette rows. `fs-search`'s
   `pool()` concatenates them onto its own index and ranks everything together. A **global, not an
   export**: the palette is fetched on the first gesture and most sessions never make one, so a
   package that had to `require('fs-search')` to register would pull 4.5 KB onto every page for a
   list nobody opened.
3. **`window.__fsSearchGen`** — a counter this package bumps when the index grows, which is what
   tells the palette its pool is stale.
4. **`entry.onTake()`** — the palette calls it when a row is chosen, for a click and for Enter
   alike. A section row's href can only reach the PAGE, so this is where the tab is opened and the
   section scrolled to.
5. **`entry.key` and `menu-footstrap-common.remember(key)`** — what the recents list stores a row
   under and how a row records itself. A page's key is its menu path; a section has no dispatcher
   node, so its key is `<page path>#<heading>`. The writer stays the theme's, or the 8-entry cap and
   the de-duplication would exist twice. A theme too old to export `remember` keeps no section in
   its recents, which is what it did before.

6. **`data-fs-shell` on our `<link>`** — the theme treats every sheet in the document as a view's
   unless it carries this attribute (`fs-sheets.js`: `VIEW_SHEETS = 'style:not([data-fs-shell]),
   link[rel~="stylesheet"]:not([data-fs-shell])'`), and its `<head>` observer is live before
   `loadPlugins()` runs. Without the mark: `judgeSheet()` reads `el.sheet === null` on a sheet that
   has not loaded yet and rules it invasive, `rehostIntoThemeLayer()` silences the original and
   claims an `@import` shim for whatever page was open, and the NEXT navigation's
   `scopeToCurrentPage()` disables it for the life of the document. **It is not `data-fs-chrome`** —
   that marks a DOM *element* as zone 1 for the fence and does nothing on a `<link>`. The bar
   element carries `data-fs-chrome`; the stylesheet carries `data-fs-shell`. Both are needed and
   they are not interchangeable.

`fs-router.onNavigate` and `fs-menutree.nodeForSegs` are also used, both exported by the theme.

**What counts as a page is the theme's answer, not ours.** `jobs()` calls `tree.viewClassFor(node)`
rather than testing `action.type === 'view'`: Status → Overview is a `template` action pointing at
`admin_status/index`, whose server template does nothing but instantiate `view.status.index`.
Testing the action type left that page out of the index entirely, so its sections were harvested
from the DOM on every visit, stored, and returned by no search. A theme too old to export
`viewClassFor` falls back to the old test and loses that one page, which is what it lost before the
seam existed.

**The tree walk in `fs-cmd-sections.js` is the theme's `fs-search.buildIndex()`, duplicated on
purpose.** Both halves are ranked against each other by the same `search()`, so `depth` and `trail`
have to mean the same thing on both sides: start INSIDE each mode (`admin` is a container, not a
level, and its title is in nobody's trail), stop at the same `MAX_DEPTH = 4`, skip `logout` at
depth 1. Getting it wrong is not a crash — it shifts every section row's rank by a constant and
prefixes every trail with "Administration".

**Our CSS may not name the theme's private tokens without a fallback.** `--fs-*` is the private
tier and `mangle-tokens.sh` renames it to `--a`, `--b`, … deriving the reserved set by scanning the
THEME's own `htdocs/luci-static/resources` and `ucode` — which this package is not in. Measured
against 0.14.8: of the 26 `--fs-*` names `cmd.css` reads, **none survive**. Six did at 0.14.5,
because the theme's own JS happened to name them; it no longer does, so **the surviving set is to be
treated as EMPTY** rather than re-measured and relied on. A dev stand mangles nothing, so the
failure is invisible exactly where it would be caught: a bare `var(--fs-space-4)` inside `inset`
made the whole shorthand invalid at computed-value time and put the bar in the window's top-left
corner on every real install, while every stand and the probe stayed green. `tools/t0.sh` fails on
a bare `var(--fs-…)` in `cmd.css` for that reason. Every `var()` therefore names the private token
first and falls back to the **export tier** (`--background-color-*`, `--border-color-*`,
`--text-color-*`, `--primary-color-*`, `--error-color-*` — the documented outbound contract with
third-party apps, a different prefix that the mangler does not touch) for colour, and to the
theme's own measured value at density 1 for everything else.

**Never patch the theme from here, and never add a seam without needing it.** A change on the theme
side is a change to a shipped package with its own release stream; if one is unavoidable it goes in
the theme's tree with its own changelog entry, and this package keeps working against the theme
version that does not have it yet.

## The modules

| File | Owns | Loaded |
|---|---|---|
| `fs-cmd.js` | the entry point: the `<link>`, the `:` binding, registering the source | every page (956 B) |
| `fs-cmd-sections.js` | the section index: two harvesters, the cache, the palette rows, `pages()` | every page (7 583 B) |
| `fs-cmd-bar.js` | the bar on the bottom edge: input, wildmenu, echo area, keys, history | on the first `:` (4 401 B) |
| `fs-cmd-commands.js` | the command table, the gate, `suggest()` and `run()` | on the first `:` (15 013 B) |

Bytes after **jsmin**, which is what `luci.mk` runs (`LUCI_MINIFY_JS?=1`, `luci.mk:18`). Measured by
building `modules/luci-base/src/jsmin.c` from the luci checkout and piping each file through it —
the theme's terser path is a CI step of its own and this package does not have it, so an earlier
"after terser" figure here described a build that never existed. One concern per module, composed
by calling:
`L.require` makes a singleton and raises `DependencyError` on a cycle, so a module can never
`extend` another.

The two whose numbers matter: the `?v=` on our `<link>` is concatenated by hand, because
`L.resource()` adds none (LuCI's `SubstituteVersion` rewrites `.ut`/`.htm`, not a link built in JS)
and `L.path()` filters a query part against `[a-zA-Z0-9_.%=&;-]`, which would silently drop the `~`
a git-derived `resource_version` carries.

## The rule that decides everything: no ACL of our own

**This package ships no `acl.d` file, and that is the design.** Every command runs against an ubus
object some LuCI module already grants, and each is offered only when the **menu node** carrying
that ACL group is present in the session's own, already ACL-filtered, `/admin/menu`:

| command | ubus / exec | gated on the node | which depends on |
|---|---|---|---|
| `:restart` `:start` `:stop` `:reload` `:enable` `:disable` `:services` | `rc list`, `rc init` | `admin/system/startup` | `luci-mod-system-init` |
| `:reboot` | `system reboot` | `admin/system/reboot` | `luci-mod-system-reboot` |
| `:ping` `:trace` `:dns` | `/bin/ping`, `/bin/traceroute`, `/usr/bin/nslookup` | `admin/network/diagnostics` | `luci-mod-network-diagnostics` |
| `:ifup` `:ifdown` | `/sbin/ifup`, `/sbin/ifdown` | `admin/network/network` | `luci-mod-network-config` |
| `:wifi` | `/sbin/wifi` | `admin/network/wireless` | `luci-mod-network-config` |
| `:sys` `:conn` | `system board`, `system info`, `file read` on `/proc/sys/net/netfilter/nf_conntrack_{count,max}` | `admin/status/overview` | `luci-mod-status-index` |
| `:log` `:dmesg` | `log read`, `/usr/libexec/syslog-wrapper`, `/bin/dmesg -r` | `admin/status/logs` | `luci-mod-status-logs` |
| `:ps` `:kill` | `luci getProcessList`, `/bin/kill` | `admin/status/processes` | `luci-mod-status-processes` |
| `:route` `:arp` | `/sbin/ip -[46] route show table all`, `… neigh show` | `admin/status/routes` | `luci-mod-status-routes` |
| `:time` | `luci setLocaltime` | `admin/system/system` | `luci-mod-system-config` |
| `:ip` | `network.interface dump` | — (no node names it) | `luci-base-network-status` |
| `:apply` `:revert` `:set` `:back` `:changes` `:help` `:e` `:q` | none beyond the page you are on | — | — |

`:e` needs no gate in any sense: the page list it completes over IS the ACL-filtered menu, so a
page the session may not open is not in it to be completed. It reads that list from
`fs-cmd-sections.pages()` rather than walking the tree a third time — the module is already
loaded on every page, so the command table gets it for nothing, and there is no require cycle
(sections requires the theme's modules and never the command table).

`:ip` is the one command with no gate available: **no menu node anywhere in luci names
`luci-base-network-status` in its `depends.acl`**, so there is nothing to test for. It is offered
to everyone and reports the denial plainly instead — which is why its declaration, and every other
one whose answer is worth trusting, carries `reject: true`. The default is to RESOLVE with the ubus
status code, and that default is what made the `:log` fallback dead on arrival (a missing `log`
object was coerced by `expect: { log: [] }` into an empty log) and what could leave `:reboot!`
showing an unclosable "Rebooting…" modal over a router that never rebooted.

Two rules for anything that reaches `fs.exec`: the ACL patterns for `/sbin/ip` are **whole command
lines** (`/sbin/ip -[46] route show table all`), so the arguments are not ours to vary — a "nicer"
variation is simply denied. And every free-text argument is refused when it begins with `-`
(`optionLike()`): rpcd execs as root and a bare leading dash is read by the tool as an option, so
`:ping -f` would otherwise be a root flood ping.

A grant here would hand every holder of this package's group a permission their LuCI account was
never given. **Adding an `acl.d` entry is a security change and needs `/security-review` in the
theme's checkout, not a judgement call.** Gating by node presence costs nothing: the tree is already
in the browser.

`reachable()` uses `tree.nodeForSegs` — **never `resolveSegs`**: an alias resolves somewhere else
and would answer for a permission the session may not hold.

**And it tests `node.satisfied`, not the node's presence.** `/admin/menu` is NOT the pre-filtered
tree this package assumed it was: it carries EVERY node and marks the reachable ones. Testing
presence answered "yes" for everything, so the gate had never once refused anything — and that was
invisible because every test ran as root, where every node is satisfied. A gate wired to an
always-true condition looks exactly like a working one.

Measured on a stand with a login holding only `luci-base`, the theme and `luci-mod-status-index`:
`admin/system/reboot`, `admin/network/network`, `admin/network/wireless`, `admin/status/logs` and
`admin/status/processes` are all present with `satisfied: false`, while `admin/status/overview` is
present and satisfied. Falsy is unsatisfied, which is how the theme's own `childrenOf()` reads it.

Nothing could be executed through the hole — rpcd refuses the call whatever the bar offers — so it
was a false promise rather than a privilege escalation. But the promise is in the README and it is
the entire reason this package ships no `acl.d`, so **`tools/acl-gate.sh` is not optional**: it
creates a restricted login, runs the bar against it and asserts the exact split (11 commands
offered, 21 gone). Run it after any change to `reachable()`, to a `needs` value, or to the command
table.

## The section index, and what it costs

Two harvesters, cheapest first:

1. **The rendered DOM**, on every navigation. Free — the page is already there — and the only source
   that sees third-party apps and the theme's own Appearance section, which no view file contains.
   Selectors are in `DOM_SEL`; `h4` and below are deliberately excluded, being field groups and
   status boxes that would bury the page in its own results.
2. **The view module's source**, at idle, for pages this session has not opened. Fetched at exactly
   the URL `luci.js` would use (`L.env.base_url` + the menu node's `action.path` + the same `?v=`),
   so a page the router has already prefetched is a browser-cache hit and costs nothing. A 404 is
   cached as "this page has no sections"; any other non-OK is not, or a 503 while rpcd restarts
   would blank a page's sections until the next package upgrade.

Measured on a stock 25.12 stand carrying 20 third-party apps:

| | |
|---|---|
| view files the menu points at | 98 |
| their total size, served uncompressed by uhttpd | 1 189 KB |
| section and tab titles extracted | 214 |
| the resulting index | 6.7 KB |
| one session's harvest under the 256 KB budget | 24 pages, 340 KB |

Re-measured 2026-09-01 on the agent stand (`agent2512`, 25.12.4, the same 20 apps), after the walk
was corrected to start inside the mode: **71 pages indexed, 163 rows, 274 786 B spent**. The row
count roughly doubled against the earlier figure because the old walk stopped one level short of
`MAX_DEPTH` and never reached a sub-tab.

The 340 KB is the budget plus one file: a view's size is not knowable before it is fetched, so the
last one overshoots by its own length (82 KB `network/wireless` in that run). **A number in a
comment is part of the contract** — re-measure before changing one, and say what it was measured on.

Option labels (`.option(form.Value, 'x', _('Label'))`) are **deliberately not indexed**: 273 of them
against 214 section titles, and a search for "password" that lists eleven fields is worse than one
listing the three pages that carry them.

The cache is keyed on `L.env.resource_version` — the same `?v=` every asset is served with — so a
package upgrade invalidates it and nothing else has to. Nothing is fetched at all when
`navigator.connection.saveData` is set, the same guard the theme's own recents warm-up uses.

## Landing on the section

Taking a section row opens the tab it sits behind and scrolls to it, through `onTake`. One
mechanism: a MutationObserver on **`#maincontent`** — never `#view`, which the router replaces right
after it stamps the page, leaving an observer on that node watching an orphan — plus a **10 s**
deadline (`LAND_MS`). Ten and not three: the theme's own Appearance tab is appended by
fs-appearance after the stock System page has rendered, and an app that builds its tabs behind two
RPCs is slower again; a window that expires while the page is still building fails silently, which
is the worst way to fail. It ends early on the next navigation, which is the real staleness signal.

**The request outlives its first success on purpose**, and that is the part that reads as a bug if
it is "cleaned up". The row is a real link, so taking one on the page it already points at is still
a navigation and the router re-renders the view over whatever just happened. Measured on the stand,
taking "Footstrap" from the System page itself: the tab switched at 2009 ms, `#view` was emptied at
2010 ms, and the strip was back on General Settings at 2161 ms. So the landing is re-applied on
every mutation until the deadline. It is idempotent — a tab already open is not clicked again — and
the scroll and the flash happen once, or the page would fight the reader.

Focus lands on the tab or heading, and the recents entry is written, on arrival rather than on the
click: the palette's Enter synthesises a click carrying `detail === 0`, which the theme's router
reads as a keyboard activation and answers by focusing the skip link, so without this the reader
gets the "Skip to content" pill and no way to the section but Tab. `refocus()` moves focus only
from `<body>` or from that pill — a reader who has clicked into a field keeps it — which is also
what lets it run on every re-application rather than only the first.

## Comments

Same rules as the theme, and not negotiable here either: **minimally sufficient**, **why not what**,
**carry the measurement rather than the adjective**. A negative result stays in one line. A number
or a name in a comment changes in the same edit as the code, or it becomes a lie git preserves
forever. Formal English, no theatre. Comments cost no router bytes — `luci.mk` runs jsmin at package
time — so never trade a "why" away for bytes.

**Never put a regex literal straight after `return` or `=>`**: jsmin eats the rest of the file and
**exits 0**. Wrap it — `return (/^x/.test(s));`.

## Commands

```sh
# this repo's own stands: pal2512 (25.12, apk) and pal2410 (24.10, opkg), ports 8040-8041 /
# 2240-2241. TWO routers because the two package managers disagree about the upgrade path, which is
# what the postrm guard exists for — see owlab.yaml.
owlab up
owlab sync
owlab build -release 25.12.4 -arch x86_64 -out dist   # a real .apk
owlab build -release 24.10.7 -arch x86_64 -out dist   # a real .ipk

# the agent's own stand (config outside every checkout, one router, ports 8035 / 2235)
owlab -c ../tmp/owlab-agent/owlab.yaml sync agent2512
owlab -c ../tmp/owlab-agent/owlab.yaml status

# this package's files on that stand. Note the glob: `fs-cmd-*.js` does NOT match
# `fs-cmd.js`, and the entry point is the one file whose absence breaks everything.
docker exec owlab-luci-theme-footstrap-agent-agent2512 ls /www/luci-static/resources/ | grep fs-cmd
docker exec owlab-luci-theme-footstrap-agent-agent2512 ls /www/luci-static/footstrap-cmd/

# what the index holds right now, from the browser console
L.require('fs-cmd-sections').then(m => m.stats())

# the catalogue, after adding or changing any _('…')
LUCI_SRC=../../luci ./luci-app-footstrap-cmd/update-po.sh
LUCI_SRC=../../luci ./luci-app-footstrap-cmd/update-po.sh --check

# the minifier the buildbot actually uses, for the T0 round-trip
cc -O2 -o /tmp/jsmin ../luci/modules/luci-base/src/jsmin.c
```

`owlab sync` never runs `/etc/uci-defaults` (that directory is router state), so the agent config's
`post_sync` repeats the `add_list` and touches the package database — the `?v=` every asset is
served under is the mtime of that database, and without moving it the browser keeps serving the
modules it already has and the page runs a mixture of old and new. Written up in the theme's
`docs/development.md`, "Caches while iterating".

**The postinst reloads rpcd**, even though this package ships no `acl.d`. The uci-defaults script
CREATES `/etc/config/footstrap` when the theme has not got there first, and an rpcd already running
does not cover a uci package whose file did not exist when it read its ACLs — the symptom is the
theme's Appearance tab answering `uci/get failed with error -32002: Access denied` for a config the
session is fully entitled to read. Observed on the stand, and it is `reload`, never `restart`:
restart drops every LuCI session.

**`/etc/config` is router state too**, so the theme's shipped `/etc/config/footstrap` stub never
lands on a synced stand either. `uci set` on a package whose config file does not exist fails with
"Entry not found", and `-q` hides it — the stand then has an unregistered plugin and no error to
say so. Both the package's uci-defaults and the stand's `post_sync` `touch` the file first, and
both match the plugin name as a whole space-delimited token: `grep -qw fs-cmd` treats `-` as a
word boundary, so a list holding `fs-cmd-anything` counted as holding `fs-cmd`.

## Verifying

No npm gate suite here yet. What must hold before a change is called done:

- **T0** — each edited module parses (`node -e "new Function(readFileSync(f))"`), the uci-defaults
  script passes `sh -n`, and every `.ut` the theme's side touched compiles with
  `ucode -T -c -o /dev/null` (run it in the container; the host has no `ucode`).
  Also **minify and re-parse**: build `modules/luci-base/src/jsmin.c` from the luci checkout, pipe
  each module through it, and `new Function()` the OUTPUT. jsmin eats the rest of a file after a
  regex literal that follows `return` or `=>` and **exits 0**, so a grep for the pattern is a
  weaker check than actually running the minifier the buildbot runs.
- **T1** — a Playwright probe against a stand (67 assertions as of 2026-09-01, all green):
  the plugin appears in `window.__fsPlugins`; the stylesheet is present, marked `data-fs-shell`,
  carries a `?v=`, and **is still enabled with a non-zero rule count after a navigation** (the
  assertion that catches both the sheet-rehosting trap and a csstidy-mangled sheet); the bar
  computes to `position: fixed` with a real `z-index`; `:restart <Tab>` completes from the live
  `rc list`; every printing command prints router data; `:ping -f` is refused; `trail` does not
  begin with the mode title; `:e` completes over the menu and navigates; and the theme's own palette
  lists a section row.

  The console must be clean **of our errors**, and the probe's two exclusions are established
  rather than assumed. The 403 is the login POST before auth. The other is
  `uci/get … -32002: Access denied` for config `luci`, raised on the System page of the agent stand
  by the theme or luci-base on a session that stand does not grant `uci read: luci` to: proved not
  ours by reproducing it with `footstrap.settings.plugin` emptied, so none of this package's
  modules loaded at all, and it does not occur on `pal2512` where the theme is installed as a
  package. The filter pins both the config name and the ubus code, so a different denial still
  fails.

  **The probe must drive the bar from a page with no form on it.** Driving it from
  `admin/system/system` once rewrote `luci.main.mediaurlbase` and `luci.main.lang` on the stand:
  a `:` pressed while focus sits in a `<select>` is type-ahead, and the Enter after it saves the
  form. `openBar()` blurs first and asserts the bar is open before typing; the commands run from
  `admin/status/overview`.
- **T2** — a real package build installed on both package managers. **Done, green** (2026-09-01):
  47 assertions on the artifacts (`tools/t2-inspect.sh`), 10 per router on install/upgrade/remove
  (`tools/t2-install.sh`), and the whole T1 probe re-run against the INSTALLED package.

  ```sh
  owlab build -release 25.12.4 -arch x86_64 -out dist    # .apk
  owlab build -release 24.10.7 -arch x86_64 -out dist    # .ipk
  T2_BUILD_LOG=<build log> tools/t2-inspect.sh dist
  tools/t2-install.sh owlab-luci-app-footstrap-cmd-pal2410 dist/all/…​.ipk opkg
  tools/t2-install.sh owlab-luci-app-footstrap-cmd-pal2512 dist/noarch/…​.apk apk
  PALETTE_BASE=http://localhost:8040 node tools/probe.mjs
  ```

  **The theme must be installed as a PACKAGE first**, not synced: `LUCI_DEPENDS` names it, so
  neither package manager will install this one without it. That is also the only way to test the
  thing that matters most — see below.

  Four things this tier caught that nothing else could:

  - **The token fallbacks are load-bearing, and now measured on a real build.** In the theme's
    shipped `cascade.css`, `--fs-glass`, `--fs-z-popover` and `--fs-space-2` occur **0 times**
    while `--fs-accent` (77) and `--fs-text` (81) survive. The bar still computes to
    `position: fixed; z-index: 850` because every `var()` falls back. Without the fallbacks it
    would have no background, no z-index and no padding — on every real install, and on no stand.
  - **The postrm guard, on a REAL version upgrade, both managers.** `opkg install` of the same
    version is a no-op ("already up to date"), so re-installing proves nothing, and `owlab build`
    does not forward `FOOTSTRAP_VERSION` into its SDK container. What makes a genuine upgrade
    possible anyway is the thing that is otherwise a defect: with no git tag, `findrev` derives the
    version from mtimes, so any two builds of an edited tree differ. Two builds a day apart gave
    `0.260831.76478` and `0.260831.79550`, and both paths were then walked for real:

    ```
    opkg:  Upgrading luci-app-footstrap-cmd on root from 0.260831.76478 to 0.260831.79550
    apk:   Upgrading luci-app-footstrap-cmd (0.260831.76478 -> 0.260831.79550)
             Executing luci-app-footstrap-cmd-0.260831.79550.post-upgrade
    ```

    `footstrap.settings.plugin` still read `fs-cmd` after each, and all 31 commands were present
    in the upgraded files. The apk line also confirms the claim the postrm comment rests on: apk
    runs the NEW package's `post-upgrade` and never the old one's `post-deinstall`, which is why
    guarding on `$1` is correct for opkg and harmless for apk.

    The guard is additionally checked in isolation by `tools/t2-install.sh`, which calls
    `sh /usr/lib/opkg/info/luci-app-footstrap-cmd.postrm upgrade` directly — it must exit 0 and
    leave the registration alone, while `… postrm remove` must clear it.
  - **`owlab build -out` copies out only the NAMED package**, so `luci-i18n-footstrap-cmd-ru`
    never reaches `dist/` even though the SDK builds it. Confirmed by building the same tree in the
    SDK image by hand, which emits both `luci-app-footstrap-cmd_0.1.0-r1_all.ipk` and
    `luci-i18n-footstrap-cmd-ru_0.260901.24779_all.ipk`; the i18n package's own version is
    derived from `po/` separately and is NOT pinned by `FOOTSTRAP_VERSION`. The proof is in the build log (`po2lmo`,
    `footstrap-cmd.ru.lmo`), which is what `T2_BUILD_LOG` points the inspector at. Not a defect
    — but the log has to be the FULL one: a build script that pipes owlab through `tail` cuts the
    po2lmo line and the inspector then reports a regression that is its own.
  - **An apk is not a tar.** OpenWrt's apk v3 is an ADB container (`ADBd` magic); its payload comes
    out with `apk extract` and its metadata and scripts with `apk adbdump`, both run on a 25.12
    router. The ipk keeps ours in `CONTROL/postinst-pkg`, never `CONTROL/postinst` — that one is
    OpenWrt's generated wrapper calling `default_postinst`, which is what runs uci-defaults.

  One stand defect, not a package one: the owlab 24.10 image ships an `/etc/opkg.conf` with no
  `arch` lines at all, so opkg rejects an `all` package as "incompatible with the architectures
  configured". `tools/t2-install.sh` restores the stock lines before installing.

**Never lower a tier on your own**, and never idle against a running command: anything over five
minutes is T2, started detached with the theme's `tools/bg.sh`, run-id reported.

## Commits

Conventional Commits, message in English. **Never commit or push without an explicit instruction for
that action, each time** — finished work and green checks are not authorization. No co-author,
"Generated with" or AI attribution trailers.

## Status, and what is open

Feature-complete for the commands it ships and green on T0 and T1. Known gaps, in the order they
matter:

- **CI runs T0 and the catalogue gate only.** T1 needs a browser against a live LuCI and T2 a real
  package build with both managers; both need docker and owlab, so both are run by hand. The
  workflow says so rather than pretending. `tools/probe.mjs` borrows playwright from the theme's
  checkout because this package has no `node_modules` of its own.
- **The version is not stable across builds, and a tag does not fix it.** `luci.mk`'s `findrev`
  reads `git log -1 --format="%ct %h"` — the last COMMIT's timestamp and hash, never a tag — and
  falls back to file mtimes when there is no `.git`, which is the case inside `owlab build`: the
  package is copied into the SDK container without it. So an owlab build is `0.<yymmdd>.<secs>` and
  differs run to run. `FOOTSTRAP_VERSION` is the only way to pin a release version and whatever
  builds a release has to set it; `owlab build` does not forward it into the container, so a
  release cannot be cut through owlab.
- **No feed and no `install.sh`.** JS is checked by parser and by jsmin round-trip only;
  the theme's eslint config assumes its own globals and paths.
- **`po/ru` only.** The catalogue is complete (93/93), `./update-po.sh --check` gates it, and
  `tools/i18n-probe.mjs` proves it is actually loaded on a router — 806 Cyrillic characters in
  `:help` with the ru package installed, which reading the files cannot settle because an
  uncompiled `_()` falls through to its English msgid in silence. Every other language falls
  through to English.
- **The command table is a constant**, not something a third package could extend.
- **No cancellation.** `:ping` runs for three seconds and `:trace` longer; Escape discards the
  ANSWER (the generation counter) but the tool keeps running on the router. Nothing that takes
  minutes — a package install, a sysupgrade — may be added until there is a real abort.
- **`:kill` completes nothing**: the pid is typed and validated against `^\d+$`. Completing it
  would mean holding a process list the moment the bar opens, which is a round trip every session
  pays for a command few run; `:ps` prints the pids instead.
