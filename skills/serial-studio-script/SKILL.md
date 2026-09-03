---
name: serial-studio-script
description: 为 Serial Studio 写串口自动化 JS 脚本(嵌入 QuickJS,顶层 await)。凡涉及重试/条件/循环/解析的串口交互(AT 指令、modem/ESP/单片机/GPS/传感器等)都用脚本生成可粘贴运行的代码。
---

# Serial Studio 脚本编写

Serial Studio 脚本用 **JavaScript** 写,嵌入 QuickJS 引擎执行(引擎会把代码包进 async 函数,因此顶层可直接 `await`,无需自己包),跑在**已打开的串口**上。支持任意 if/for/重试/解析控制流,适合复杂串口交互。

产出目标:一段**自包含、可直接粘贴运行**的 JS,加一两句运行说明。

## 全局 API(4 个 async 函数 + log + 4 个文件函数 + 标准 JS)

脚本运行在沙箱:除 `Math`/`Date`/`JSON`/正则/字符串等标准 JS 外,**只有**下面注入的函数,没有 `fetch`/`require`/`fs`/`process`/`setTimeout`/`console`。

| 调用 | 作用 | 返回 |
|---|---|---|
| `await send(data, [port])` | 发送文本,按端口配置自动追加换行(`send("")` 即单独一个回车,常用于探测提示符) | 无 |
| `await expect(pattern, timeout_ms, [port])` | 用正则 `pattern` 逐行扫描接收缓冲 | 首条匹配的整行;**超时无匹配返回空串 `""`** |
| `await clear([port])` | 清空接收缓冲 | 无 |
| `await sleep(ms)` | 睡眠 ms 毫秒 | 无 |
| `log(message)` | 输出调试日志(**不中断脚本**,可循环调用) | 无 |
| `file_stat(path)` | 宿主机文件元信息(仅常规文件算 exists) | JSON:`{"exists":true,"size":1536}` 或 `{"exists":false}`(缺失不抛错) |
| `file_md5(path)` | 宿主机文件 md5(流式,大文件内存常数级) | 32 位 hex;缺失 throw |
| `read_file(path)` | 全量读为文本(UTF-8 lossy) | 文本;缺失 throw;**上限 64MiB,超限 throw(大文件用 read_b64_chunk)** |
| `read_b64_chunk(path, index, chunk_bytes)` | 读第 `index` 块(`offset=index×chunk_bytes`)的 base64 | 块的 base64;**越界返回空串 = EOF**;缺失/参数非法 throw |

文件函数都是同步函数,只读宿主机文件(无写/删;路径暂无白名单,可读任意位置——远程执行场景注意此边界)。`read_b64_chunk` 的 `chunk_bytes` **须为 ≥3 的 3 的倍数且 ≤1MiB**(如 192 → 256 字符):调用方按同一值算总块数,除末块外无 `=` 填充,全部块顺序拼接后 `base64 -d` 即原文——串口上传就靠它,内存峰值一块。

`[port]` 缺省 = 当前活动端口;传端口寻址则操作该口(**须已打开**,脚本无 open 原语),因此一个脚本能跨多口:在 A 口查数据、B 口下发。指定端口未打开时 `send`/`clear` 会 throw(如 "send 失败(端口 X)"),`expect` 返回空串——按各函数语义判空/try。

**端口寻址形式**(send/expect/clear 的 `[port]` 与脚本绑定端口通用):

| 形式 | 示例 | 含义 |
|---|---|---|
| 裸端口名 | `COM5` / `/dev/ttyUSB0` | 本机串口 |
| 端口别名 | `GPS` | UI 里设置的别名(本机优先;跨设备同名歧义时报候选) |
| 完整键 | `uuid::COM5` | 远端设备端口(设备 id 见列表);级联逐段透传 |
| 设备昵称作用域 | `test::COM5`、`test::GPS` | 昵称 + 目标机上的端口名/别名 |

**expect 的缓冲语义**(写多步解析前必读):`expect` **不消费**缓冲区——每次都对整个接收缓冲重新扫描,返回首条匹配行。由此:① 同一 pattern 调两次拿到的是同一行;② 想从同一条命令输出里取多个字段,换不同 pattern 连续 `expect` 即可,不必重发命令;③ 旧数据永远在场,先 `clear()` 再 `send()` 防的是旧数据抢先匹配,不是消费。缓冲只在 `clear()`(或破坏性读取)时清空。

## 参数(args)

把易变值(MAC、目标端口、次数……)从 code 抽出,换参重跑不改脚本。值都注入 `args.<name>`。声明方式:

**code 顶部注释**(自包含, 一段代码搞定)。**default 为可选参数且不带方括号**(写 `default=值`,不要写 `[default=值]`):

- `// @param <name> string default=值`
- `// @param <name> select 选项1|选项2|... default=选项`(选项用 `|` 分隔)
- `// @param <name> file default=路径`(值为宿主机文件路径,UI 采集时带文件选择按钮)

**类型只有 `string`、`select` 和 `file`**——没有 number/int/float。数字参数用 `string` 声明,脚本里 `Number(args.x)` 转;文件参数用 `file`(值仍是路径字符串,配合 `file_stat`/`read_b64_chunk` 等文件函数)。

