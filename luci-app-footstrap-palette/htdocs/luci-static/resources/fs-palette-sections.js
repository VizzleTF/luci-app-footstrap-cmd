'use strict';
'require baseclass';
'require fs-menutree as tree';
'require fs-router as router';
'require fs-prefs as prefs';
'require menu-footstrap-common as common';

/* Sections as search results: "footstrap" finds System -> Appearance, "port forward" finds the tab
 * rather than only the page that owns it.
 *
 * LuCI has no static index of what is INSIDE a page — a view is a JS module the browser evaluates,
 * and the section titles exist only once it has rendered. So the index is built two ways, cheapest
 * first:
 *
 *   1. from the RENDERED page, on every navigation. Free: the DOM is already there, it covers
 *      third-party apps and the theme's own Appearance section (which no view file contains), and
 *      it is the only source that sees what a page actually drew.
 *   2. from the view MODULE's source, at idle, for pages this session has not opened. Measured on
 *      a stock 25.12 router with 20 apps: 98 view files the menu points at, 1,189 KB in total,
 *      yielding 214 section and tab titles — a 6.7 KB index. That download is why this half is
 *      budgeted, idle-only and cached rather than eager.
 *
 * The cache is keyed on `L.env.resource_version`, the same `?v=` every asset is served under, so a
 * package upgrade invalidates it and nothing else has to. */

const KEY = 'fs-palette-sections';
/* Per SESSION, not per page: 256 KB is roughly a fifth of the whole corpus, so a fresh browser has
 * the complete index after five or so visits and never fetches again. It is a floor, not a cap —
 * the size of a view is not knowable before it is fetched, so the last one overshoots by its own
 * length: measured on a fresh stand, 24 pages indexed for 340 KB, the excess being one 82 KB
 * network/wireless. */
const BUDGET = 256 * 1024;
/* A page carries between 2 and 8 of these; 24 is a third-party app with a section per feature. */
const MAX_PER_PAGE = 24;
const TITLE_MIN = 2, TITLE_MAX = 60;
/* The theme's own, and it has to be: a row this walk does not reach is a row fs-search ranks
 * against pages that go one level deeper than it does. fs-search.js: `const MAX_DEPTH = 4`. */
const MAX_DEPTH = 4;
/* A view that never answers must not hold the queue: harvestSource() is the only thing that calls
 * idle() again, so one socket left open by a router mid-reboot would end the session's indexing. */
const FETCH_MS = 10000;

let _cache = { v: null, pages: {} };
let _spent = 0;
let _entries = null;

function version() {
	return String(L.env.resource_version || '');
}

function load() {
	let raw = null;
	try { raw = JSON.parse(prefs.lsGet(KEY) || 'null'); } catch (e) {}
	_cache = (raw && raw.v === version() && raw.pages && typeof raw.pages === 'object')
		? { v: raw.v, pages: raw.pages }
		: { v: version(), pages: {} };
}

function save() {
	prefs.lsSet(KEY, JSON.stringify(_cache));
}

/* Both harvesters land here. Storing an empty array is deliberate: it is what stops a page with no
 * sections being fetched again on every future visit. */
function record(path, titles) {
	const seen = new Set();
	const out = [];
	for (const t of titles) {
		const s = String(t || '').replace(/\s+/g, ' ').trim();
		if (s.length < TITLE_MIN || s.length > TITLE_MAX || seen.has(s)) continue;
		seen.add(s);
		out.push(s);
		if (out.length >= MAX_PER_PAGE) break;
	}
	const had = _cache.pages[path];
	if (had && had.length === out.length && had.every((v, i) => v === out[i])) return;
	_cache.pages[path] = out;
	save();
	_entries = null;
	/* what tells the palette its pool is stale; it rebuilds on the next keystroke */
	window.__fsSearchGen = (window.__fsSearchGen || 0) + 1;
}

/* ---- 1. the rendered page ------------------------------------------------ */

