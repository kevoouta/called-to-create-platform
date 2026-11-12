import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const outputDirectory = join(projectRoot, 'dist');
const footerPath = join(projectRoot, 'partials', 'footer.html');
const footerMarker = '<!-- SHARED_FOOTER -->';
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

    if (markerCount > 1 || (markerCount === 0 && /<footer\b/i.test(html))) {
      throw new Error(`${entry.name} must contain exactly one ${footerMarker} marker.`);
    }

    if (markerCount === 1) {
      html = html.replace(footerMarker, footer);
      if ((html.match(/<\/body>/gi) ?? []).length !== 1) {
        throw new Error(`${entry.name} must contain exactly one closing body tag.`);
      }
      html = html.replace(
        /<\/body>/i,
        '  <script src="footer.js"></script>\n</body>',
      );
      pagesWithFooter += 1;
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
