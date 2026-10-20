// Usage: node scripts/attach-existing.mjs --search "DOI or title"
//        node scripts/attach-existing.mjs --item KEY --pdf "absolute PDF path"
import { buildTools, createRuntime } from '../lib/tools.js';
const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const rt = createRuntime({});
try {
  const query = value('--search');
  const key = value('--item');
  const pdfPath = value('--pdf');
  if (!query && (!key || !pdfPath)) throw new Error('Use --search "DOI or title" OR --item KEY --pdf "absolute PDF path"');
  const name = query ? 'zotero_search' : 'zotero_attach_pdf';
  if (!query) console.log('If Zotero prompts, authorize DSH Zotero Flow. Always Allow avoids repeated native prompts.');
  const tool = buildTools(rt).find(t => t.name === name);
  const out = await tool.execute(query ? { query } : { itemKey: key, pdfPath });
  console.log(out.text);
  if (out.attached === false) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await rt.browser.close(); }
