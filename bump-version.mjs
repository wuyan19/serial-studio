#!/usr/bin/env node
// bump-version.mjs - bump version in all 4 places and refresh Cargo.lock
// Usage: node bump-version.mjs 0.7.1
//
// Bumps version in: Cargo.toml (workspace), crates/tauri-app/tauri.conf.json,
//                   ui/package.json, ui/package-lock.json (project entries only).
// Cargo.lock is refreshed via `cargo check`.
//
// Why: the version must stay in sync across 4 files + Cargo.lock; a mismatch
//      breaks the updater's version check against the release tag.
//
// How: reads the CURRENT version from Cargo.toml, then replaces the quoted
//      string "<current>" -> "<new>" in each file. Matching the quoted exact
//      value means dependency versions in package-lock.json are never touched.
// Cross-platform (Node.js) - usable on Windows / macOS / Linux and in CI.

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2];

if (!target || !/^\d+\.\d+\.\d+$/.test(target)) {
  console.error("Usage: node bump-version.mjs <version>   (e.g. 0.7.1)");
  process.exit(1);
}

// Read current version from Cargo.toml (workspace.package.version - the only
// quoted X.Y.Z literal in that file)
const cargoPath = join(root, "Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8");
const m = cargo.match(/version = "(\d+\.\d+\.\d+)"/);
if (!m) throw new Error(`Cannot read current version from ${cargoPath}`);
const current = m[1];

if (current === target) {
  console.log(`Current version is already ${target}. Nothing to do.`);
  process.exit(0);
}
console.log(`Bumping ${current} -> ${target}`);

function bumpFile(relPath) {
  const path = join(root, relPath);
  const text = readFileSync(path, "utf8");
  const needle = `"${current}"`;
  const count = text.split(needle).length - 1;
  if (count === 0) throw new Error(`Quoted version "${current}" not found in ${relPath}`);
  writeFileSync(path, text.split(needle).join(`"${target}"`));
  console.log(`  ${relPath} (${count} occurrence(s))`);
}

bumpFile("Cargo.toml");
bumpFile("crates/tauri-app/tauri.conf.json");
bumpFile("ui/package.json");
bumpFile("ui/package-lock.json");

console.log("Refreshing Cargo.lock via cargo check ...");
try {
  execSync("cargo check", { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  // cargo failed - surface its captured output to STDOUT (not stderr), so
  // PowerShell 5.1 doesn't wrap it as a NativeCommandError.
  process.stdout.write(e.stdout?.toString() || "");
  process.stdout.write(e.stderr?.toString() || "");
  throw new Error("cargo check failed (see output above)");
}
console.log("  Cargo.lock refreshed.");
console.log("Done. Review with: git diff --stat");
