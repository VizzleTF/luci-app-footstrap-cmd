'use strict';
'require baseclass';
'require fs-palette-sections as sections';

/* The package's entry point — the one module named in `footstrap.settings.plugin`, which the
 * theme's chrome requires at the end of its init and knows nothing else about.
 *
 * It stays small on purpose: everything it turns on is either lazy (the command line arrives with
 * the first colon) or idle (the section index fills in between navigations). An admin who never
 * presses `:` pays for this file and the section source, nothing more.
 *
 * Note what is NOT required here: `fs-search`. The palette is fetched by the theme on the first
 * gesture and most sessions never make one, so a package that required it to register would pull
 * 4.5 KB onto every page for a list nobody opens. The section source is pushed onto
 * `window.__fsSearchSources` instead — the theme reads that array when it builds its pool. */

/* This package's stylesheet is loaded by this package: the theme's cascade.css is concatenated
 * from its own styles/ tree at package time and nothing outside that tree can join it.
 *
 * `data-fs-shell` is load-bearing and it is NOT the same attribute as `data-fs-chrome`. The theme
 * treats every sheet in the document as a view's until told otherwise —
 *
 *   fs-sheets.js: const VIEW_SHEETS =
 *     'style:not([data-fs-shell]), link[rel~="stylesheet"]:not([data-fs-shell])'
 *
 * — and its <head> observer is live before this runs (watchViewSheets() is first in the theme's
 * init, loadPlugins() last). Without the mark the chain is: the observer sees the new <link>,
 * judgeSheet() reads `el.sheet === null` on a sheet that has not loaded yet and rules it invasive,
 * rehostIntoThemeLayer() silences the original and claims the @import shim for the page that
 * happened to be open, and the next navigation calls scopeToCurrentPage(), which disables anything
 * owned by another page. The bar then loses its styling for the life of the document, on the first
 * navigation rather than at load, which is the hardest version of this to attribute.
 *
 * `data-fs-chrome` is a different seam with a different job: it marks a DOM ELEMENT as zone 1 so
 * the theme's fence (`:where(:not([data-fs-chrome],[data-fs-chrome] *))`) exempts it from a foreign
 * app's selectors. The bar itself carries it — see fs-palette-cmdline.js. On a <link> it does
 * nothing at all.
 *
 * The `?v=` is this package's own: L.resource() does not add one (only LuCI's SubstituteVersion
 * does, and it rewrites .ut and .htm templates, not a link built in JS), and every other asset on
 * the page carries it. Without it a package upgrade ships new modules to a browser still holding
 * the previous sheet. It is concatenated rather than passed to L.resource() as a query part,
 * because L.path() filters a part against [a-zA-Z0-9_.%=&;-] and would silently drop the `~` a
 * git-derived resource_version can carry. */
function addStylesheet() {
	if (document.getElementById('fs-palette-css')) return;
	const v = L.env.resource_version;
	document.head.appendChild(E('link', {
		'id': 'fs-palette-css',
		'rel': 'stylesheet',
		'data-fs-shell': '',
		'href': L.resource('../footstrap-palette/palette.css') + (v ? '?v=' + encodeURIComponent(v) : '')
	}));
}

/* `:` opens the command line, and nothing is fetched until it is pressed. The guard is the theme's,
 * copied deliberately rather than shared: a keystroke inside a field, a contenteditable or a
 * .cbi-dropdown belongs to whoever is typing, and fs-select.js's typeahead reads punctuation as a
 * search character. */
function wireColon() {
	let pending = false, mod = null;
	document.addEventListener('keydown', (ev) => {
		if (ev.defaultPrevented || ev.key !== ':' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
		if (ev.target.closest?.('input, textarea, select, [contenteditable], .cbi-dropdown')) return;
		ev.preventDefault();
		if (mod) { mod.open(); return; }
		if (pending) return;
		pending = true;
		window.L.require('fs-palette-cmdline').then((m) => { pending = false; mod = m; m.open(); },
			(e) => { pending = false; console.error('palette: the command line did not load', e); });
	});
}

addStylesheet();
wireColon();
sections.register();

return baseclass.extend({});
