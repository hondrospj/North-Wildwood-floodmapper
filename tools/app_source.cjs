const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

/**
 * Expand only this app's declared, built assets for source-level regression
 * tests. Browser tests continue to load the actual published document.
 * Arbitrary fixtures and other towns' inline documents pass through unchanged.
 */
function readAppSource(input = path.join(__dirname, '..', 'index.html')) {
  const file = input instanceof URL ? fileURLToPath(input) : path.resolve(input);
  const html = fs.readFileSync(file, 'utf8');
  if (!html.includes('data-nww-script=')) return html;
  const root = path.dirname(file);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tools/app/manifest.json'), 'utf8'));
  const styleOffsets = new Map();
  const styleBodies = new Map();
  for (const entry of manifest.styles) {
    const start = styleOffsets.get(entry.output) || 0;
    const length = entry.sources.reduce((sum, source) => sum + fs.readFileSync(path.join(root, source), 'utf8').length, 0);
    const bundle = fs.readFileSync(path.join(root, entry.output), 'utf8');
    styleBodies.set(entry.id, bundle.slice(start, start + length));
    styleOffsets.set(entry.output, start + length);
  }
  let expanded = html;
  for (const entry of manifest.styles) {
    const pattern = entry.firstInBundle
      ? new RegExp(`<link\\b[^>]*data-nww-style-bundle="${path.basename(entry.output, '.css')}"[^>]*>`)
      : new RegExp(`<!-- nww:style:${entry.id} -->`);
    if (!pattern.test(expanded)) throw new Error(`Missing built style block: ${entry.id}`);
    expanded = expanded.replace(pattern, () => entry.openTag + styleBodies.get(entry.id) + entry.closeTag);
  }
  for (const entry of manifest.scripts) {
    const pattern = new RegExp(`<script\\b[^>]*data-nww-script="${entry.id}"[^>]*>[\\s\\S]*?<\\/script>`);
    if (!pattern.test(expanded)) throw new Error(`Missing built script block: ${entry.id}`);
    const body = fs.readFileSync(path.join(root, entry.output), 'utf8');
    expanded = expanded.replace(pattern, () => entry.openTag + body + entry.closeTag);
  }
  return expanded;
}

exports.readAppSource = readAppSource;
exports.readApplicationHtml = readAppSource;
