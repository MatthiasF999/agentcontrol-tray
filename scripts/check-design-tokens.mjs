#!/usr/bin/env node
/**
 * check-design-tokens.mjs — mechanical enforcement of the AgentControl
 * design system in the tray. Ported from agentcontrol-app; adapted for
 * the tray's React-web (Tauri webview) reality:
 *
 *   - Raw hex literals (`#xxxxxx`) outside `src/theme/`. Reference a
 *     `var(--ac-*)` CSS token (or a `Colors.*` value from tokens.ts).
 *     Allowlist: `#FFFFFF` / `#000000` (white/black on accent fill).
 *   - Raw `rgb()` / `rgba()` / `hsl()` color literals — same rule; the
 *     glass/scrim tints all live as `var(--ac-*)` tokens in tokens.css.
 *
 * Scope: `.ts` / `.tsx` under `src/` only. The tray is not React Native,
 * so there is NO Material-Paper import ban (that rule is app-only). CSS
 * files are governed by `src/theme/tokens.css` directly and are skipped;
 * the NSIS bootstrapper (`bootstrapper/*`) lives outside `src/` and is
 * never walked.
 *
 * Escape hatches:
 *   - File-level: place `// design-token:allow-file -- reason: <why>` near
 *     the top of the file.
 *   - Line-level: append `// design-token:allow` to the offending line.
 *
 * Usage:  node scripts/check-design-tokens.mjs [<projectDir>]
 * Exits 1 if any violation is found. Wired into `pnpm lint`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const projectDir = process.argv[2] ?? '.';
const violations = [];

const HEX_RE = /#(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{3,4})\b/g;
const RGB_RE = /\b(?:rgba?|hsla?)\(\s*\d/;
const HEX_ALLOWLIST = new Set([
  '#FFFFFF',
  '#ffffff',
  '#FFF',
  '#fff',
  '#000000',
  '#000',
]);

function walk(dir, acc) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (['.ts', '.tsx'].includes(extname(entry))) acc.push(full);
  }
  return acc;
}

function isThemeFile(rel) {
  return rel.replace(/\\/g, '/').includes('src/theme/');
}

/** Test files legitimately hard-code colors in fixtures + assertions. */
function isTestFile(rel) {
  const p = rel.replace(/\\/g, '/');
  return p.includes('__tests__/') || /\.test\.tsx?$/.test(p);
}

function hasFileAllow(text) {
  return text.includes('design-token:allow-file');
}

function checkHexLiterals(text, rel) {
  if (isThemeFile(rel) || isTestFile(rel)) return;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (line.includes('design-token:allow')) return;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    const matches = line.match(HEX_RE);
    if (matches) {
      for (const m of matches) {
        if (HEX_ALLOWLIST.has(m)) continue;
        violations.push(
          `${rel}:${i + 1}  raw hex ${m} → use var(--ac-*) / Colors.* (or //design-token:allow with reason)`,
        );
      }
    }
    if (RGB_RE.test(line)) {
      violations.push(
        `${rel}:${i + 1}  raw rgb/rgba/hsl literal → use var(--ac-*) / Colors.* (or //design-token:allow with reason)`,
      );
    }
  });
}

const srcDir = join(projectDir, 'src');
const files = walk(srcDir, []);
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  const rel = relative(projectDir, f);
  if (hasFileAllow(text)) continue;
  checkHexLiterals(text, rel);
}

if (violations.length > 0) {
  console.error(`\n✖ design-token check failed (${violations.length}):\n`);
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    `\nFix: reference a var(--ac-*) token (or a Colors.* value from src/theme/tokens.ts). See src/theme/.`,
  );
  process.exit(1);
}

console.log(`✔ design-token check passed (${files.length} files)`);
