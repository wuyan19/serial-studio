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
// How: reads the CURRENT version from Cargo.toml, then bumps each file with
//      structure-aware replacement:
//        - Cargo.toml: only the FIRST `version = "<current>"` (workspace.package
//          block; a global replace could hit a dependency pinned to the same
//          version — same bug class as the package-lock incident of v0.11.0);
//        - *.json / package-lock.json: JSON parse + mutate + stringify(2-space),
//          touching ONLY root `version` / `packages[""].version` — a naive
//          quoted-string replace once corrupted @xterm/addon-fit's entry because
//          its version happened to equal the app's old version.
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

function writeFile(relPath, text) {
  writeFileSync(join(root, relPath), text);
  console.log(`  ${relPath}`);
}

// Cargo.toml:只换第一处(workspace.package 块)——全局替换会误伤恰好同号的依赖
{
  const path = cargoPath;
  const text = readFileSync(path, "utf8");
  const needle = `version = "${current}"`;
  if (!text.includes(needle)) throw new Error(`Quoted version not found in Cargo.toml`);
  writeFile("Cargo.toml", text.replace(needle, `version = "${target}"`));
}

// JSON 家族:解析后只改根字段,序列化回写(npm 官方 lock 格式即 2 空格缩进)
for (const [relPath, mutate] of [
  ["crates/tauri-app/tauri.conf.json", (j) => (j.version = target)],
  ["ui/package.json", (j) => (j.version = target)],
  [
    "ui/package-lock.json",
    (j) => {
      j.version = target;
      if (j.packages?.[""]) j.packages[""].version = target;
    },
  ],
]) {
  const path = join(root, relPath);
  const json = JSON.parse(readFileSync(path, "utf8"));
  mutate(json);
  writeFile(relPath, JSON.stringify(json, null, 2) + "\n");
}

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