/* What LuCI and its apps actually put a section title in. `legend` is the CBI section frame, `h3`
 * the named section inside a map, `h2` the view's own heading, and the tab strip is a list of
 * titles by definition. Deliberately not every heading on the page: `h4` and below are field
 * groups and status boxes, which would bury the page itself in its own results. */
const DOM_SEL = '#view h2, #view legend, #view .cbi-section > h3, #view .cbi-tabmenu > li > a, #view .cbi-map > h2';

function harvestDom(segs) {
	/* Only a path build() will read back. A navigation resolves to whatever the dispatcher landed
	 * on, which is not always a node this walk indexes — `admin/status/overview` renders from a
	 * template rather than a view on some releases — and recording one of those wrote a row into
	 * localStorage on every visit that no search could ever return. Attributing to the nearest
	 * indexed ancestor is the useful half of that: a tab's sections belong to the page above it. */
	const path = jobPathFor(segs || []);
	if (!path) return;
	const found = [];
	document.querySelectorAll(DOM_SEL).forEach((el) => found.push(el.textContent));
	/* nothing rendered yet is not the same as a page with no sections, and recording the second
	 * would stop the JS half ever looking at it */
	if (found.length) record(path, found);
}

/* ---- 2. the view module's source ----------------------------------------- */

/* Where LuCI puts a section or tab title. Matched against the module SOURCE, which is the shipped
 * minified file — jsmin strips comments and whitespace but never rewrites a string literal, so
 * these hold on a router as well as in a checkout.
 *
 * Option labels (`.option(form.Value, 'x', _('Label'))`) are deliberately left out: 273 of them
 * against 214 section titles, and a search for "password" that lists eleven fields is worse than
 * one that lists the three pages carrying them. */
