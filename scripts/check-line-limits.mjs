#!/usr/bin/env node
/**
 * check-line-limits.mjs — mechanical enforcement of the AgentControl
 * clean-code limits (https://cln.co/, see CLAUDE.md). Biome handles
 * lint + format but has no line-count rule, so this owns the limits:
 *
 *   - every function-like node <= 50 non-blank lines
 *   - files in src/components/** and src/hooks/** <= 150 non-blank lines
 *   - everything else under src/ <= 250 non-blank lines
 *
 * A components/hooks file may raise its own ceiling up to 250 with a
 * single-line marker anywhere in the file:
 *
 *   // line-limit:250 -- reason: <why>
 *
 * The Rust side under `src-tauri/` is governed by `cargo fmt` + `cargo
 * check` and is intentionally skipped here.
 *
 * Pre-existing offenders may be grandfathered via
 * `scripts/.line-limits-grandfather` — one `<relative-path>` per line.
 * Lines beginning with `#` are comments.
 *
 * Usage:  node scripts/check-line-limits.mjs <projectDir>
 * Run it from the project's `lint` pnpm script so `typescript` resolves
 * from this project's node_modules. Exits 1 on any violation.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, relative } from 'node:path';

const projectDir = process.argv[2] ?? '.';
const require = createRequire(join(process.cwd(), 'package.json'));
const ts = require('typescript');

const FUNC_LIMIT = 50;
const violations = [];

const grandfatherPath = join(projectDir, 'scripts', '.line-limits-grandfather');
const grandfather = new Set();
if (existsSync(grandfatherPath)) {
  for (const raw of readFileSync(grandfatherPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    grandfather.add(line.replace(/\\/g, '/'));
  }
}

function fileLimit(relPath) {
  const p = relPath.replace(/\\/g, '/');
  if (p.includes('src/components/') || p.includes('src/hooks/')) return 150;
  return 250;
}

function walk(dir, acc) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (['.ts', '.tsx'].includes(extname(entry))) acc.push(full);
  }
  return acc;
}

const nonBlank = (text) =>
  text.split('\n').filter((l) => l.trim() !== '').length;

function checkFile(absPath) {
  const text = readFileSync(absPath, 'utf8');
  const rel = relative(projectDir, absPath).replace(/\\/g, '/');
  let limit = fileLimit(rel);
  const override = text.match(/line-limit:(\d+)\s*--\s*reason:/);
  if (override && /components|hooks/.test(rel)) {
    limit = Math.min(Number(override[1]), 250);
  }
  const lines = nonBlank(text);
  if (lines > limit && !grandfather.has(rel)) {
    violations.push(`${rel}: ${lines} lines > ${limit} (file limit)`);
  }
  checkFunctions(absPath, text, rel);
}

function checkFunctions(absPath, text, rel) {
  const sf = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    const isFn =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node);
    if (isFn) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const len = nonBlank(node.getText(sf));
      if (len > FUNC_LIMIT) {
        const key = `${rel}:${line}`;
        if (!grandfather.has(key)) {
          violations.push(
            `${rel}:${line}: function is ${len} lines > ${FUNC_LIMIT}`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const srcDir = join(projectDir, 'src');
if (!existsSync(srcDir)) {
  console.log('✔ line-limit check skipped (no src/ yet)');
  process.exit(0);
}
const files = walk(srcDir, []);
for (const f of files) checkFile(f);

if (violations.length > 0) {
  console.error(`\n✖ line-limit check failed (${violations.length}):\n`);
  for (const v of violations) console.error(`  ${v}`);
  console.error('\nFix: split the file/function. Do not raise the limit.\n');
  process.exit(1);
}
console.log(`✔ line-limit check passed (${files.length} files)`);
