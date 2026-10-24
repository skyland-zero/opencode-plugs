# OpenCode TPS Meter

OpenCode V2 的实时 TPS（tokens per second）显示插件，参考
[`pi-tps-meter`](https://github.com/skyland-zero/pi-tps-meter) 的行为实现。

## 显示内容

**等待首 token**（请求已发出，但还没有输出）：

```text
⠹ ▕···········▏ τ1.4s
```

**流式输出中**：

```text
⠹ ▕███████▋···▏ 47 tps · τ0.8s
```

**有子代理同时运行时**（`Σ` 表示合并值，`2a` 表示 2 个活跃子代理）：

```text
⠹ ▕████████▊··▏ Σ 168 tps · 2a · τ0.8s
```

**一条消息结束后**（最近 12 条消息的 sparkline、滚动平均、全局均值、p95、平均 τ）：

```text
▁▄▇▅▂▁▇█▅▃▆▇ 42 tps · μ 39 · p95 61 · τ0.9s
```

颜色阈值：绿色 ≥ 50 tps，黄色 20–50 tps，红色 < 20 tps。τ 单独按
<1s / 1–3s / ≥3s 着色。

## 安装

把 `tps-meter` 目录放到全局插件目录：

```text
~/.config/opencode/plugins/tps-meter/
```

OpenCode 会自动发现并加载它，不需要在 `cli.json` 里额外注册。保存文件后
TUI 会自动重载插件；如果没有出现，运行 `/reload` 或重启 TUI。

可以用下面的命令确认插件已被发现：

```sh
opencode plugin list
```

输出中应包含：

```text
-   local    C:\Users\<you>\.config\opencode\plugins\tps-meter
```

## 配置

默认配置即可使用。要调整行为，在 `cli.json` 里用对象形式列出同一个目录
（按路径去重，不会重复加载）：

```json
{
  "plugins": [
    {
      "package": "./plugins/tps-meter",
      "options": {
        "mergeAgents": true,
        "mergeStats": true,
        "sparkline": true,
        "gauge": true,
        "compact": false
      }
    }
  ]
}
```

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `mergeAgents` | `true` | 把子代理的实时速率合并到父会话的 `Σ` 显示 |
| `mergeStats` | `true` | 把子代理完成的消息计入父会话的 sparkline / 平均 / p95 |
| `sparkline` | `true` | 消息结束后显示最近 12 条的 sparkline |
| `gauge` | `true` | 流式时显示进度条 |
| `compact` | `false` | 强制使用紧凑显示（不显示 sparkline / p95） |
| `slot` | `"status"` | `"status"` 使用 `prompt.footer.status`，`"footer"` 使用整条 `prompt.footer` |
| `animate` | `true` | 显示旋转 spinner |
| `fast` | `50` | 绿色 TPS 阈值 |
| `medium` | `20` | 黄色 TPS 阈值 |
| `ttftFastMs` | `1000` | 绿色 τ 阈值（毫秒） |
| `ttftMedMs` | `3000` | 黄色 τ 阈值（毫秒） |
| `windowMs` | `60000` | 滚动平均窗口（毫秒） |
| `sparkLength` | `12` | sparkline 样本数 |
| `minDecodeMs` | `200` | 低于此时长的 decode 窗口不记录速率 |
| `maxTps` | `1000` | 高于此值的样本视为缓冲回放，不记录速率 |

## 命令

| 命令 | 说明 |
| --- | --- |
| `/tps` | 在 toast 中显示当前会话的统计 |
| `/tps reset` | 清空当前会话的统计 |
| 命令面板 → `TPS meter` | 与 `/tps` 相同 |

## 计算方式

- **实时 TPS**：按 `文本 + 推理 + 工具参数` 的字符数 / 4 估算。OpenCode
  的流式事件没有逐 token 的 usage，所以这是流式期间的估算值。
- **完成后的 TPS**：使用 provider 返回的真实 usage：
  `tokens.output + tokens.reasoning`，除以从首个输出 delta 到
  `session.step.streamed` 的时间。工具执行时间不会计入分母。
- **τ（time to first token）**：第一个 step 从 `session.execution.started`
  开始计时，后续 step 从 `session.step.started` 开始；首个
  `text.delta` / `reasoning.delta` / `tool.input.delta` 到达时锁定。
- **缓冲回放保护**：decode 窗口 <200ms 或速率 >1000 tps 的样本只记录 τ，
  不写入 TPS 统计，避免把 provider 一次性 flush 的完成内容算成异常高速率。
- **子代理**：按 `session.parentID` 构建会话树，父会话显示合并后的 `Σ`；
  子代理自己的会话页仍然显示自己的数据。

## 与内置 TPS 的关系

`cli.json` 里的 `session.tps` 控制 assistant footer 里的 `tok/s` 显示。它和
这个插件互不冲突：

- 内置 TPS：每条 assistant 消息结束后显示一个平均值。
- 本插件：在输入框底部实时显示速率、τ、sparkline 和会话统计。

如果只想保留插件，设置：

```json
{
  "session": {
    "tps": false
  }
}
```