```js
// @param port1 select COM5|COM7 default=COM5
// @param file  string default=mac.txt
// @param count string default=3          // 数字也用 string,不是 number
await clear(args.port1);
await send("ifconfig br-lan", args.port1);
for (let i = 0; i < Number(args.count); i++) { await sleep(100); }
```

## 硬约束(违背即出错)

1. **每次 `expect` 后都判空。** 超时不报错、返回 `""`。
2. **调试/输出用 `log`,中止报错用 `throw`,严禁 `console.*`。** `log(s)` 输出日志且不中断脚本(循环里随便用);`throw new Error("…")` 中止脚本并显示消息(配合第 1 条:没等到就 throw)。沙箱无 console,写了即报 ReferenceError。
   日志出口:UI 运行实时显示;**经 MCP 运行(`serial_debug_script` / `serial_run_script`)时,log 输出会随工具响应一次性返回**(无论成功/失败/超时都带,上限最近 200 条/16 KiB,超限丢最旧)。调试脚本时在关键分支 `log` 中间变量即可看到。
3. **`expect` 的 pattern 是正则字符串,不是字面量。** 写 `expect("OK")`、`expect("\\d+")`,**不要** `expect(/OK/)`(字面量会变成 `"/OK/"`——它本身能编译,但匹配的是带斜杠的字面串,永远等不到想要的 `OK`)。Rust `regex` 语法:字符类、`+`/`*`/`?`/`|`/`^`/`$`/`\d`/`\w` 等;别用反向引用。
4. **脚本可长跑,但要留出口。** 界面手动运行无时长上限;经 MCP 工具(`serial_debug_script` / `serial_run_script`)运行上限 5 分钟(超时被中止,MCP 暂无手动停止)。运行时可被秒级中止;`expect` 的 timeout 常用 500~3000ms,慢命令(udhcpc/ping/mkfs 等)可给 10~30s;多阶段脚本先把各步耗时加一加,别超 5 分钟总预算;循环要有退出条件。内存上限 64MiB,超出被强杀。

## 核心模式

**发命令→等响应→判断**(最基本,expect 后必判):
```js
await clear();                         // 清历史,确保等的是新响应
await send("AT");
const line = await expect("OK", 1000);
if (line === "") throw new Error("未收到 OK——查波特率/接线/上电");
```

**防回显误匹配**:设备多半会回显你发的命令本身,pattern 要选命令行里不会出现的内容——等响应独有的关键字(如 `BandWidth \\(Megabits\\)` 而非 `BandWidth`);能关回显的设备(如 AT 的 `ATE0`)先关掉。

**失败重试**:
```js
await clear();
let ok = "";
for (let i = 1; i <= 3; i++) {
  await send("AT");
  ok = await expect("OK", 1000);
  if (ok) break;
  await sleep(300);
}
if (!ok) throw new Error("重试 3 次均无响应");
```

**按返回内容分支**:`expect` 拿到行后用 `includes`/`match` 判断,走不同路径(标准 JS 的 if/else)。

**跨多口**:给函数传可选 `port`(支持别名与设备昵称作用域)。下例 COM3 查 MAC、解析后 COM5 下发(两端口都要先打开):
```js
await clear("COM3");
await send("AT+MAC?", "COM3");
const line = await expect("([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}", 2000, "COM3");
if (line === "") throw new Error("COM3 未返回 MAC");
const mac = line.match(/[\dA-Fa-f]{2}([:\-][\dA-Fa-f]{2}){5}/)[0];
await send("AT+SETMAC=" + mac, "COM5");        // 也可写别名或 test::COM5
if (await expect("OK", 1000, "COM5") === "") throw new Error("COM5 配置失败");
log("已把 " + mac + " 从 COM3 同步到 COM5");
```

**周期采集**:循环里直接 `log("第 " + i + " 轮: " + value)` 边采边打。

**经串口向 Linux 设备传文件**(设备无网络但有 shell + base64/md5sum):分块 base64 + 逐块 ACK;核心是 `read_b64_chunk(path, i, 192)` 逐块取数 → `send("echo '<块>' >> <远端>.b64; echo ACK" + i)` → `expect("^ACK" + i + "$")`,传完设备端 `base64 -d` 解码、`md5sum` 与宿主 `file_md5(path)` 对比。115200 波特率实测约 0.3~0.6KB/s,只适合配置/脚本/小固件。

## 完整示例:AT 设备自检

```js
await clear();
await send("ATZ");                       // 软复位
await sleep(500);
let ready = "";
for (let i = 1; i <= 5; i++) {           // 重试等就绪
  ready = await expect("OK", 800);
  if (ready) break;
  await sleep(400);
}
if (!ready) throw new Error("复位后 5 次无 OK");
await send("ATE0");                      // 关回显,避免 expect 匹配到自己发的命令
if (await expect("OK", 1000) === "") throw new Error("关回显失败");
await send("AT+CSQ");
const csq = await expect("CSQ:\\s*\\d+", 1500);
if (csq === "") throw new Error("查询信号失败");
log("自检通过,信号: " + csq);
```

## 输出约定

- 主体是一段自包含、可整段粘贴的 JS(代码块),注释标清每步在干啥(中文、简短)
- 代码后一两句说明:假设的设备/波特率、跑在哪个口、预期结果
- 涉及具体设备命令而用户没给时,按常见 AT 设备惯例给样例并提示"按设备手册调整"
