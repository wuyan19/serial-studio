---
name: serial-studio-script
description: 为 Serial Studio 写串口自动化 JS 脚本(嵌入 QuickJS,顶层 await)。凡涉及重试/条件/循环/解析的串口交互(AT 指令、modem/ESP/单片机/GPS/传感器等)都用脚本生成可粘贴运行的代码;简单顺序发收用宏。
---

# Serial Studio 脚本编写

Serial Studio 脚本用 **JavaScript** 写,嵌入 QuickJS 引擎执行(包成 `(async () => {})()`,可顶层 `await`),跑在**已打开的串口**上。它补足宏的短板:支持任意 if/for/重试/解析控制流。

产出目标:一段**自包含、可直接粘贴运行**的 JS,加一两句运行说明。

## 全局 API(只有这 4 个 + 标准 JS)

脚本运行在沙箱:除 `Math`/`Date`/`JSON`/正则/字符串等标准 JS 外,**只有**下面 4 个注入的 `async` 函数,没有 `fetch`/`require`/`fs`/`process`/`setTimeout`。

| 调用 | 作用 | 返回 |
|---|---|---|
| `await send(data, [port])` | 发送文本,按端口配置自动追加换行 | 无 |
| `await expect(pattern, timeout_ms, [port])` | 用正则 `pattern` 匹配**整行**接收缓冲 | 首条匹配行;**超时无匹配返回空串 `""`** |
| `await clear([port])` | 清空接收缓冲 | 无 |
| `await sleep(ms)` | 睡眠 ms 毫秒 | 无 |

`[port]` 缺省 = 当前活动端口;传端口名(如 `"COM5"`)则操作该口(**须已打开**,脚本无 open 原语),因此一个脚本能跨多口:在 A 口查数据、B 口下发。指定端口未打开时 `send` 静默失败、`expect` 返回空串,照样要判空。

## 参数(args)

把易变值(MAC、目标端口、次数……)从 code 抽出,换参重跑不改脚本。值都注入 `args.<name>`。声明方式:

**code 顶部注释**(自包含, 一段代码搞定):
- `// @param <name> string [default=值]`
- `// @param <name> select 选项1|选项2|... [default=选项]`(选项用 `|` 分隔)

```js
// @param port1 select COM5|COM7
// @param file  string default=mac.txt
await clear(args.port1);
await send("ifconfig br-lan", args.port1);
// ... 用 args.port1 / args.file
```

## 硬约束(违背即出错)

1. **每次 `expect` 后都判空。** 超时不报错、返回 `""`;不判就把"没收到"当"收到"继续走。
2. **没有控制台——用 `throw` 当 print。** `console.log` 不存在。调试看变量、回报最终结果都靠 `throw new Error("...")`(消息显示在结果栏;代价是脚本以失败结束,验证完删掉调试用 throw)。
3. **`expect` 的 pattern 是正则字符串,不是字面量。** 写 `expect("OK")`、`expect("\\d+")`,**不要** `expect(/OK/)`(字面量转成 `"/OK/"`,斜杠让正则编译失败)。Rust `regex` 语法:字符类、`+`/`*`/`?`/`|`/`^`/`$`/`\d`/`\w` 等;别用反向引用。
4. **总执行上限 30s,死循环会被强杀。** `expect` 的 `timeout_ms` 别设太大(常用 500~3000ms),循环要有出口。
5. **`throw` 正常传播。** `throw new Error("设备未响应")` 让脚本失败并把消息显示出来——这是"中止并报错"的正道(配合第 1 条:没等到就 throw)。

## 核心模式

**发命令→等响应→判断**(最基本,expect 后必判):
```js
await clear();                         // 清历史,确保等的是新响应
await send("AT");
const line = await expect("OK", 1000);
if (line === "") throw new Error("未收到 OK——查波特率/接线/上电");
```

**失败重试**(脚本核心价值,宏做不到):
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

**跨多口**:给函数传可选 `port`。下例 COM3 查 MAC、解析后 COM5 下发(两端口都要先打开):
```js
await clear("COM3");
await send("AT+MAC?", "COM3");
const line = await expect("([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}", 2000, "COM3");
if (line === "") throw new Error("COM3 未返回 MAC");
const mac = line.match(/[\dA-Fa-f]{2}([:\-][\dA-Fa-f]{2}){5}/)[0];
await send("AT+SETMAC=" + mac, "COM5");
if (await expect("OK", 1000, "COM5") === "") throw new Error("COM5 配置失败");
throw new Error("✅ 已把 " + mac + " 从 COM3 同步到 COM5");
```

**周期采集**:循环把结果攒进数组,结束后 `throw new Error(arr.join("\n"))` 一次输出(循环里 throw 会立刻中断,故不能边采边抛)。

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
throw new Error("✅ 自检通过,信号: " + csq);
```

## 输出约定

- 主体是一段自包含、可整段粘贴的 JS(代码块),注释标清每步在干啥(中文、简短)
- 代码后一两句说明:假设的设备/波特率、跑在哪个口、预期结果
- 流程很简单(纯顺序发几条命令、无需判断/重试)就建议**用宏**,别硬写脚本
- 涉及具体设备命令而用户没给时,按常见 AT 设备惯例给样例并提示"按设备手册调整"
