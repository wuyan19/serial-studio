---
name: serial-studio-script
description: 为 Serial Studio 编写串口自动化 JS 脚本(嵌入 QuickJS,顶层 await,跑在已打开的串口上)。每当用户想给串口设备写自动化逻辑——发命令等响应、AT 指令、重试直到收到某回复、按设备返回的内容分支、循环采集传感器、与 modem/蓝牙模块/ESP/单片机/GPS/传感器等串口设备做有控制流的交互——就用这个技能生成可直接粘进 Serial Studio 运行的脚本。即使用户没点名"Serial Studio",只要描述的是"写一段串口自动化流程/脚本/逻辑"就应使用;简单的发-收用宏即可,凡涉及重试、条件、循环、解析的都用脚本。
---

# Serial Studio 脚本编写

Serial Studio 支持用 **JavaScript** 写串口自动化脚本。脚本嵌入 QuickJS 引擎,被包成 `(async () => { ... })()` 执行,因此顶层可以直接 `await`。脚本能做自定义宏做不到的事:**任意 if/for/重试/解析** 控制流。

你的任务:根据用户描述的设备交互流程,产出一段**自包含、可直接粘贴运行**的 JS 脚本,并简短说明如何在 Serial Studio 里跑它。

## 可用的全局函数(只有这 4 个 + 标准 JS)

脚本里只能用下面 4 个注入的 `async` 函数,以及 QuickJS 自带的标准 JS(`Math`/`Date`/`JSON`/正则/字符串等)。**没有** `fetch`/`require`/`fs`/`process`/`setTimeout`——这是沙箱,只能通过这 4 个函数碰串口。

| 调用 | 作用 | 返回 |
|---|---|---|
| `await send(data)` | 发送文本 `data`,自动按端口配置追加换行(`\n`/`\r\n`) | 无(总是成功) |
| `await expect(pattern, timeout_ms)` | 在接收缓冲里用正则 `pattern` 匹配**整行**,返回**首条匹配行** | 匹配到的字符串;**超时无匹配返回空串 `""`** |
| `await clear()` | 清空接收缓冲(丢弃历史数据) | 无 |
| `await sleep(ms)` | 睡眠 `ms` 毫秒 | 无 |

## 必须遵守的约束(脚本能不能跑通的关键)

这些是当前 v1 的硬约束,**违背任何一条脚本就会出错或表现诡异**。理解背后的原因,而不是死记:

1. **每次 `await expect(...)` 都要判断返回值。** `expect` 在超时没匹配时**不报错**,而是返回空串 `""`。如果你不判断,就会把"没收到"当成"收到了"继续往下走。原因:串口原语的失败被设计成静默(不抛 JS 异常),所以脚本必须自己用 `if (line)` 或 `if (line === "")` 来识别"没等到"。

2. **没有控制台输出——用 `throw` 当 print。** `console.log` 不存在、写了也看不到。脚本正常结束只会在结果栏显示"完成"。要想看到中间值/调试信息,只能 `throw new Error("x = " + x)`——抛出的消息会显示在结果栏(代价是脚本以失败结束)。所以调试时插 `throw` 看变量,验证完删掉;要回报最终结果也用 `throw` 带出汇总信息。

3. **`expect` 的 `pattern` 是正则字符串,不是 JS 正则字面量。** 写 `expect("OK", 1000)`、`expect("ERR|ERROR", 1000)`、`expect("\\d+\\.\\d+", 2000)`,**不要**写 `expect(/OK/, 1000)`。原因:字面量 `/OK/` 传进函数会被转成字符串 `"/OK/"`,里面的斜杠让正则编译失败。pattern 用的是 Rust `regex` crate 语法,常用特性(字符类、`+`/`*`/`?`、`|`、`^`/`$`、`\d`\`\w`)都支持,别用反向引用等高级特性。

4. **默认 30 秒超时,死循环会被强杀。** 脚本总执行时间上限 30s,到点未完成会被中断、显示"脚本执行超时"。所以 `expect` 的 `timeout_ms` 不要设太大(通常 500~3000ms),循环要有出口。

5. **用户自己 `throw` 的错误会正常传播。** `throw new Error("设备未响应")` 会让脚本以失败结束,消息显示在结果栏——这是"中止并报错给用户"的正道。配合第 1 条:`expect` 没等到 → `throw` 报清楚原因。

