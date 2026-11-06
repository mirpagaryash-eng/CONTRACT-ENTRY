import { build } from 'vite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { Script } from 'node:vm';

await build({ configFile: resolve('vite.preview.config.js') });
const dir = resolve('preview-dist');
let html = await readFile(resolve(dir, 'preview.html'), 'utf8');
let fixture = process.env.PREVIEW_PUBLIC === 'true' ? { profile: { name: 'Owner', businessName: 'My Business', phone: '' }, workers: [] } : null;
if (process.env.PREVIEW_PUBLIC !== 'true') {
  try {
    const local = JSON.parse(await readFile(resolve('.data/preview-fixture.json'), 'utf8'));
    // Only the deliberately prepared preview fixture is bundled, never .env or database data.
    fixture = { profile: local.profile, workers: local.workers };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const injection = fixture ? `window.__HISAB_PREVIEW_FIXTURE__=${JSON.stringify(fixture).replaceAll('<', '\\u003c')};\n` : '';
const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)];
for (const [tag, src] of scripts) {
  const code = await readFile(resolve(dir, src), 'utf8');
  // A self-contained classic script also works in viewers with JavaScript enabled
  // but no module support. Wait for the body before mounting React.
  const program = `(function(){function start(){'use strict';\n${injection}${code}\n}if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',start,{once:true});}else{start();}})();`;
  new Script(program); // Refuse a bundle that still requires module syntax.
  html = html.replace(tag, () => `<script>${program.replaceAll('</script', '<\\/script')}</script>`);
}
const styles = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/g)];
for (const [tag, href] of styles) {
  const css = await readFile(resolve(dir, href), 'utf8');
  html = html.replace(tag, () => `<style>${css}</style>`);
}
html = html.replace(/<link\b[^>]*rel="modulepreload"[^>]*>/g, '');
const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
if (/<script\b[^>]*src=|<link\b[^>]*rel="stylesheet"/i.test(markup)) throw new Error('Preview still has external assets; refusing an incomplete file.');
const output = resolve(process.env.PREVIEW_OUTPUT || 'preview-dist/hisab-interactive.html');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, html);
console.log(`Standalone interactive frontend: ${output}`);
