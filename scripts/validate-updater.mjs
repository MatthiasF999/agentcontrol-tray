#!/usr/bin/env node
// Validates the Tauri updater manifest (latest.json) end-to-end:
//   1. fetch latest.json for a given release tag
//   2. for each platform, download the referenced binary
//   3. verify the manifest `signature` (a base64 minisign .sig) against the
//      pubkey embedded in src-tauri/tauri.conf.json, using a pure-Node
//      minisign verifier (no external minisign/rsign binary required)
//
// Tauri's updater signs with minisign in PREHASHED mode (algo "ED"):
// the Ed25519 signature covers BLAKE2b-512(file). The trusted-comment
// global signature covers (raw_sig_bytes || trusted_comment_string).
// Both are checked here — matching what the Rust updater plugin does
// before it will apply an update.
//
// Run: node scripts/validate-updater.mjs [tag]   (default tag: v<conf.version>)

import { readFile } from "node:fs/promises";
import { createHash, verify as edVerify } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONF = join(ROOT, "src-tauri", "tauri.conf.json");
const REPO = "MatthiasF999/agentcontrol-tray";

// --- minisign parsing -------------------------------------------------------

// A minisign key/sig file is two-or-more lines; the meaningful payload is the
// base64 line after the "untrusted comment:" line. Tauri double-encodes both
// the pubkey (in tauri.conf.json) and the .sig contents (in latest.json), so
// callers base64-decode once to recover the real minisign file text.
function parsePubkey(b64Conf) {
	const text = Buffer.from(b64Conf, "base64").toString("utf8");
	const line = text.split("\n").find((l) => l && !l.startsWith("untrusted"));
	const raw = Buffer.from(line.trim(), "base64");
	// [2 algo][8 keyid][32 ed25519 pubkey]
	return { algo: raw.subarray(0, 2), keyId: raw.subarray(2, 10), key: raw.subarray(10, 42) };
}

function parseSignature(b64Sig) {
	const text = Buffer.from(b64Sig, "base64").toString("utf8");
	const lines = text.split("\n");
	const sigLine = lines[1].trim();
	const raw = Buffer.from(sigLine, "base64");
	// [2 algo][8 keyid][64 ed25519 sig]
	const algo = raw.subarray(0, 2);
	const keyId = raw.subarray(2, 10);
	const sig = raw.subarray(10, 74);
	const trustedComment = (lines[2] ?? "").replace(/^trusted comment: ?/, "");
	const globalSig = Buffer.from((lines[3] ?? "").trim(), "base64");
	return { algo, keyId, sig, trustedComment, globalSig };
}

// Node needs an SPKI-wrapped key object; prepend the fixed Ed25519 SPKI header.
function ed25519PublicKey(raw32) {
	const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw32]);
	return { key: spki, format: "der", type: "spki" };
}

function verifyMinisign(fileBytes, pub, parsed) {
	const isPrehashed = parsed.algo.toString("latin1") === "ED";
	const message = isPrehashed
		? createHash("blake2b512").update(fileBytes).digest()
		: fileBytes;
	const pubKey = ed25519PublicKey(pub.key);
	const keyIdMatch = parsed.keyId.equals(pub.keyId);
	const sigOk = edVerify(null, message, pubKey, parsed.sig);
	// The global signature ties the trusted comment (filename + timestamp) to
	// the file signature, so a swapped filename/timestamp is also rejected.
	const trustedBytes = Buffer.concat([parsed.sig, Buffer.from(parsed.trustedComment, "utf8")]);
	const globalOk = parsed.globalSig.length === 64
		? edVerify(null, trustedBytes, pubKey, parsed.globalSig)
		: false;
	return { isPrehashed, keyIdMatch, sigOk, globalOk };
}

// --- download with per-URL cache -------------------------------------------

const downloadCache = new Map();
async function download(url) {
	if (downloadCache.has(url)) return downloadCache.get(url);
	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
	const buf = Buffer.from(await res.arrayBuffer());
	downloadCache.set(url, buf);
	return buf;
}

// --- main -------------------------------------------------------------------

async function main() {
	const conf = JSON.parse(await readFile(CONF, "utf8"));
	const tag = process.argv[2] || `v${conf.version}`;
	const pubB64 = conf.plugins?.updater?.pubkey;
	if (!pubB64) throw new Error("no plugins.updater.pubkey in tauri.conf.json");
	const pub = parsePubkey(pubB64);

	const manifestUrl = `https://github.com/${REPO}/releases/download/${tag}/latest.json`;
	console.log(`Updater validation — ${REPO} @ ${tag}`);
	console.log(`pubkey keyId: ${pub.keyId.toString("hex").toUpperCase()}`);
	console.log(`manifest:     ${manifestUrl}\n`);

	const manifest = JSON.parse((await download(manifestUrl)).toString("utf8"));
	if (manifest.version !== conf.version) {
		console.log(`! manifest.version ${manifest.version} != conf.version ${conf.version}`);
	}

	const platforms = Object.entries(manifest.platforms ?? {});
	let failures = 0;
	for (const [name, p] of platforms) {
		try {
			const parsed = parseSignature(p.signature);
			const bytes = await download(p.url);
			const r = verifyMinisign(bytes, pub, parsed);
			const ok = r.keyIdMatch && r.sigOk && r.globalOk;
			if (!ok) failures++;
			console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
			console.log(`       binary:  ${p.url} (${bytes.length} bytes)`);
			console.log(`       mode:    ${r.isPrehashed ? "prehashed (BLAKE2b-512)" : "legacy"}`);
			console.log(`       keyId:   ${r.keyIdMatch ? "match" : "MISMATCH"} | file-sig: ${r.sigOk ? "ok" : "BAD"} | trusted-comment: ${r.globalOk ? "ok" : "BAD"}`);
			console.log(`       comment: ${parsed.trustedComment}`);
		} catch (err) {
			failures++;
			console.log(`[FAIL] ${name}: ${err.message}`);
		}
	}

	// macOS coverage check: a darwin-* key must exist for in-place updates on Mac.
	const hasDarwin = platforms.some(([n]) => n.startsWith("darwin-"));
	if (!hasDarwin) {
		console.log(`\n! WARNING: no darwin-* platform in manifest — macOS users get no in-place updates.`);
	}

	console.log(`\n${platforms.length - failures}/${platforms.length} platform(s) verified.`);
	process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error(`fatal: ${err.stack || err.message}`);
	process.exit(2);
});