## 写好脚本的几个模式

### 发命令 → 等响应 → 判断
最基本的两步。注意 `expect` 后**一定判断**:
```js
await clear();                         // 清掉历史,确保 expect 等的是新响应
await send("AT");
const line = await expect("OK", 1000); // 等 1 秒内出现含 OK 的行
if (line === "") {
  throw new Error("未收到 OK——检查波特率/接线/设备上电");
}
// 收到 OK,继续
```

### 失败重试(这是宏做不到、脚本的核心价值)
设备偶尔漏响应,重试 N 次:
```js
await clear();
let ok = "";
for (let i = 1; i <= 3; i++) {
  await send("AT");
  ok = await expect("OK", 1000);
  if (ok) break;                        // 收到就跳出,不再重试
  await sleep(300);                     // 没收到,缓一下再来
}
if (!ok) throw new Error("重试 3 次均无响应");
```

### 按返回内容分支
根据设备回了什么走不同路径:
```js
await send("AT+CGMM");
const model = await expect("\\S+", 1500);   // 匹配任意非空行
if (model === "") throw new Error("未响应");
if (model.includes("SIM800")) {
  await send("AT+CSQ");                      // 走 SIM800 的查询
  const sig = await expect("\\d+", 1000);
  throw new Error("SIM800 信号: " + sig);
} else if (model.includes("ESP")) {
  await send("AT+GMR");
  const ver = await expect(".+", 1500);
  throw new Error("ESP 版本: " + ver);
} else {
  throw new Error("未知型号: " + model);
}
```

### 周期采集(循环 + sleep)
```js
for (let i = 0; i < 10; i++) {
  await send("AT+TEMP?");
  const v = await expect("\\d+", 1000);
  if (v) throw new Error("第" + (i+1) + "次温度: " + v);  // 仅演示如何"打印"
  await sleep(1000);
}
```
> 注:循环里 `throw` 会立刻中断。要采集多轮再一起输出,把结果攒进数组,循环结束后 `throw new Error(arr.join("\n"))`。

### 调试技巧
想看某个变量:`throw new Error("debug: line=[" + line + "] len=" + line.length)`。看到后删掉。

## 完整示例:AT 设备初始化 + 自检

```js
// 初始化一个 AT 设备:重置 → 重试等就绪 → 关回显 → 查信号
await clear();
await send("ATZ");                       // 软复位
await sleep(500);

let ready = "";
for (let i = 1; i <= 5; i++) {
  ready = await expect("OK", 800);
  if (ready) break;
  await sleep(400);
}
if (!ready) throw new Error("设备未就绪(复位后 5 次无 OK)");

await send("ATE0");                      // 关回显,让 expect 不再匹配到自己发出的命令
if (await expect("OK", 1000) === "") throw new Error("关回显失败");

await send("AT+CSQ");                    // 查信号质量
const csq = await expect("CSQ:\\s*\\d+", 1500);
if (csq === "") throw new Error("查询信号失败");
throw new Error("✅ 自检通过,信号: " + csq);
```

## 如何在 Serial Studio 里运行(告诉用户)

1. 打开一个串口(脚本跑在**当前活动端口**上,必须先连一个)
2. 按 `Ctrl+Shift+B` 打开脚本侧栏 → 点"+"新建 → 起名、粘贴脚本 → 保存
3. 点行前的 ▶ 运行(或 `Ctrl+B` 打开选择面板回车运行)
4. 看结果栏:✓ + "完成" 表示跑完;✗ + 消息是脚本 `throw` 出的内容(含你的调试/汇总信息)

> 远程/Web 端默认禁用脚本(`enable_scripting`),本地桌面端可直接用。

## 输出约定

- 主体是一段 JS 代码(用代码块),自包含、可整段粘贴
- 脚本里用注释标清每一步在干什么(中文,简短)
- 代码后用一两句话说明:这个脚本假设的设备/波特率、需要在哪个端口跑、预期看到什么结果
- 如果用户的流程其实很简单(纯顺序发几条命令、不需要判断/重试),告诉他**用宏更合适**,别硬写脚本
- 涉及具体设备命令时,如果用户没给,按常见 AT 设备的惯例给样例并提示"按你的设备手册调整命令"
