# dsh-shell-skills

在 DeepSeek Harness 里运行 **shell-skills** 的 Python skill：扫描 `skill.py`、发布 `shellSkills` 服务给上下文注入插件、提供 `shell_skill` 工具，并在 Plugins 页面附带一个安装/启停/卸载管理卡。

## 它做什么

- **扫描**：`<root>/<name>/skill.py`，按 shell-tool 的规则解析头部（`# skill:` / `description` / `status` / `usage`，前 300 行）。
- **服务** `shellSkills`：`list()`（仅已安装且启用）、`all()`、`get()`、`setStatus()`、`install()`、`remove()`、`run()`、`listRemote()`。
- **工具** `shell_skill`：`all=true` 列表、`skill=name` 只返回该 skill 的 `# usage:` 块（不含描述/状态/信封，原样作 `result` 返回）、带 `arguments` 执行、`action` 做安装/启停。
- **设置页**：配置远程仓库（留空走 GitHub 公共仓库，填内网基址即走 Gitea 接口，类型不单独配置）、查看已安装与远程 skill；已安装项用开关启停、可卸载，远程项用下载按钮安装。

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
| `hubBase` | （空） | 自建仓库基址，如 `http://192.168.30.181:3000`。**留空即 GitHub 公共仓库**；填了就走 Gitea 接口（`/api/v1/...`），类型由 URL 推断，没有单独的 `hubType` |
| `hubRepo` | `abc12524/shell-skills` | `owner/repo` |
| `hubBranch` | `main` | 远程分支 |
| `root` | `~/.dsh/shell-skills` | skill 根目录；可指向 shell-tool 的 `skill/` |
| `pythonPath` | 平台默认 | Windows `python`，其它 `python3` |
| `runTimeoutMs` | `60000` | 单次执行超时 |
| `installTimeoutMs` | `30000` | 远程请求超时 |
| `hubTokenRef` | `SHELL_SKILLS_TOKEN` | 凭据引用（私有仓库用），不落配置文件 |

`installedJson` / `remoteJson` / `statusJson` / `pendingAction` / `lastActionId` **不在这个配置文档里**。它们属于同包的第二个 entry `dsh-shell-skills-state`（`dsh-shell-skills/state`），是一个只放 volatile 状态、没有设置卡片的内部文档。

```yaml
- id: dsh-shell-skills-state
  config:
    installedJson: "[]"
    statusJson: '{...}'
    pendingAction: '{...}'
    lastActionId: ...
```

拆开的原因：状态回写和表单保存共用 settings 的 revision 栅栏，放在同一个文档里会让"Host 刚同步完状态"直接把用户正在保存的表单打成冲突（就是设置页那条"本部署没有接受这些值"）。

## 技能脚本的导入兼容

共享 shell-skills 的脚本按 shell-tool / 移动端约定取结果信封：

```python
try:
    from _envelope import ok, error
except ImportError:
    from core.tools.envelope import ok, error
```

本插件没有 `core` 包，所以运行器在加载技能前把 `lib/shims/` 放进 `sys.path`，让第一条导入命中内置垫片；返回的 JSON 信封与 `core.tools.envelope` 完全一致。技能目录自带的 `_envelope.py` 仍然优先。

## 与 dsh-inject-context 对接

两个插件的分工只有一条线：**名单归注入，用法归工具。**

| 谁 | 拿什么 | 从哪来 |
|---|---|---|
| `dsh-inject-context` | 已安装且启用的 skill **名字 + 一句话说明** | `shellSkills.list()` → `{ name, description }` |
| 模型要"怎么用" | 该 skill 的 `# usage:` 原文 | `shell_skill` 工具，`skill="<name>"`（按需调用） |
| 模型要"执行" | skill 的返回值 | `shell_skill` 工具，`skill="<name>"` + `arguments` |

`list()` 里**不含 usage**，注入块里也不含；两者都不读 `get()`。所以会话开头只有一份指针清单，参数文档不会白占每个会话的 prompt —— 这正是 `list()` 保持这么窄的原因。

```yaml
- id: dsh-inject-context
  name: dsh-inject-context
  config:
    skillList: true        # 设置页开关，默认开
    skillService: shellSkills
```

要让名单出现在会话里，还需要 `dsh-inject-context` 与本插件同时加载：它每会话首次对话读一次 `shellSkills.list()`，把名单插到用户提问下方（名单本体用独立的 `<shell_skills>` 块，与 harness 自带 `tool-skill` 的 `<available_skills>` 并行，两者互不遮蔽）。

## 设置页为什么是"保存式"的

外部插件不能新增 `ctx.remote.*` 命名空间（`dsh-api-remotes` 的客户端能力在构建期固定）。所以卡片与 Host 走一个私有协议：

1. 表单保存只写 `dsh-shell-skills`（可编辑配置）；
2. 点按钮 → `stateScope.mutate` 写 `dsh-shell-skills-state` 的 `pendingAction = { id, type, name, at }`；
3. Host 每秒读一次，执行后把 `installedJson` / `statusJson` / `lastActionId` 写回**状态文档**，并把已确认的 `pendingAction` 清空；
4. 状态文档快照更新 → 卡片重绘。

**两个文档是分开的**：状态写入不会改变表单文档的 revision，所以"Host 正在同步状态"不会再让用户点保存时撞上 revision 栅栏（那条"本部署没有接受这些值，已保留供你修改"的提示）。

动作按 `id` 幂等：同一个 id 只执行一次，重启后也不会重放（`lastActionId` 持久化在 profile 里）。代价是按钮到结果之间最多约 1 秒延迟。

**卡死保护**（三个方向，缺一不可）：

- **总开关不冻结动作**：`enabled: false` 只停周期性扫描，队列里的 `pendingAction` 仍会执行；否则"先刷新、再关开关"会让动作永远留在队列里。
- **动作带时间戳**：卡片写入 `at`；Host 遇到超过 10 分钟的动作直接标记完成（`expired`），不会在几小时后重放旧意图。
- **卡片 30 秒兜底**：点按后最多显示"处理中" 30 秒；Host 通过 `lastActionId` 确认时提前解除，Host 不在/请求卡住时自动恢复。旧版本写入的、没有 `at` 的动作一律视为过期，不会把卡片永久钉在"处理中"。

如果确实需要手动清理，删掉 profile 的 `cordis.patch.yml` 里 `dsh-shell-skills-state` 块的 `pendingAction` 字段并重启即可。

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