const SRC_RX = [
	/\.tab\(\s*'[^']*'\s*,\s*_\(\s*'([^']{2,60})'/g,
	/\.section\(\s*[A-Za-z.]+\s*,\s*(?:'[^']*'\s*,\s*)?_\(\s*'([^']{2,60})'/g,
	/new\s+form\.\w*Map\(\s*'[^']*'\s*,\s*_\(\s*'([^']{2,60})'/g,
	/E\(\s*'h[23]'\s*,\s*(?:\{[^}]*\}\s*,\s*)?\[?\s*_\(\s*'([^']{2,60})'/g
];

function titlesFromSource(src) {
	const out = [];
	for (const rx of SRC_RX) {
		rx.lastIndex = 0;
		let m;
		while ((m = rx.exec(src)) !== null) out.push(m[1]);
	}
	return out;
}

/* The URL luci.js itself would use for that module, byte for byte — base_url, the menu's view path
 * and the same `?v=`. That is the point: a page the router has already prefetched is served from
 * the browser cache and this fetch costs nothing. (`action.path` is already slash-separated; the
 * dot-to-slash rewrite in luci.js applies to the dotted MODULE name, which is not what this is.) */
function moduleUrl(viewPath) {
	const v = version();
	return L.env.base_url + '/view/' + viewPath + '.js' + (v ? '?v=' + v : '');
}

function harvestSource(job) {
	/* the page may have been rendered — and indexed from its DOM, which sees more — between the
	 * queue being built and this job coming up */
	if (job.path in _cache.pages) return Promise.resolve();

	const ctl = (typeof AbortController === 'function') ? new AbortController() : null;
	const timer = ctl ? window.setTimeout(() => ctl.abort(), FETCH_MS) : null;

	return fetch(moduleUrl(job.view), { credentials: 'same-origin', signal: ctl ? ctl.signal : undefined })
		.then((r) => {
			/* A 404 is a menu node whose package ships its view elsewhere: a permanent miss, and
			 * recording it empty is what stops the queue coming back to it. Any other non-OK is
			 * the SERVER having a bad moment (503 while rpcd restarts, 403 on a session that just
			 * expired) and must not be cached as "this page has no sections" for the life of the
			 * resource version. */
			if (r.ok) return r.text().then((src) => { _spent += src.length; record(job.path, titlesFromSource(src)); });
			if (r.status === 404) record(job.path, []);
			return null;
		})
		/* a network failure, an abort or an offline moment: leave the page unrecorded so a later
		 * session picks it up. The queue moves on either way. */
		.catch(() => null)
		.then(() => { if (timer) window.clearTimeout(timer); });
}

/* ---- the queue ----------------------------------------------------------- */

/* Every menu node that instantiates a view, with the title trail the palette needs to render it.
 *
 * The walk is the theme's, deliberately duplicated rather than approximated, because fs-search
 * ranks these rows against its own and both halves have to mean the same thing by `depth` and
 * `trail`. So: start INSIDE each mode (`admin`), which is a container rather than a destination —
 * its own title is not part of any page's trail — and stop at the same MAX_DEPTH. Getting this
 * wrong is not a crash: it shifts every section row's rank by a constant and prefixes every trail
 * with "Administration", which reads as a ranking quirk rather than as a bug. */
let _jobs = null, _jobPaths = null;

/* A theme too old to export `viewClassFor` falls back to what this module tested before: the node
 * is a page iff its action is a view. That loses Status -> Overview and nothing else, which is
 * what it lost before the seam existed — the same shape as the `remember` fallback. */
function viewClassOf(node) {
	if (typeof tree.viewClassFor === 'function') return tree.viewClassFor(node);
	if (node && node.action && node.action.type === 'view')
		return 'view.' + String(node.action.path).replace(/\//g, '.');
	return null;
}

function buildJobs() {
	const out = [];
	const root = tree.tree();
	if (!root) return out;

	const childrenOf = (node) => {
		const kids = (node && node.children) || {};
		const list = [];
		for (const name in kids) {
			const c = kids[name];
			if (!c || !c.satisfied || !c.title) continue;
			list.push({ name: name, node: c });
		}
		return list;
	};

	const walk = (node, segs, trail, depth) => {
		childrenOf(node).forEach((entry) => {
			const c = entry.node;
			/* the chrome carries its own Logout; the theme skips it here and so must this, or a
			 * section search could offer a row that signs the reader out */
			if (depth === 1 && entry.name === 'logout') return;
			const csegs = segs.concat([ entry.name ]);
			const title = _(c.title);
			/* `viewClassFor` and not `action.type === 'view'`, which is what this used to test.
			 * The theme's own rule for "is this node an SPA page" covers one node that is not a
			 * view: Status -> Overview is a `template` action pointing at `admin_status/index`,
			 * whose server template does nothing but instantiate view.status.index. Testing the
			 * action type directly left that page out of the index entirely, so its sections were
			 * harvested from the DOM on every visit, stored, and never returned by any search.
			 * Borrowing the theme's exported answer also means a second such node cannot appear
			 * on one side and not the other. */
			const cls = viewClassOf(c);
			if (cls) {
				out.push({
					path: csegs.join('/'),
					segs: csegs,
					/* back from the dotted module class to the path half of the URL luci.js would
					 * fetch: `view.status.index` -> `status/index` */
					view: cls.replace(/^view\./, '').replace(/\./g, '/'),
					title: title,
					trail: trail,
					depth: depth
				});
			}
			if (depth < MAX_DEPTH) walk(c, csegs, trail.concat([ title ]), depth + 1);
		});
	};

	/* Start INSIDE each mode, exactly as fs-search's buildIndex() does. The mode (`admin`) is a
	 * container and not a destination: it contributes its segment to the path, but its title is
	 * not part of any page's trail and its level is not a level. Walking from the root instead
	 * gave every page depth+1 and prefixed every trail with "Administration" — which then showed
	 * in the palette as "Administration › System › System" beside the theme's own "System", and
	 * put the word into the `p` haystack, so a search for "administration" matched every section
	 * and no page. */
	childrenOf(root).forEach((mode) => walk(mode.node, [ mode.name ], [], 1));

	return out;
}

/* Walked once: the tree is fixed for the life of the document, and this is called from build() on
 * every cache miss as well as from buildQueue(). */
function jobs() {
	if (!_jobs) {
		_jobs = buildJobs();
		_jobPaths = new Set(_jobs.map((j) => j.path));
	}
	return _jobs;
}

/* The longest indexed ancestor of a navigated path, itself included. */
function jobPathFor(segs) {
	jobs();
	const parts = segs.slice();
	while (parts.length) {
		const p = parts.join('/');
		if (_jobPaths.has(p)) return p;
		parts.pop();
	}
	return '';
}

let _queue = null;

/* Recents first: they are the pages this admin searches for, and their modules are the ones
 * fs-router has already warmed, so they are the cheapest rows in the index. Then smallest-first is
 * not knowable without fetching, so the rest keep menu order. */
function buildQueue() {
	/* the page half of each key: a recents entry is either a page path or one of its sections
	 * (`admin/system/system#Footstrap`), and both say the same thing about which page to index
	 * first */
	const recent = prefs.lsGetArr('fs-recent')
		.filter((x) => typeof x === 'string')
		.map(pageOfKey);
	const rank = (j) => {
		const i = recent.indexOf(j.path);
		return i < 0 ? 999 : i;
	};
	return jobs().filter((j) => !(j.path in _cache.pages)).sort((a, b) => rank(a) - rank(b));
}

function pump() {
	if (_spent >= BUDGET) return;
	if (!_queue) _queue = buildQueue();
	const job = _queue.shift();
	if (!job) return;
	harvestSource(job).then(idle);
}

function idle() {
	if (_spent >= BUDGET || (_queue && !_queue.length)) return;
	if (typeof window.requestIdleCallback === 'function')
		window.requestIdleCallback(pump, { timeout: 8000 });
	else
		window.setTimeout(pump, 3000);
}

/* ---- landing ON the section ----------------------------------------------
 *
 * A section row's href can only reach the page: the theme's palette builds it from the menu segs,
 * and there is no URL for "the Logging tab of System". So the row carries an `onTake` the palette
 * calls when it is chosen, and this is what it does — open the tab the section sits behind and
 * scroll to it.
 *
 * It matters most in the case that looks broken without it: searching from the page the section is
 * already on. The href is then the current URL, the router correctly does nothing, the palette
 * closes and the screen has not moved — which reads as a dead result rather than as a no-op.
 *
 * One mechanism, not two: a MutationObserver on #maincontent, because a SPA arrival renders the
 * view after the navigation resolves and there is nothing else to wait on. Bound to #maincontent
 * rather than #view — the router REPLACES #view right after it stamps the page, so an observer
 * bound to that node is watching an orphan. The deadline is what ends it; there is no retry ladder
 * underneath.
 *
 * The request outlives its first success ON PURPOSE, and this is the part that is not obvious. A
 * row's href is a real link, so taking one on the page it already points at is still a navigation:
 * the router re-renders the view over whatever just happened. Measured on a stand, taking
 * "Footstrap" from the System page itself — the tab switched at 2009 ms, #view was emptied at
 * 2010 ms, and the strip was back on General Settings at 2161 ms. So the landing is re-applied on
 * every mutation until the deadline; it is idempotent (a tab already open is not clicked again)
 * and the flash and the scroll happen once, or the page would fight the reader.
 *
 * The deadline is generous because a tab is not always there when the view is: the theme's own
 * Appearance tab is appended by fs-appearance after the stock System page has rendered (measured
 * on a stand: the four stock tabs at 119 ms, Footstrap at 132 ms), and an app that builds its tabs
 * behind two RPCs is slower again. A window that expires while the page is still building fails
 * silently, which is the worst way to fail, so it is ten seconds — and it ends early anyway on the
 * next navigation, which is the real signal that the request is stale. */
const LAND_MS = 10000;
const FLASH_MS = 1400;

let _want = null, _observer = null;

/* ---- the key a section is remembered under ----
 *
 * The theme's recents list stores a key per row and resolves the title through the live pool, so a
 * row it cannot find is dropped rather than shown dead. A page's key is its menu path; a section
 * has no dispatcher node and so no path of its own, and `admin/system/system#Footstrap` — the page
 * plus the section's own heading — is the whole of what identifies it. Written through the theme's
 * `remember()` so the cap and the de-duplication have one implementation; a theme too old to
 * export it simply keeps no section in its recents, which is what it did before. */
function keyFor(path, title) {
	return path + '#' + title;
}

function pageOfKey(key) {
	const h = key.indexOf('#');
	return h < 0 ? key : key.slice(0, h);
}

function herePath() {
	const segs = tree.segsFromPath(window.location.pathname);
	return segs ? segs.join('/') : '';
}

function textOf(el) {
	return String(el.textContent || '').replace(/\s+/g, ' ').trim();
}

/* The tab strip first: a section behind a closed tab is not on the page at all, so scrolling to it
 * would scroll to nothing. Everything else is a heading already in the document.
 *
 * `first` is false on every re-application after a re-render: the tab is re-opened (it has to be,
 * the render closed it), but the page is not scrolled again and the flash is not repeated. */
/* Case-insensitively: the DOM half records what a page rendered and the source half what its JS
 * passed to `_()`, and a catalogue is free to differ from either in case alone. */
function sameTitle(el, title) {
	return textOf(el).toLowerCase() === title.toLowerCase();
}

function landOn(title, first) {
	const tab = Array.from(document.querySelectorAll('#view .cbi-tabmenu > li > a'))
		.filter((a) => sameTitle(a, title))[0];
	if (tab) {
		const li = tab.closest('li');
		/* `cbi-tab` is the open one, `cbi-tab-disabled` the rest; clicking the open tab again is
		 * harmless but re-runs the view's own tab handler on every mutation it makes */
		if (!li || !li.classList.contains('cbi-tab')) tab.click();
		if (first) flash(li || tab);
		refocus(tab);
		return true;
	}
	const head = Array.from(document.querySelectorAll(DOM_SEL))
		.filter((el) => sameTitle(el, title))[0];
	if (!head) return false;
	if (first) {
		head.scrollIntoView({ block: 'center', behavior: 'smooth' });
		flash(head);
	}
	refocus(head);
	return true;
}

/* An element that is not focusable by nature takes a -1 stop, the same shape the theme puts on
 * <main> for its skip link. */
const NATURALLY_FOCUSABLE = /^(?:a|button|input|select|textarea)$/i;

/* Focus follows the landing, because otherwise it lands nowhere near it. The router parks focus in
 * one of three places depending on how the row was activated, and none of them is the section:
 * the palette's Enter synthesises a click carrying `detail === 0`, which the router reads as a
 * keyboard activation and answers by focusing the skip link, so the reader gets the "Skip to
 * content" pill; a pointer activation focuses `#maincontent` instead (fs-router.js: `const main =
 * skip || document.getElementById('maincontent')`); and the re-render the router does over the
 * first landing (2009 ms -> 2161 ms on the stand, see above) throws focus back to <body>.
 *
 * So all three are treated as "focus is nowhere yet", and only those three — a reader who has
 * already clicked into a field on the page keeps it, which is also what stops this stealing focus
 * back after the deadline. Not first-only, because the second landing is the one that keeps it. */
function unclaimed(el) {
	if (!el || el === document.body) return true;
	if (el.classList && el.classList.contains('fs-skip')) return true;
	return el.id === 'maincontent';
}

function refocus(el) {
	if (!unclaimed(document.activeElement)) return;
	if (!NATURALLY_FOCUSABLE.test(el.tagName) && !el.hasAttribute('tabindex'))
		el.setAttribute('tabindex', '-1');
	try { el.focus({ preventScroll: true }); } catch (e) {}
}

/* Says "this is the thing you asked for" and gets out of the way. A class the stylesheet animates
 * rather than an inline style, so the colour is the theme's accent token like everything else. */
function flash(el) {
	el.classList.add('fs-pal-flash');
	window.setTimeout(() => el.classList.remove('fs-pal-flash'), FLASH_MS);
}

function tryLand() {
	if (!_want) return;
	if (Date.now() > _want.until) { _want = null; return; }
	if (herePath() !== _want.path) return;	/* the navigation has not landed yet */
	if (!landOn(_want.title, !_want.done)) return;
	/* Recorded on arrival, not when the row is chosen: a request that never finds its section is
	 * not a visit, and by now the theme has already recorded the PAGE from its own navigation, so
	 * the section sits above it in the list rather than under it. */
	if (!_want.done && typeof common.remember === 'function') common.remember(_want.key);
	_want.done = true;
}

function watch() {
	if (_observer) return;
	const root = document.getElementById('maincontent') || document.body;
	_observer = new MutationObserver(tryLand);
	_observer.observe(root, { childList: true, subtree: true });
}

function requestLanding(path, title) {
	_want = { path: path, title: title, key: keyFor(path, title), until: Date.now() + LAND_MS, done: false };
	watch();
	/* the same page needs no navigation and no mutation, so the first attempt is now */
	tryLand();
}

/* ---- what the palette lists ---------------------------------------------- */

/* Entries in exactly the shape fs-search's own index produces, because its search() ranks both
 * against one another: `t` the title, `p` the ancestors' titles, `n` the English path. `depth` is
 * one past the page's, so a page always outranks a section inside it on an equal match. */
function build() {
	const rows = [];
	for (const j of jobs()) {
		const titles = _cache.pages[j.path];
		if (!titles || !titles.length) continue;
		const trail = j.trail.concat([ j.title ]);
		const p = trail.join(' ').toLowerCase();
		const n = j.segs.slice(1).join(' ').toLowerCase();
		for (const title of titles) {
			/* a section repeating its own page's name is the page, listed twice */
			if (title.toLowerCase() === j.title.toLowerCase()) continue;
			rows.push({
				segs: j.segs, path: j.path, title: title, trail: trail, depth: j.depth + 1,
				t: title.toLowerCase(), p: p, n: n,
				/* what the recents list stores this row under, `path` being the page's and not
				 * this row's; see keyFor() */
				key: keyFor(j.path, title),
				/* the half of "go there" the href cannot carry; see requestLanding() */
				onTake: ((pth, ttl) => () => requestLanding(pth, ttl))(j.path, title)
			});
		}
	}
	return rows;
}

function entries() {
	if (!_entries) _entries = build();
	return _entries;
}

/* ---- wiring -------------------------------------------------------------- */

function register() {
	load();
	(window.__fsSearchSources = window.__fsSearchSources || []).push(entries);

	/* the page this full load rendered, and every SPA arrival after it. A view renders after the
	 * navigation resolves, so the DOM read waits for the frame the router paints. */
	const later = (segs) => window.setTimeout(() => harvestDom(segs), 300);
	later(L.env.dispatchpath || []);
	router.onNavigate((segs) => {
		/* a navigation AWAY is what makes a pending landing stale — the deadline above is only the
		 * backstop for a page that never finishes building */
		if (_want && _want.path !== (segs || []).join('/')) _want = null;
		later(segs);
	});

	/* the idle half does not run for someone the browser says is on a metered or saving
	 * connection — the same guard the theme's own recents warm-up uses */
	try { if (navigator.connection && navigator.connection.saveData) return; } catch (e) {}
	idle();
}

return baseclass.extend({
	register,
	entries,
	/* Every page this session can reach, for `:e` in fs-palette-commands. Exported rather than
	 * walked a third time: this module already owns the walk and is loaded on every page anyway, so
	 * the command table gets the list for nothing. Already ACL-filtered, because the menu blob it
	 * comes from is. */
	pages: () => jobs().map((j) => ({ path: j.path, segs: j.segs, title: j.title, trail: j.trail })),
	/* out of package, for a probe on a stand: what the index holds right now */
	stats: () => ({ v: _cache.v, pages: Object.keys(_cache.pages).length, rows: entries().length, spent: _spent })
});
