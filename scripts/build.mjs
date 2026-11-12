import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const outputDirectory = join(projectRoot, 'dist');
const footerPath = join(projectRoot, 'partials', 'footer.html');
const footerMarker = '<!-- SHARED_FOOTER -->';
const cartMarker = '<!-- SHARED_CART -->';
const excludedDirectories = new Set([
  '.git',
  '.github',
  '.vscode',
  'dist',
  'node_modules',
  'partials',
  'scripts',
  'supabase',
]);
const excludedExtensions = new Set(['.md', '.sql', '.toml']);

const footer = await readFile(footerPath, 'utf8');
const paystackScript = '  <script src="https://js.paystack.co/v2/inline.js"></script>';
const sharedCartScript = '  <script src="shared-cart.js"></script>';
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

let pagesWithFooter = 0;
const entries = await readdir(projectRoot, { withFileTypes: true });

for (const entry of entries) {
  if (entry.name.startsWith('.') || excludedDirectories.has(entry.name)) continue;

  const sourcePath = join(projectRoot, entry.name);
  const outputPath = join(outputDirectory, entry.name);

  if (entry.isDirectory()) {
    await cp(sourcePath, outputPath, { recursive: true });
    continue;
  }

  if (!entry.isFile() || excludedExtensions.has(extname(entry.name))) continue;

  if (extname(entry.name) === '.html') {
    let html = await readFile(sourcePath, 'utf8');
    const markerCount = html.split(footerMarker).length - 1;
    const cartMarkerCount = html.split(cartMarker).length - 1;

    if (markerCount > 1 || (markerCount === 0 && /<footer\b/i.test(html))) {
      throw new Error(`${entry.name} must contain exactly one ${footerMarker} marker.`);
    }
    if (cartMarkerCount > 1) {
      throw new Error(`${entry.name} may contain at most one ${cartMarker} marker.`);
    }
    const cartScripts = cartMarkerCount === 1
      ? [
          ...(/<script\b[^>]*src=["']https:\/\/js\.paystack\.co\/v2\/inline\.js["']/i.test(html) ? [] : [paystackScript]),
          sharedCartScript,
        ]
      : [];

    if (markerCount === 1) {
      html = html.replace(footerMarker, footer);
      if (cartMarkerCount === 1) {
        html = html.replace(cartMarker, '<div id="sharedCartMount" class="flex items-center"></div>');
      }
      if ((html.match(/<\/body>/gi) ?? []).length !== 1) {
        throw new Error(`${entry.name} must contain exactly one closing body tag.`);
      }
      const scripts = [
        '  <script src="footer.js"></script>',
        ...cartScripts,
      ].join('\n');
      html = html.replace(/<\/body>/i, `${scripts}\n</body>`);
      pagesWithFooter += 1;
    } else if (cartMarkerCount === 1) {
      html = html.replace(cartMarker, '<div id="sharedCartMount" class="flex items-center"></div>');
      if ((html.match(/<\/body>/gi) ?? []).length !== 1) {
        throw new Error(`${entry.name} must contain exactly one closing body tag.`);
      }
      html = html.replace(/<\/body>/i, `${cartScripts.join('\n')}\n</body>`);
    }

    await writeFile(outputPath, html);
    continue;
  }

  await cp(sourcePath, outputPath);
}

if (pagesWithFooter === 0) {
  throw new Error(`No HTML pages contain the ${footerMarker} marker.`);
}

console.log(`Built ${pagesWithFooter} pages with the shared footer in dist/.`);
