# CLAUDE.md

`luci-app-footstrap-palette` — a companion package for **`luci-theme-footstrap`**, adding the two
things the theme's own page search does not do: a **`:` command line** and **search over the
sections inside a page**. Client-side only: four JS modules, one stylesheet, one uci-defaults
script. No server code, no ACL file, no menu entry.

**Communicate in Russian.** Code, comments, commit messages and PR text stay in English.

**The floor is the theme's floor: OpenWrt 24.10 and newer** (and ImmortalWrt). What the theme cannot
run on, this cannot either.

**Repo root is the workspace**; the shipped package is `luci-app-footstrap-palette/` one level down
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

Three seams, all of them the theme's, none of them naming this package:

1. **`footstrap.settings.plugin`** — a uci list. `header.ut` whitelists each entry to the shape of a
   LuCI module name and prints `window.__fsPlugins`; the chrome requires each name at the end of its
   init. This package's uci-defaults adds `fs-palette`; its postrm removes it.
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

`fs-router.onNavigate` and `fs-menutree.nodeForSegs` are also used, both exported by the theme.

**Never patch the theme from here, and never add a seam without needing it.** A change on the theme
side is a change to a shipped package with its own release stream; if one is unavoidable it goes in
the theme's tree with its own changelog entry, and this package keeps working against the theme
version that does not have it yet.

## The modules

| File | Owns | Loaded |
|---|---|---|
| `fs-palette.js` | the entry point: the `<link>`, the `:` binding, registering the source | every page (700 B) |
| `fs-palette-sections.js` | the section index: two harvesters, the cache, the palette rows | every page (3 154 B) |
| `fs-palette-cmdline.js` | the bar on the bottom edge: input, wildmenu, echo area, keys, history | on the first `:` (2 748 B) |
| `fs-palette-commands.js` | the command table, the gate, `suggest()` and `run()` | on the first `:` (6 368 B) |

Bytes after terser, as `luci.mk` minifies them. One concern per module, composed by calling:
`L.require` makes a singleton and raises `DependencyError` on a cycle, so a module can never
`extend` another.

## The rule that decides everything: no ACL of our own

**This package ships no `acl.d` file, and that is the design.** Every command runs against an ubus
object some LuCI module already grants, and each is offered only when the **menu node** carrying
that ACL group is present in the session's own, already ACL-filtered, `/admin/menu`:

| command | ubus / exec | gated on the node | which depends on |
|---|---|---|---|
| `:restart` `:start` `:stop` `:enable` `:disable` `:services` | `rc list`, `rc init` | `admin/system/startup` | `luci-mod-system-init` |
| `:reboot` | `system reboot` | `admin/system/reboot` | `luci-mod-system-reboot` |
| `:ping` | `/bin/ping` | `admin/network/diagnostics` | `luci-mod-network-diagnostics` |
| `:ip` | `network.interface dump` | — | `luci-base-network-status` |
| `:sys` | `system board`, `system info` | — | `luci-mod-status-index` |
| `:log` | `log read`, `/usr/libexec/syslog-wrapper` | — | `luci-mod-status-logs` |
| `:apply` `:revert` `:set` `:back` | none beyond the page you are on | — | — |

A grant here would hand every holder of this package's group a permission their LuCI account was
never given. **Adding an `acl.d` entry is a security change and needs `/security-review` in the
theme's checkout, not a judgement call.** Gating by node presence costs nothing: the tree is already
in the browser.

`reachable()` uses `tree.nodeForSegs` — **raw presence, never `resolveSegs`**: an alias resolves
somewhere else and would answer for a permission the session may not hold.

## The section index, and what it costs

Two harvesters, cheapest first:

1. **The rendered DOM**, on every navigation. Free — the page is already there — and the only source
   that sees third-party apps and the theme's own Appearance section, which no view file contains.
   Selectors are in `DOM_SEL`; `h4` and below are deliberately excluded, being field groups and
   status boxes that would bury the page in its own results.
2. **The view module's source**, at idle, for pages this session has not opened. Fetched at exactly
   the URL `luci.js` would use (`L.env.base_url` + the dotted name + the same `?v=`), so a page the
   router has already prefetched is a browser-cache hit and costs nothing.

Measured on a stock 25.12 stand carrying 20 third-party apps:

| | |
|---|---|
| view files the menu points at | 98 |
| their total size, served uncompressed by uhttpd | 1 189 KB |
| section and tab titles extracted | 214 |
| the resulting index | 6.7 KB |
| one session's harvest under the 256 KB budget | 24 pages, 340 KB |

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
after it stamps the page, leaving an observer on that node watching an orphan — plus a 3 s deadline.

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
# the agent's own stand (config outside every checkout, one router, ports 8035 / 2235)
owlab -c ../tmp/owlab-agent/owlab.yaml sync agent2512
owlab -c ../tmp/owlab-agent/owlab.yaml status

# this package's files on that stand
docker exec owlab-luci-theme-footstrap-agent-agent2512 ls /www/luci-static/resources/fs-palette-*.js

# what the index holds right now, from the browser console
L.require('fs-palette-sections').then(m => m.stats())
```

`owlab sync` never runs `/etc/uci-defaults` (that directory is router state), so the agent config's
`post_sync` repeats the `add_list` and touches the package database — the `?v=` every asset is
served under is the mtime of that database, and without moving it the browser keeps serving the
modules it already has and the page runs a mixture of old and new. Written up in the theme's
`docs/development.md`, "Caches while iterating".

## Verifying

No npm gate suite here yet. What must hold before a change is called done:

- **T0** — each edited module parses (`node -e "new Function(readFileSync(f))"`), and every `.ut` the
  theme's side touched compiles with `ucode -T -c -o /dev/null` (run it in the container; the host
  has no `ucode`).
- **T1** — a Playwright probe against `agent2512`: the plugin appears in `window.__fsPlugins`, `:`
  opens the bar, `:restart <Tab>` completes from the live `rc list`, a printing command prints, the
  index has rows, and a query finds a section. The console must be clean — the one 403 is the login
  POST before auth, not ours.
- **T2** — a real package build installed on both package managers. Not done for this package yet.

**Never lower a tier on your own**, and never idle against a running command: anything over five
minutes is T2, started detached with the theme's `tools/bg.sh`, run-id reported.

## Commits

Conventional Commits, message in English. **Never commit or push without an explicit instruction for
that action, each time** — finished work and green checks are not authorization. No co-author,
"Generated with" or AI attribution trailers.

## Status, and what is open

Prototype. Known gaps, in the order they matter:

- **No `po/`.** Strings are bare English literals, and `_()` with no catalogue renders in English
  silently, so this stays invisible until someone runs a translated UI.
- **No `git init`, no CI, no `package.json`/eslint config.** JS is checked by parser only; the
  theme's eslint config assumes its own globals and paths.
- **The command table is a constant**, not something a third package could extend.
- **`:log` and `:ping` are the only free-text commands**; everything else completes from live data.
