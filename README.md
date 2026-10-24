# OpenCode Plugins

OpenCode V2 TUI 的本地插件集合。每个子目录是一个独立插件，直接复制到全局插件目录即可使用。

| 插件 | 说明 | 插件 ID |
| --- | --- | --- |
| [`compact-status`](compact-status/README.md) | 把 agent/model 移到输入框底栏最左侧，隐藏多余快捷键提示，输入框保持垂直居中 | `local.compact-status` |
| [`tps-meter`](tps-meter/README.md) | 输入框底栏实时 TPS、首 token 延迟（τ）、sparkline 和会话统计 | `local.tps-meter` |

## 安装

OpenCode 会自动发现 `~/.config/opencode/plugins/` 下的每个目录。

Windows PowerShell：

```powershell
git clone https://github.com/skyland-zero/opencode-plugs
Copy-Item -Recurse .\opencode-plugs\compact-status, .\opencode-plugs\tps-meter "$env:USERPROFILE\.config\opencode\plugins\"
```

macOS / Linux：

```sh
git clone https://github.com/skyland-zero/opencode-plugs
cp -R opencode-plugs/compact-status opencode-plugs/tps-meter ~/.config/opencode/plugins/
```

保存后 TUI 会自动热重载插件；如果没有出现，重启 TUI，或用 `/plugins` 查看加载状态。

## 说明

- 适用于 OpenCode V2 TUI。
- 两个插件可以独立使用。
- `compact-status` 通过 OpenTUI 渲染树定位输入框内部节点（不是公开 slot）。OpenCode 布局变更时它可能停止隐藏对应内容，但不会导致 TUI 崩溃。
- `compact-status` 的底栏左侧与 `tps-meter` 的底栏右侧互不冲突。

## License

尚未添加许可证。使用或分发前请联系仓库所有者。
