#!/usr/bin/env node
// build-signed.mjs —— 本地带更新器签名的发布构建(已入库,不含任何秘密)
//
// 用法:
//   node build-signed.mjs                 # 等价 CI windows 矩阵的本地构建
//   node build-signed.mjs -- --bundles nsis   # 追加透传给 cargo tauri build 的参数
//
// 做什么(对齐 .github/workflows/release.yml 的 windows job):
//   1. 校验签名私钥与密码就绪(Tauri 更新器 minisign 私钥);
//   2. 确保 ui 依赖安装(缺 node_modules 时自动 npm ci);
//   3. cargo tauri build(createUpdaterArtifacts:true 时自动产出 .sig);
//   4. 复制便携版 exe(serial-studio-portable-x64.exe,同 CI upload 步骤);
//   5. 列出全部可上传产物路径。
//
// 凭据约定(全部在 gitignore 的 /.tauri/ 目录内,**永不入库**):
//   .tauri/app.key   —— 更新器签名私钥(env TAURI_KEY_PATH 可换路径)
//   .tauri/app.pwd   —— 私钥口令,纯文本一行(读时 trim;env
//                       TAURI_SIGNING_PRIVATE_KEY_PASSWORD 可覆盖)
//   脚本本身不存任何秘密——丢了脚本不丢凭据,凭据丢了也不必改脚本。
//
// 私钥生成(仅首次):
//   cargo tauri signer generate -w .tauri/app.key
//   # 口令自行记入 .tauri/app.pwd
// 生成后把 .key.pub 的 base64 内容更新到 crates/tauri-app/tauri.conf.json 的
// bundle.updater.pubkey —— **注意**:换钥后老客户端无法校验新签名,必须随发版说明告知。
//
// 与 bump-version.mjs 的分工:发版流程 = node bump-version.mjs <ver> → 提交 →
// 打 tag 推送(CI 全平台构建)。本脚本只用于本地验证签名产物/应急出包。

import { existsSync, readFileSync, copyFileSync, readdirSync } from "node:fs";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

// ===============================================

const tauriDir = join(root, ".tauri");
const keyPath = process.env.TAURI_KEY_PATH || join(tauriDir, "app.key");
const pwdPath = join(tauriDir, "app.pwd");

if (!existsSync(keyPath)) {
  console.error(`[x] 未找到签名私钥: ${keyPath}`);
  console.error(`    放置私钥到上述路径,或用环境变量指定:`);
  console.error(`      PowerShell: $env:TAURI_KEY_PATH = "C:\\path\\to\\my.key"; node build-signed.mjs`);
  console.error(`    若私钥尚不存在: cargo tauri signer generate -w ${join(tauriDir, "app.key")}`);
  console.error(`    (换钥须同步更新 tauri.conf.json 的 bundle.updater.pubkey,并随发版说明告知用户)`);
  process.exit(1);
}
const password =
  process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ||
  (existsSync(pwdPath) ? readFileSync(pwdPath, "utf8").trim() : "");
if (!password) {
  console.error(`[x] 未设置签名密码:`);
  console.error(`    把口令存为一行文本: ${pwdPath}`);
  console.error(`      PowerShell 示例: "<你的口令>" | Set-Content -NoNewline ${pwdPath}`);
  console.error(`    或运行时用环境变量覆盖:`);
  console.error(`      $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<密码>"; node build-signed.mjs`);
  process.exit(1);
}

// 私钥内容规范化。tauri 的签名器对 TAURI_SIGNING_PRIVATE_KEY **恒做整体
// base64 解码**(报错链 "failed to decode base64 secret key"),故环境变量必须是
// 纯 base64 单行串。兼容两种存储形态:
//   a) 整段 key 的 base64 编码(tauri signer 密钥的导出/GitHub Secrets 常见形态)
//   b) minisign 明文(以 "untracked comment:" 开头)→ 转成 base64 再传
// 同时剥 BOM、统一换行、去首尾空白(Windows 存盘常引入尾部 CRLF,会破坏
// base64 尾部填充的严格解码——本脚本首次跑挂的根因)。
function loadPrivateKey(path) {
  const raw = readFileSync(path, "utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .trim();
  const toB64 = (s) => Buffer.from(s, "utf8").toString("base64");
  if (raw.startsWith("untrusted comment:")) {
    return toB64(raw); // 明文 → base64(tauri 要求的整体编码形态)
  }
  // 已是 base64 形态:roundtrip 校验产物确为 minisign 私钥(防拿错文件)
  let decoded;
  try {
    decoded = Buffer.from(raw, "base64").toString("utf8");
  } catch {
    throw new Error("私钥既不是合法 base64 也不是 minisign 明文");
  }
  if (!decoded.startsWith("untrusted comment:")) {
    throw new Error(
      "私钥解码后不是 minisign 格式(缺少 untrusted comment: 头)——文件可能损坏或拿错了公钥"
    );
  }
  return raw;
}

const privateKey = loadPrivateKey(keyPath);

// 前端依赖(cargo tauri build 的 beforeBuildCommand 需要 node_modules)
if (!existsSync(join(root, "ui", "node_modules"))) {
  console.log("ui/node_modules 缺失,执行 npm ci ...");
  execSync("npm ci", { cwd: join(root, "ui"), stdio: "inherit" });
}

// 构建。工作目录必须在 crates/tauri-app(tauri.conf.json 所在处;
// 从仓库根跑依赖 Tauri CLI 自动定位,失败场景见 CLAUDE.md)。
// cargo 定位:PATH 找不到时回退 rustup 默认安装位(Windows 上 PATH 缺
// %USERPROFILE%\.cargo\bin 的环境并不少见)。
function findCargo() {
  const exe = process.platform === "win32" ? "cargo.exe" : "cargo";
  const fallback = join(
    process.env.USERPROFILE || process.env.HOME || "",
    ".cargo",
    "bin",
    exe
  );
  return existsSync(fallback) ? fallback : "cargo";
}

console.log("Building (cargo tauri build)... this may take a while.");
const extraArgs = process.argv.includes("--")
  ? process.argv.slice(process.argv.indexOf("--") + 1)
  : [];
const result = spawn(findCargo(), ["tauri", "build", ...extraArgs], {
  cwd: join(root, "crates", "tauri-app"),
  stdio: "inherit",
  env: {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: privateKey,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
  },
});

result.on("exit", (code) => {
  if (code !== 0) {
    console.error(`[x] cargo tauri build 退出码 ${code}`);
    process.exit(code ?? 1);
  }

  // 产物清点(target 目录在仓库根 —— workspace 布局)
  const targetDir = join(root, "target", "release");
  const portable = join(targetDir, "serial-studio-portable-x64.exe");
  const mainExe = join(targetDir, "serial-studio.exe");
  try {
    copyFileSync(mainExe, portable);
    console.log(`[ok] 便携版已复制: ${portable}`);
  } catch {
    console.warn(`[!] 未找到 ${mainExe},跳过便携版复制(非默认 target 目录?)`);
  }

  console.log("\n===== 构建产物清单 =====");
  const bundles = join(root, "target", "release", "bundle");
  if (existsSync(bundles)) {
    for (const kind of readdirSync(bundles)) {
      for (const f of readdirSync(join(bundles, kind))) {
        console.log(`  bundle/${kind}/${f}`);
      }
    }
  }
  // 更新器签名(.sig 与安装包同名相邻)
  for (const f of readdirSync(targetDir).filter((f) => f.endsWith(".sig"))) {
    console.log(`  release/${f}`);
  }
  console.log("\n完成。上传草稿 release 可用:");
  console.log("  gh release upload <tag> <files...> --clobber");
});
