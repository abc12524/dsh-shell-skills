# dsh-shell-skills

在 DeepSeek Harness 里运行 **shell-skills** 的 Python skill：扫描 `skill.py`、发布 `shellSkills` 服务给上下文注入插件、提供 `shell_skill` 工具，并在 Plugins 页面附带一个安装/启停/卸载管理卡。

## 它做什么

- **扫描**：`<root>/<name>/skill.py`，按 shell-tool 的规则解析头部（`# skill:` / `description` / `status` / `usage`，前 300 行）。
- **服务** `shellSkills`：`list()`（仅已安装且启用）、`all()`、`get()`、`setStatus()`、`install()`、`remove()`、`run()`、`listRemote()`。
- **工具** `shell_skill`：`all=true` 列表、`skill=name` 看用法、带 `arguments` 执行、`action` 做安装/启停。
- **设置页**：配置远程仓库（GitHub / Gitea）、查看已安装与远程 skill；已安装项用开关启停、可卸载，远程项用箭头图标下载。

## 安装

把包放进 DSH profile（或者本地 `file:` 安装），然后在 profile patch 里加：

```yaml
- insert:
    - id: dsh-shell-skills
      name: dsh-shell-skills
      config:
        root: ~/.dsh/shell-skills
        # pythonPath: python3
```

`@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery` 是 peer 依赖，由 harness 的 profile 解析引导指向本体自带副本。

## skill 规范

与 shell-tool 完全一致：

```python
# skill: echo
# description: 回显输入
# status: enable
# usage:
#   echo(text) → 返回 {"echo": text}
import json


def run(arguments: dict):
    return {"echo": arguments.get("text", "")}
```

- 文件夹名建议与 `# skill:` 名称一致；入口固定 `skill.py`。
- 助手模块放同目录、以 `_` 开头，用相对导入：`from ._impl import ...`。
- `run(arguments)` 返回 str / dict / list；str 直接作为结果，其余 JSON 序列化。
- `status: disable` 仍在注册表中、仍可按名称执行，只是不进 `list()` 披露。
- `config.json` 与 `*.conf` 在重装时保留；`config.example.json` 会自动复制为 `config.json`。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭后 Host 停止同步管理状态（工具仍可显式调用） |
| `hubType` | `github` | `github` / `gitea` |
| `hubBase` | （空） | Gitea 基址，如 `http://192.168.30.181:3000`；GitHub 忽略 |
| `hubRepo` | `abc12524/shell-skills` | `owner/repo` |
| `hubBranch` | `main` | 远程分支 |
| `root` | `~/.dsh/shell-skills` | skill 根目录；可指向 shell-tool 的 `skill/` |
| `pythonPath` | 平台默认 | Windows `python`，其它 `python3` |
| `runTimeoutMs` | `60000` | 单次执行超时 |
| `installTimeoutMs` | `30000` | 远程请求超时 |
| `hubTokenRef` | `SHELL_SKILLS_TOKEN` | 凭据引用（私有仓库用），不落配置文件 |

`installedJson` / `remoteJson` / `statusJson` / `pendingAction` / `lastActionId` 是 Host 与设置页之间的状态字段，不要手改。

## 与 dsh-inject-context 对接

上下文注入插件读取 `shellSkills.list()`：

```yaml
- id: dsh-inject-context
  name: dsh-inject-context
  config:
    skillList: true
    skillService: shellSkills
```

这样每会话首次对话会多一条 `<available_skills>` 名单。**不要**与 harness 自带的 `tool-skill` 同时开 —— 它自己也会发布 skill 目录。

## 设置页为什么是"保存式"的

外部插件不能新增 `ctx.remote.*` 命名空间（`dsh-api-remotes` 的客户端能力在构建期固定）。所以卡片与 Host 走一个私有协议：

1. 点按钮 → `scope.mutate` 写 `pendingAction = { id, type, name }`；
2. Host 每秒读一次，执行后写 `installedJson` / `statusJson` / `lastActionId`；
3. 设置快照更新 → 卡片重绘。

动作按 `id` 幂等：同一个 id 只执行一次，重启后也不会重放（`lastActionId` 持久化在 profile 里）。代价是按钮到结果之间最多约 1 秒延迟。

**卡死保护**（三个方向，缺一不可）：

- **总开关不冻结动作**：`enabled: false` 只停周期性扫描，队列里的 `pendingAction` 仍会执行；否则"先刷新、再关开关"会让动作永远留在队列里。
- **动作带时间戳**：卡片写入 `at`；Host 遇到超过 10 分钟的动作直接标记完成（`expired`），不会在几小时后重放旧意图。
- **卡片 30 秒兜底**：点按后最多显示"处理中" 30 秒；Host 通过 `lastActionId` 确认时提前解除，Host 不在/请求卡住时自动恢复。旧版本写入的、没有 `at` 的动作一律视为过期，不会把卡片永久钉在"处理中"。

如果确实需要手动清理，删掉 profile 的 `cordis.patch.yml` 里 `dsh-shell-skills` 块的 `pendingAction` 字段并重启即可。

## 安全

- 安装即信任远程仓库的代码；skill 在子 Python 进程里运行，不影响 harness 进程，但**拥有当前用户权限**。只装可信来源。
- Windows 上 `child.kill()` 只杀直接子进程；skill 自己再拉起的进程不会被清理。
- 私有仓库 token 走凭据域（`hubTokenRef`），不写进配置文件。

## 测试

```sh
pnpm install          # 首次
node test/smoke.mjs
```

覆盖：配置字段、扫描/过滤、BOM+CRLF 状态改写、GitHub 安装与配置保留、卸载、真实 Python 执行（含相对导入）、工具路由、`pendingAction` 幂等、浏览器半接线。

## 已知限制

- 安装只走 Contents API，没有 tarball 回退（shell-tool 有）；API 限流时请重试或换 token。
- 远程列表需要手动"刷新远程列表"，不会自动轮询。
- 启用/禁用会改写 `skill.py` 头部；如果 skill 目录只读，操作会失败并在设置页显示错误。
- `enabled=false` 只停同步，不阻止 `shell_skill` 工具执行。

## License

MIT