#!/usr/bin/env node
/**
 * One-time setup helper: replaces the REPLACE_GITHUB_OWNER placeholder (and the
 * repository name when it is not "jse") in every file that needs it.
 *
 *   node tools/set-github-owner.mjs <github-owner> [repo-name]
 *
 * Files touched (see RELEASING.md):
 *   electron/package.json                                   build.publish[0].owner / repo, homepage
 *   mobile/android/app/src/main/res/values/strings.xml      update_base_url
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [owner, repoArg] = process.argv.slice(2);
const repo = repoArg || 'jse';

if (!owner || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) {
  console.error('usage: node tools/set-github-owner.mjs <github-owner> [repo-name]');
  process.exit(1);
}

let changed = 0;

// electron/package.json — edit as JSON so formatting stays valid
{
  const file = path.join(root, 'electron', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const gh = (pkg.build && pkg.build.publish || []).find((p) => p && p.provider === 'github');
  let touched = false;
  if (gh && (gh.owner !== owner || gh.repo !== repo)) {
    gh.owner = owner;
    gh.repo = repo;
    touched = true;
  }
  const homepage = `https://github.com/${owner}/${repo}`;
  if (pkg.homepage !== homepage) {
    pkg.homepage = homepage;
    touched = true;
  }
  if (touched) {
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`updated ${path.relative(root, file)}`);
    changed++;
  }
}

// strings.xml — plain text replace of the URL
{
  const file = path.join(root, 'mobile', 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml');
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(
    /<string name="update_base_url"([^>]*)>[^<]*<\/string>/,
    `<string name="update_base_url"$1>https://${owner}.github.io/${repo}/</string>`,
  );
  if (after !== before) {
    fs.writeFileSync(file, after);
    console.log(`updated ${path.relative(root, file)}`);
    changed++;
  }
}

// Anything left over?
const leftovers = [];
for (const rel of ['electron/package.json', 'mobile/android/app/src/main/res/values/strings.xml']) {
  if (fs.readFileSync(path.join(root, rel), 'utf8').includes('REPLACE_GITHUB_OWNER')) leftovers.push(rel);
}
if (leftovers.length) {
  console.error('placeholder still present in:', leftovers.join(', '));
  process.exit(1);
}
console.log(changed ? `done — owner=${owner} repo=${repo}` : `nothing to do — already set to ${owner}/${repo}`);
console.log(`Pages URL      : https://${owner}.github.io/${repo}/`);
console.log(`Release feed   : https://github.com/${owner}/${repo}/releases`);
