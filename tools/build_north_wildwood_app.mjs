import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const check = process.argv.includes('--check');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tools/app/manifest.json'), 'utf8'));
const outputs = new Map();
const replacements = new Map();
const readSources = entry => entry.sources.map(source => fs.readFileSync(path.join(root, source), 'utf8')).join('');
const version = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
const town = JSON.parse(fs.readFileSync(path.join(root, 'tools/app/town-profile.json'), 'utf8'));
const htmlEscape = text => String(text).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const embeddedJson = value => JSON.stringify(value).replace(/[<&]/g, char =>
  char === '<' ? '\\u003c' : '\\u0026');
const hasElevationContours = Boolean(town.config.assets?.elevationContoursPath);
const needsProj4 = hasElevationContours || Boolean(town.config.overlays?.legacyExactQuery);
for (const [tag, value] of Object.entries({
  'profile': embeddedJson(town.config),
  'webcams': embeddedJson(town.webcams),
  'page-title': htmlEscape(town.config.pageTitle),
  'town-name': htmlEscape(town.config.site.name),
  'optional-proj4': needsProj4 ? '<script src="https://unpkg.com/proj4@2.11.0/dist/proj4.js" defer></script>' : '',
  'optional-elevation-contours': hasElevationContours ? '<script src="./assets/3d/elevation-contours.js?v=shared" defer></script>' : '',
})) replacements.set(`<!-- floodmapper:${tag} -->`, value);

// Coalesce CSS only within its original cascade interval. External stylesheets
// and scripts are barriers; moving rules across either could change the UI.
for (const entry of manifest.styles) {
  outputs.set(entry.output, (outputs.get(entry.output) || '') + readSources(entry));
}
for (const entry of manifest.styles) {
  const token = `<!-- nww:style:${entry.id} -->`;
  replacements.set(token, entry.firstInBundle
    ? `<link rel="stylesheet" data-nww-style-bundle="${path.basename(entry.output, '.css')}" href="./${entry.output}?v=${version(outputs.get(entry.output))}">`
    : token);
}
for (const entry of manifest.scripts) {
  const source = readSources(entry);
  outputs.set(entry.output, source);
  // Keep classic, parser-blocking execution at the original script position.
  // In particular, the domain fragments compile into ONE runtime scope so
  // function hoisting, lexical bindings and microtask checkpoints stay intact.
  const open = entry.openTag.replace(/>$/, ` data-nww-script="${entry.id}" src="./${entry.output}?v=${version(source)}">`);
  replacements.set(`<!-- nww:script:${entry.id} -->`, `${open}${entry.closeTag}`);
}

let html = fs.readFileSync(path.join(root, 'tools/app/index.template.html'), 'utf8');
const tokens = html.match(/<!-- nww:(?:style|script):[^ ]+ -->/g) || [];
if (tokens.length !== manifest.styles.length + manifest.scripts.length || new Set(tokens).size !== tokens.length) {
  throw new Error('Application template must contain every manifest block exactly once.');
}
html = html.replace(/<!-- nww:(?:style|script):[^ ]+ -->/g, token => {
  if (!replacements.has(token)) throw new Error(`Unknown source token: ${token}`);
  return replacements.get(token);
});
html = html.replace(/<!-- floodmapper:[^ ]+ -->/g, token => replacements.get(token) ?? token);
html = html.replace(/(\b(?:src|href)="(?:\.\/)?)(assets\/[^"?#]+)\?v=shared"/g, (_, prefix, relative) =>
  `${prefix}${relative}?v=${version(outputs.get(relative) ?? fs.readFileSync(path.join(root, relative)))}"`);

// Start the same downloads early, but let the geographic preview paint before
// the parser encounters stylesheets and classic scripts that can block it.
const headEnd = html.indexOf('</head>');
const startupResources = [];
const head = html.slice(0, headEnd).replace(
  /<link rel="stylesheet"[^>]*>|<style\b[^>]*>[\s\S]*?<\/style>|<script\b[^>]*\bsrc="[^">]+"[^>]*><\/script>/g,
  tag => {
    if (/^<style id="floodmapper-(first-paint-priority|quiet-loading-20261119)"/.test(tag)) return tag;
    const script = tag.startsWith('<script');
    startupResources.push(script ? tag : tag.replace(/^<(link|style)/, '<$1 data-nww-startup-style'));
    const url = tag.match(/\b(?:src|href)="([^"]+)"/)?.[1];
    return url ? `<link rel="preload" as="${script ? 'script' : 'style'}" href="${url}">` : '';
  }
);
const preview = fs.readFileSync(path.join(root, 'assets/north-wildwood-startup-map.webp')).toString('base64');
html = (head + html.slice(headEnd))
  .replace('<!-- floodmapper:startup-map-image -->', `data:image/webp;base64,${preview}`)
  .replace('<!-- floodmapper:startup-resources -->', () => startupResources.join('\n'));
outputs.set('index.html', html);

let changed = 0;
for (const [relative, content] of outputs) {
  const target = path.join(root, relative);
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === content) continue;
  if (check) throw new Error(`${relative} is stale. Run node tools/build_north_wildwood_app.mjs.`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  changed++;
}
console.log(`${check ? 'Verified' : 'Built'} North Wildwood: ${manifest.scripts.length} scripts, ${new Set(manifest.styles.map(entry => entry.output)).size} CSS bundles; ${changed} changed outputs.`);
