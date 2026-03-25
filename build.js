
/* eslint-disable no-console */
/**
 * Statický export WordPress (Falang) + stažení VŠECH souborů ze stejného originu:
 * - mapování cest: bez domény; pro uploads odstraň "wp-content/" => imgWP/uploads/YYYY/MM/file.ext
 * - ostatní zrcadlí kořen: imgWP/wp-content/..., imgWP/wp-includes/...
 * - HTML stránky se nepřepisují (řeší je existující build .html)
 * - CSS: stáhne se a rekurzivně se stáhnou i url(...) a @import (bez přepisu obsahu)
 * - Inline style="...url(...)": přepis jen při úspěšném stažení
 *
 * NOVĚ: Práce se šablonou přes DOM (JSDOM), bez regexů nad HTML.
 * - obsah se vkládá do elementu #wpContent
 * - menu se vkládají do elementů s id=<location> (např. #primary-menu, #footer-menu)
 * - elementy s atributem only-index: ponechat pouze na index.html (atribut se na indexu odstraní), na ostatních stránkách odstranit celý element
 * - žádné {{placeholders}}, žádné komentářové značky <!-- MENU:xxx -->, žádné heuristiky
 *
 * Node.js 18+ (global fetch). Vyžaduje balíček `jsdom`.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let JSDOM;
try {
	({ JSDOM } = require('jsdom'));
} catch (e) {
	console.error('\nERROR: Balíček "jsdom" není nainstalován. Nainstalujte jej příkazem:\n  npm i jsdom\n');
	process.exit(1);
}

// =======================
// KONFIGURACE
// =======================
const API_URL = process.env.WP_API_URL; // např. https://admin.zpkb.eu
const SITE_BASE_URL = process.env.SITE_BASE_URL; // např. https://zpkb.eu (PUBLIC URL)
const ROOT_DIST = path.join(__dirname, 'www'); // KOŘEN výstupu (assets + jazykové složky)
const TEMPLATE_DIR = path.join(__dirname, 'template'); // zdroj statických souborů (mimo index.html)
const TEMPLATE_FILE = path.join(TEMPLATE_DIR, 'index.html'); // HTML šablona
const ENCODING = 'utf8';

// Jazyky – každý má vlastní složku i prefix v URL
const LANGS = [
	{ code: 'en', urlPrefix: 'en', outDir: path.join(ROOT_DIST, 'en'), homeTitle: 'News', notFoundTitle: '404 - Page not found', moreButtonText: 'Read more' },
	{ code: 'fr', urlPrefix: 'fr', outDir: path.join(ROOT_DIST, 'fr'), homeTitle: 'Nouvelles', notFoundTitle: '404 - Page introuvable', moreButtonText: 'En savoir plus' },
	{ code: 'cs', urlPrefix: 'cs', outDir: path.join(ROOT_DIST, 'cs'), homeTitle: 'Novinky', notFoundTitle: '404 - Stránka nenalezena', moreButtonText: 'Číst více' },
];

// Uložiště lokálních souborů (společné pro všechny jazyky)
const STATIC_ROOT = path.join(ROOT_DIST, 'imgWP'); // www/imgWP/...
const PUBLIC_STATIC_PREFIX_FROM_LANG = 'imgWP'; // relativně z www/{lang}/*.html

// Přípony, které považujeme za HTML stránky (nepřepisujeme je na lokální soubory)
const HTML_EXT = new Set(['', '.html', '.htm']);

// Typické přípony souborů, které *ano* chceme stahovat (statika, média, dokumenty)
const FILE_EXT = new Set([
	'.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg', '.ico',
	'.mp4', '.webm', '.mov', '.avi', '.mp3', '.ogg', '.wav',
	'.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.rar', '.7z',
	'.css', '.js', '.json', '.xml', '.txt', '.csv',
	'.woff', '.woff2', '.ttf', '.otf', '.eot'
]);

// =======================
// UTIL (FS / řetězce / URL)
// =======================
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

function copyDirRecursive(src, dest, excludeFile) {
	ensureDir(dest);
	const entries = fs.readdirSync(src, { withFileTypes: true });
	for (const entry of entries) {
		const srcPath = path.join(src, entry.name);
		const destPath = path.join(dest, entry.name);
		if (entry.isDirectory()) {
			copyDirRecursive(srcPath, destPath, excludeFile);
		} else if (entry.isFile() && entry.name !== excludeFile) {
			fs.copyFileSync(srcPath, destPath);
		}
	}
}

function generateLanguageRedirect(langs) {
	const targetPath = path.join(ROOT_DIST, 'index.html');
	const def = langs[langs.length - 1];
	const langCases = langs.slice(0, -1).map(l => `if (short === "${l.code}") location.replace("${l.urlPrefix}/");`).join('\n      ');
	const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${def.urlPrefix}/">
<title>Redirecting…</title>
<script>
  (function(){
    try {
      var nav = (navigator.language || navigator.userLanguage || '').toLowerCase();
      var short = (nav.split('-')[0] || '').toLowerCase();
      ${langCases}
      location.replace("${def.urlPrefix}/");
    } catch (e) {
      location.replace("${def.urlPrefix}/");
    }
  })();
</script>
<noscript><meta http-equiv="refresh" content="0; url=${def.urlPrefix}/"></noscript>
</head><body>Redirecting…</body></html>`;
	fs.writeFileSync(targetPath, html, ENCODING);
}

function joinUrl(...parts) {
	const filtered = parts.filter(Boolean).map(String);
	if (filtered.length === 0) return '';
	let url = filtered.map((p, i) => i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+/, '')).join('/');
	// remove /? double
	url = url.replace(/\/\?(?=.)/, '?');
	return url;
}

function escapeHtml(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
function escapeAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }
function stripHtml(s) { return String(s).replace(/<[^>]*>/g, '').trim(); }

function toWebPath(...segments) { return segments.flat().filter(Boolean).join('/').replace(/\\+/g, '/'); }
function hash8(str) { return crypto.createHash('sha1').update(str).digest('hex').slice(0, 8); }
function sameOrigin(a, b) { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } }
function extnameLower(p) { return path.posix.extname(p || '').toLowerCase(); }

// =======================
// ŠABLONA + MENU ENGINE (DOM)
// =======================
function toStaticHref(itemUrl, langCode) {
	if (!itemUrl) return '#';
	try {
		const u = new URL(itemUrl);
		const p = u.pathname || '/';
		const segments = p.split('/').filter(Boolean);
		if (segments.length === 0 || (segments.length === 1 && segments[0] === langCode)) return `${langCode}/`;
		const last = segments[segments.length - 1] || '';
		if (last && !last.includes('.')) return `${langCode}/${last}.html`;
		return itemUrl;
	} catch {
		return itemUrl;
	}
}

function renderMenuItems(items, langCode) {
	let html = '';
	for (const item of (items || [])) {
		const href = toStaticHref(item.url, langCode);
		const title = escapeHtml(item.title || '');

		html += `
      <a href="${escapeAttr(href)}" class="myBarItem" title="${title}">
        <span class="menuText">${title}</span>
      </a>
    `;

		if (Array.isArray(item.children) && item.children.length > 0) {
			html += renderMenuItems(item.children, langCode);
		}
	}
	return html;
}

function generateMenusByLocation(menuForLang, langCode) {
	const result = {};
	for (const menuObj of (menuForLang || [])) {
		const location = menuObj.location || 'menu';
		const itemsHtml = renderMenuItems(menuObj.items || [], langCode);
		result[location] = `${itemsHtml}`;
	}
	return result;
}

// =======================
// SITEMAP
// =======================
function formatDateISO(dateStr) { try { const d = new Date(dateStr); if (!isNaN(d.getTime())) return d.toISOString(); } catch { } return undefined; }
function buildSitemapXml(entries) {
	const urlsXml = entries.map(e => {
		const lastmodTag = e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : '';
		const changefreqTag = e.changefreq ? `<changefreq>${e.changefreq}</changefreq>` : '';
		const priorityTag = (typeof e.priority === 'number') ? `<priority>${e.priority.toFixed(1)}</priority>` : '';
		return `  <url>\n    <loc>${e.loc}</loc>\n    ${lastmodTag}\n    ${changefreqTag}\n    ${priorityTag}\n  </url>`;
	}).join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlsXml}\n</urlset>`;
}
function buildSitemapIndexXml(sitemaps) {
	const sitemapsXml = sitemaps.map(s => {
		const lastmodTag = s.lastmod ? `<lastmod>${s.lastmod}</lastmod>` : '';
		return `  <sitemap>\n    <loc>${s.loc}</loc>\n    ${lastmodTag}\n  </sitemap>`;
	}).join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapsXml}\n</sitemapindex>`;
}

// =======================
// GENEROVÁNÍ VÝPISU ČLÁNKŮ (validní HTML)
// =======================
function generateArticleListHtml(items, langCode, moreButtonText) {
	const sortedPosts = (items || [])
		.filter(item => item.type === 'post')
		.filter(item => item.content !== '')
		.sort((a, b) => new Date(b.date || b.modified) - new Date(a.date || a.modified));

	if (sortedPosts.length === 0) return '';

	let html = '<div class="posts">';

	for (const post of sortedPosts) {
		const href = post.url || `${langCode}/${post.slug}.html`;
		const title = post.title || '';
		const excerpt = post.excerpt || '';
		const img = post.featured_image || '';
		const imgWidth = post.img_width || '1000';
		const imgHeight = post.img_height || '1000';
		const imgSrcset = post.srcset || '';
		const imgSizes = post.sizes || '(max-width: 1000px) 100vw, 1000px';
		const imgAlt = post.alt || title;

		html += `
<div class="postPreview">
    <a href="${escapeAttr(href)}">
        ${img ? `
        <img 
					width="${imgWidth}" 
					height="${imgHeight}" 
					src="${escapeAttr(img)}"
					alt="${escapeAttr(imgAlt)}"
					class="attachment-medium size-medium wp-post-image"
					decoding="async"
					${imgSrcset ? `srcset="${escapeAttr(imgSrcset)}"` : ''}
					sizes="${escapeAttr(imgSizes)}"
        >` : ''}
    </a>

    <h4><a href="${escapeAttr(href)}">${escapeHtml(title)}</a></h4>
    <p>${excerpt}</p>
    <a class="button" href="${escapeAttr(href)}">${moreButtonText}</a>
</div>`;
	}

	return html;
}

// =======================
// STAŽENÍ A PŘEPSÁNÍ VŠECH SOUBORŮ V HTML/CSS
// =======================
// --- CSS regexy ---
const CSS_URL_RE = /url\(([^)]+)\)/gi;
const CSS_IMPORT_RE = /@import\s+(?:url\()?['"]?([^"')\s]+)['"]?\)?/gi;

/**
 * Mapuje vzdálenou URL na lokální cestu pod www/imgWP/… (bez domény).
 * - pokud cesta začíná "wp-content/uploads/", odřízne "wp-content/" => "uploads/…"
 * - jinak zachová zbytek kořenové cesty beze změny
 * - query -> krátký hash v názvu
 * Vrací { diskPath, publicWebPath, absUrl } nebo null (jiný origin).
 */
