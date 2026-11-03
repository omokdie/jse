// Entry point for `node --test tools/tests/`: since Node 21 a directory given
// to --test is resolved as a module (this file) instead of being searched for
// test files, so import every *.test.js here. `node --test tools/tests/*.test.js`
// does not match this file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
for (const f of fs.readdirSync(here).filter(f => f.endsWith('.test.js')).sort()) await import(pathToFileURL(path.join(here, f)).href);