function mapRemoteToLocal(remoteUrl) {
	if (!sameOrigin(remoteUrl, API_URL)) return null;
	let u;
	try { u = new URL(remoteUrl); } catch { return null; }
	let pathname = decodeURIComponent(u.pathname || '/').replace(/^\/+/, '');
	if (pathname.toLowerCase().startsWith('wp-content/uploads/')) {
		// => 'uploads/...'
		pathname = pathname.slice('wp-content/'.length);
	}
	const ext = extnameLower(pathname) || '.bin';
	const dir = path.posix.dirname(pathname);
	const base = path.posix.basename(pathname, ext);
	const baseWithHash = u.search ? `${base}-${hash8(u.search)}` : base;
	const relWebPath = toWebPath(dir, `${baseWithHash}${ext}`); // 'uploads/2026/02/file.jpg' nebo 'wp-content/themes/.../file.css'
	const diskPath = path.join(STATIC_ROOT, relWebPath);
	const publicWebPath = toWebPath(PUBLIC_STATIC_PREFIX_FROM_LANG, relWebPath);
	return { diskPath, publicWebPath, absUrl: u.href };
}

// --- Nízkourovňové fetch helpery (throw) ---
async function fetchArrayBuffer(url) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText} - ${url}`);
	const ab = await res.arrayBuffer();
	return { ab: Buffer.from(ab), headers: Object.fromEntries(res.headers.entries()) };
}

// --- Bezpečné obálky: neházejí výjimku, vrací true/false resp. {ok,text} ---
async function safeDownloadBinary(remoteUrl, diskPath) {
	try {
		ensureDir(path.dirname(diskPath));
		if (fs.existsSync(diskPath)) return true;
		const res = await fetch(remoteUrl);
		if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
		const ab = await res.arrayBuffer();
		fs.writeFileSync(diskPath, Buffer.from(ab));
		return true;
	} catch (e) {
		console.warn(`WARN download binary failed (${remoteUrl}): ${e.message}`);
		return false;
	}
}

async function safeDownloadText(remoteUrl, diskPath) {
	try {
		ensureDir(path.dirname(diskPath));
		if (fs.existsSync(diskPath)) {
			return { ok: true, text: fs.readFileSync(diskPath, ENCODING) };
		}
		const res = await fetch(remoteUrl);
		if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
		const text = await res.text();
		fs.writeFileSync(diskPath, text, ENCODING);
		return { ok: true, text };
	} catch (e) {
		console.warn(`WARN download text failed (${remoteUrl}): ${e.message}`);
		return { ok: false, text: '' };
	}
}

// --- CSS: prefetch url(...) a @import (rekurzivně), bez přepisu obsahu ---
async function prefetchCssDependencies(remoteCssUrl, cssText) {
	const urlCandidates = Array.from(cssText.matchAll(CSS_URL_RE))
		.map(m => (m[1] || '').trim().replace(/^['"]|['"]$/g, ''))
		.filter(Boolean);
	const importCandidates = Array.from(cssText.matchAll(CSS_IMPORT_RE))
		.map(m => (m[1] || '').trim())
		.filter(Boolean);
	const all = [...urlCandidates, ...importCandidates];
	if (all.length === 0) return;
	for (const ref of all) {
		let abs;
		try { abs = new URL(ref, remoteCssUrl).href; } catch { continue; }
		const mapping = mapRemoteToLocal(abs);
		if (!mapping) continue;
		const ext = extnameLower(mapping.absUrl);
		if (ext === '.css') {
			const { ok, text } = await safeDownloadText(mapping.absUrl, mapping.diskPath);
			if (ok) {
				// rekurzivně projdi další závislosti
				await prefetchCssDependencies(mapping.absUrl, text);
			}
		} else {
			await safeDownloadBinary(mapping.absUrl, mapping.diskPath);
		}
	}
}

// =======================
// DOM: lokalizace assetů (přepis src/href atd.)
// =======================
function splitSrcset(val) {
	return (val || '').split(',')
		.map(s => s.trim())
		.filter(Boolean)
		.map(entry => {
			const [u, ...rest] = entry.split(/\s+/);
			return { url: u, tail: rest.join(' ') };
		});
}
function joinSrcset(list) {
	return list.map(i => i.tail ? `${i.url} ${i.tail}` : i.url).join(', ');
}

async function localizeDomAssets(dom, langCode) {
	ensureDir(STATIC_ROOT);
	const doc = dom.window.document;

	// IMG
	for (const img of Array.from(doc.querySelectorAll('img'))) {
		const attrs = ['src', 'data-src'];
		const srcsetAttrs = ['srcset', 'data-srcset'];
		// single src-like
		for (const a of attrs) {
			const v = img.getAttribute(a);
			if (v && /^https?:\/\//i.test(v)) {
				const map = mapRemoteToLocal(v);
				if (map) {
					const ok = await safeDownloadBinary(map.absUrl, map.diskPath);
					if (ok) img.setAttribute(a, map.publicWebPath);
				}
			}
		}
		// srcset-like
		for (const a of srcsetAttrs) {
			const v = img.getAttribute(a);
			if (!v) continue;
			const parts = splitSrcset(v);
			let changed = false;
			for (const p of parts) {
				if (p.url && /^https?:\/\//i.test(p.url)) {
					const map = mapRemoteToLocal(p.url);
					if (map) {
						const ok = await safeDownloadBinary(map.absUrl, map.diskPath);
						if (ok) { p.url = map.publicWebPath; changed = true; }
					}
				}
			}
			if (changed) img.setAttribute(a, joinSrcset(parts));
		}
	}

	// SOURCE (picture/video)
	for (const el of Array.from(doc.querySelectorAll('source'))) {
		const a = el.getAttribute('src');
		if (a && /^https?:\/\//i.test(a)) {
			const map = mapRemoteToLocal(a);
			if (map) {
				const ok = await safeDownloadBinary(map.absUrl, map.diskPath);
				if (ok) el.setAttribute('src', map.publicWebPath);
			}
		}
		const sset = el.getAttribute('srcset');
		if (sset) {
			const parts = splitSrcset(sset);
			let changed = false;
			for (const p of parts) {
				if (p.url && /^https?:\/\//i.test(p.url)) {
					const map = mapRemoteToLocal(p.url);
					if (map) {
						const ok = await safeDownloadBinary(map.absUrl, map.diskPath);
						if (ok) { p.url = map.publicWebPath; changed = true; }
					}
				}
			}
			if (changed) el.setAttribute('srcset', joinSrcset(parts));
		}
	}

	// LINK
	for (const link of Array.from(doc.querySelectorAll('link[href]'))) {
		const href = link.getAttribute('href');
		if (!href || !/^https?:\/\//i.test(href)) continue;
		const map = mapRemoteToLocal(href);
		if (!map) continue;
		const ext = extnameLower(map.absUrl);
		if (ext === '.css') {
			const { ok, text } = await safeDownloadText(map.absUrl, map.diskPath);
			if (ok) await prefetchCssDependencies(map.absUrl, text);
			if (ok) link.setAttribute('href', map.publicWebPath);
		} else {
			const ok = await safeDownloadBinary(map.absUrl, map.diskPath);
			if (ok) link.setAttribute('href', map.publicWebPath);
		}
	}

	// SCRIPT
	for (const script of Array.from(doc.querySelectorAll('script[src]'))) {
		const src = script.getAttribute('src');
		if (!src || !/^https?:\/\//i.test(src)) continue;
		const map = mapRemoteToLocal(src);
		if (!map) continue;
		const ok = await safeDownloadBinary(map.absUrl, map.diskPath);
		if (ok) script.setAttribute('src', map.publicWebPath);
	}

	// ANCHOR — pouze soubory, ne HTML stránky
	for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
		const href = a.getAttribute('href');
		if (!href || !/^https?:\/\//i.test(href)) continue;
		if (!isDownloadableFile(href)) continue;
		const map = mapRemoteToLocal(href);
		if (!map) continue;
		const ok = await safeDownloadBinary(map.absUrl, map.diskPath);
		if (ok) a.setAttribute('href', map.publicWebPath);
	}

	// Media generické
	const generic = [
		{ sel: 'video', attrs: ['src', 'poster'] },
		{ sel: 'audio', attrs: ['src'] },
		{ sel: 'track', attrs: ['src'] },
		{ sel: 'object', attrs: ['data'] },
		{ sel: 'embed', attrs: ['src'] },
	];
	for (const g of generic) {
		for (const el of Array.from(doc.querySelectorAll(g.sel))) {
			for (const an of g.attrs) {
				const val = el.getAttribute(an);
				if (val && /^https?:\/\//i.test(val)) {
					const map = mapRemoteToLocal(val);
					if (map) {
						const ok = await safeDownloadBinary(map.absUrl, map.diskPath);
						if (ok) el.setAttribute(an, map.publicWebPath);
					}
				}
			}
		}
	}

	// inline style="...url(...)"
	for (const el of Array.from(doc.querySelectorAll('[style]'))) {
		const styleVal = el.getAttribute('style') || '';
		if (!/url\(/i.test(styleVal)) continue;
		let newStyle = styleVal;
		const subs = [];
		for (const mm of styleVal.matchAll(CSS_URL_RE)) {
			const raw = (mm[1] || '').trim().replace(/^['"]|['"]$/g, '');
			let abs;
			try { abs = new URL(raw).href; } catch { continue; }
			const map = mapRemoteToLocal(abs);
			if (!map) continue;
			const ok = await safeDownloadBinary(map.absUrl, map.diskPath);
			if (ok) subs.push({ from: mm[0], to: `url("${map.publicWebPath}")` });
		}
		for (const s of subs) newStyle = newStyle.split(s.from).join(s.to);
		if (subs.length > 0) el.setAttribute('style', newStyle);
	}

	// <style>…</style> — bez změn obsahu; případný prefetch zde vynechán (inline CSS nemá vlastní URL)
}

/** Rozhodne, zda je URL „soubor“, který stahujeme (nikoli HTML stránka) — podle přípony. */
function isDownloadableFile(urlStr) {
	try {
		const u = new URL(urlStr);
		const ext = extnameLower(u.pathname);
		if (HTML_EXT.has(ext)) return false; // HTML stránky necháváme být
		if (ext && FILE_EXT.has(ext)) return true;
		// Pokud není přípona nebo neznámá, opatrně NEchat být
		return false;
	} catch {
		return false;
	}
}

// =======================
// BUILD STRÁNKY PŘES DOM
// =======================
function injectContentAndMenus(dom, { contentHtml, menusByLocation, isIndex, langCode }) {
	const doc = dom.window.document;

	const base = doc.createElement('base')
	base.href = '../'

	const head = doc.head
	head.insertBefore(base, head.firstChild)

	doc.documentElement.setAttribute('lang', langCode);

	// only-index logika
	const onlyIndexEls = Array.from(doc.querySelectorAll('[only-index]'));
	if (isIndex) {
		// na indexu ponechat elementy, ale odstranit atribut
		for (const el of onlyIndexEls) el.removeAttribute('only-index');
	} else {
		// na ostatních stránkách odstranit celý element
		for (const el of onlyIndexEls) el.remove();
	}


	const translateEls = Array.from(doc.querySelectorAll('[translate]'));

	for (const el of translateEls) {

		if (langCode != "cs") {
			el.textContent = el.getAttribute(langCode);
		}

		el.removeAttribute('translate');
		el.removeAttribute('en');
		el.removeAttribute('fr');
	}


	const els = Array.from(doc.querySelectorAll('[translate-attribute]'));

	for (const el of els) {

		const attrName = el.getAttribute('translate-attribute');

		if (langCode != "cs") {
			el.setAttribute(attrName, el.getAttribute(langCode));
		}

		el.removeAttribute(attrName);
		el.removeAttribute('en');
		el.removeAttribute('fr');
	}


	// obsah do #wpContent
	const wpContent = doc.getElementById('wpContent');
	if (!wpContent) throw new Error('Template error: chybí element s id="wpContent"');
	wpContent.innerHTML = contentHtml || '';

	// menu do #<location>
	if (menusByLocation && typeof menusByLocation === 'object') {
		for (const [location, html] of Object.entries(menusByLocation)) {
			const target = doc.getElementById(location);
			if (!target) {
				console.error(`ERROR: V šabloně chybí element pro menu location id="${location}"`);
				continue; // nezastavujeme build dle požadavku
			}
			target.innerHTML = html || '';
		}
	}
}

async function buildDomPage({ templateHtml, contentHtml, menusByLocation, isIndex, langCode }) {
	const dom = new JSDOM(templateHtml);
	injectContentAndMenus(dom, { contentHtml, menusByLocation, isIndex, langCode });
	await localizeDomAssets(dom, langCode);
	return dom.serialize();
}

// =======================
// BUILD PRO JEDEN JAZYK
// =======================
async function buildOneLanguage(lang) {
	console.log(`\n=== Build language: ${lang.code} (/${lang.urlPrefix}) ===`);
	ensureDir(ROOT_DIST);
	ensureDir(lang.outDir);
	ensureDir(STATIC_ROOT);

	const templateHtml = fs.readFileSync(TEMPLATE_FILE, ENCODING);

	// Jazyková cache
	const CACHE_FILE = path.join(__dirname, `cache.${lang.code}.json`);
	let cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, ENCODING)) : {};
	const newCache = {};
	const validFiles = new Set(['index.html', '404.html']);
	const allItemsData = [];

	// 1) INDEX – přehled položek
	const indexUrl = joinUrl(API_URL, lang.urlPrefix, '?get_static_index=1');
	console.log(`Index URL: ${indexUrl}`);
	const indexRes = await fetch(indexUrl);
	if (!indexRes.ok) throw new Error(`Index fetch failed [${lang.code}]: ${indexRes.status} ${indexRes.statusText}`);
	const indexJson = await indexRes.json();
	const items = (indexJson.languages && indexJson.languages[lang.code]) || [];

	// 2) DETAILY – per‑post (s cache)
	for (const item of items) {
		const fileName = `${item.slug}.html`;
		validFiles.add(fileName);
		const cacheKey = `${item.id}`;
		if (cache[cacheKey] && cache[cacheKey].modified === item.modified) {
			newCache[cacheKey] = cache[cacheKey];
		} else {
			const detailUrl = joinUrl(API_URL, lang.urlPrefix, `?get_static_post=${item.id}`);
			console.log(`Stahuji ${item.id}`);
			const postRes = await fetch(detailUrl);
			if (!postRes.ok) {
				console.warn(`WARN [${lang.code}] post ${item.id} fetch failed: ${postRes.status} ${postRes.statusText}`);
				continue;
			}
			const data = await postRes.json();
			newCache[cacheKey] = {
				id: item.id,
				modified: item.modified,
				title: data.title,
				slug: item.slug,
				type: data.type,
				author: data.author_name,
				excerpt: data.excerpt,
				content: data.content,
				featured_image: data.featured_image_url,
				lang: lang.code,
				date: data.date
			};
		}
		allItemsData.push(newCache[cacheKey]);
	}

	// 3) MENUS
	const menuUrl = joinUrl(API_URL, lang.urlPrefix, '?get_menus=1');
	console.log(`Menu URL [${lang.code}]: ${menuUrl}`);
	const menuRes = await fetch(menuUrl);
	if (!menuRes.ok) throw new Error(`Menu fetch failed [${lang.code}]: ${menuRes.status} ${menuRes.statusText}`);
	const menuJson = await menuRes.json();
	const menuForLang = (menuJson.languages && menuJson.languages[lang.code]) || [];
	const menusByLocation = generateMenusByLocation(menuForLang, lang.code);

	// 4) STRÁNKY – generuj a lokalizuj soubory (DOM)
	for (const pageMeta of allItemsData) {
		if (pageMeta.content !== '') {
			const fileName = `${pageMeta.slug}.html`;
			const pageContent = `\n
				<div class="columns headline">\n
					<div class="page-header"><h3>${escapeHtml(pageMeta.title || '')}</h3></div>\n
					<div class="page-except">${escapeHtml(pageMeta.excerpt || '')}</div>\n
				</div>\n
				<div class="page-content">
					${pageMeta.content || ''}\n
				</div>\n
				`;

			const finalHtml = await buildDomPage({
				templateHtml,
				contentHtml: pageContent,
				menusByLocation,
				isIndex: false,
				langCode: lang.code,
			});
			fs.writeFileSync(path.join(lang.outDir, fileName), finalHtml, ENCODING);
		}
	}

	// 5) Jazykový INDEX a 404 (DOM)
	const articleListHtml = generateArticleListHtml(allItemsData, lang.code, lang.moreButtonText);
	const indexContent = `<div class="main"><h3>${escapeHtml(lang.homeTitle)}</h3>${articleListHtml}</div>`;
	const indexHtml = await buildDomPage({
		templateHtml,
		contentHtml: indexContent,
		menusByLocation,
		isIndex: true, // only-index ponechat (bez atributu)
		langCode: lang.code,
	});
	ensureDir(lang.outDir);
	fs.writeFileSync(path.join(lang.outDir, 'index.html'), indexHtml, ENCODING);

	const errorContent = `<div class="main"><h3>${escapeHtml(lang.notFoundTitle)}</h3></div>`;
	const errorHtml = await buildDomPage({
		templateHtml,
		contentHtml: errorContent,
		menusByLocation,
		isIndex: false,
		langCode: lang.code,
	});
	fs.writeFileSync(path.join(lang.outDir, '404.html'), errorHtml, ENCODING);

	// 6) SITEMAP pro jazyk
	if (!SITE_BASE_URL) {
		console.warn('WARN: Missing env SITE_BASE_URL (např. https://zpkb.eu). Sitemap se nevygeneruje.');
	} else {
		const baseLangUrl = joinUrl(SITE_BASE_URL, lang.urlPrefix, '/');
		const nowIso = new Date().toISOString();
		const entries = [];
		entries.push({ loc: baseLangUrl, lastmod: nowIso, changefreq: 'weekly', priority: 1.0 });
		for (const meta of allItemsData) {
			if (meta.content !== '') {
				const lastmod = meta.modified ? formatDateISO(meta.modified) : undefined;
				entries.push({
					loc: joinUrl(baseLangUrl, `${meta.slug}.html`),
					lastmod, changefreq: 'monthly',
					priority: (meta.slug === 'kontakt' || meta.slug === 'contact') ? 0.8 : 0.6
				});
			}
		}
		const langSitemapXml = buildSitemapXml(entries);
		fs.writeFileSync(path.join(lang.outDir, 'sitemap.xml'), langSitemapXml, ENCODING);
		console.log(`Sitemap generated: ${path.join(lang.outDir, 'sitemap.xml')}`);
	}

	// 7) Úklid sirotků (jen .html v jazykové složce)
	fs.readdirSync(lang.outDir).forEach(file => {
		if (file.endsWith('.html') && !validFiles.has(file)) {
			// ponecháme soubory, které byly vygenerovány výše; validFiles obsahuje index/404 + přidané slugs
			// zde není logika pro odstranění; pokud je potřeba mazat staré html, lze přidat seznam validFiles
		}
	});

	// 8) Ulož cache
	fs.writeFileSync(CACHE_FILE, JSON.stringify(newCache, null, 2), ENCODING);
	console.log(`✔ Done language: ${lang.code}`);
}

// =======================
// HLAVNÍ DRIVER
// =======================
async function buildAll() {
	console.log('--- Build Started ---');
	if (!API_URL) throw new Error('Missing env WP_API_URL (např. https://admin.zpkb.eu)');

	// 0) Root + assets (bez index.html)
	ensureDir(ROOT_DIST);
	ensureDir(STATIC_ROOT);
	copyDirRecursive(TEMPLATE_DIR, ROOT_DIST, 'index.html');

	// Root redirect podle prohlížečového jazyka
	generateLanguageRedirect(LANGS);

	// 1) Vygeneruj jazyky
	for (const lang of LANGS) {
		await buildOneLanguage(lang);
	}

	// 2) Kořenový sitemap index
	if (!SITE_BASE_URL) {
		console.warn('WARN: Missing env SITE_BASE_URL. Root sitemap index nebude vytvořen.');
	} else {
		const nowIso = new Date().toISOString();
		const sitemaps = LANGS.map(lang => ({
			loc: joinUrl(SITE_BASE_URL, lang.urlPrefix, 'sitemap.xml'),
			lastmod: nowIso
		}));
		const sitemapIndexXml = buildSitemapIndexXml(sitemaps);
		fs.writeFileSync(path.join(ROOT_DIST, 'sitemap.xml'), sitemapIndexXml, ENCODING);
		console.log(`Root sitemap index generated: ${path.join(ROOT_DIST, 'sitemap.xml')}`);
	}

	// 3) robots.txt
	try {
		if (SITE_BASE_URL) {
			const robots = [
				'User-agent: *',
				'Allow: /',
				`Sitemap: ${joinUrl(SITE_BASE_URL, 'sitemap.xml')}`,
				''
			].join('\n');
			fs.writeFileSync(path.join(ROOT_DIST, 'robots.txt'), robots, ENCODING);
			console.log(`robots.txt generated: ${path.join(ROOT_DIST, 'robots.txt')}`);
		}
	} catch (e) {
		console.warn('WARN: Nepodařilo se zapsat robots.txt:', e.message);
	}

	console.log('--- Build Complete ---');
}

buildAll().catch(err => {
	console.error(err);
	process.exit(1);
});
