# dsh-session-delete

在 DSH Web 界面里删除会话。

DSH 自身不提供删除会话的能力：`SessionPersistence` 只有 `create`/`open`/`flush`/`stat`/`list`，`WorkspaceRegistry` 只有 `archive`/`unarchive`，两侧都没有 delete。会话日志本质上就是磁盘上的一个目录，所以本插件添加了删除操作。

## 功能

- 侧边栏任意会话行的「...」菜单里新增「删除会话」（位于「归档会话」之后）
- 可以删除**任意**会话，包括正在运行或正打开着的会话 —— 删除前会先停止它的运行中工作
- 确认对话框显示：会话标题、创建时间、日志大小、子会话数量
- 对话框内嵌「下载此会话的 ZIP 归档」链接，引导先备份
- 必须勾选确认框才能点删除（不可逆操作）
- 删除后侧边栏行立即消失（不刷新页面）

## 安装

装到 `web` profile（其他 profile 同理，把 `web` 换掉即可）：

### 方式一：从 Git 仓库安装（推荐）

```bash
dsh plugin --profile web add git+https://github.com/<you>/<repo>.git
```

`dsh plugin add` 转发给 pnpm，装完会自动把新装的 bundle 追加到 profile 的 `dsh.profile.bundles`（依据包里 `dsh.bundle` 字段），无需手工改 `package.json`。

> **若安装报错说某个依赖的构建脚本被拦截**：pnpm 默认不运行已安装依赖的 `prepare` 脚本，而 git 依赖需要先构建。此时按提示把包加进 profile 的 `pnpm-workspace.yaml`（在 `~/.dsh/profiles/web/` 下）：
>
> ```yaml
> packages:
>   - .
>
> allowBuilds:
>   dsh-session-delete: true
> ```
>
> 然后重跑上面的安装命令。（pnpm ≥ 11 把 `onlyBuiltDependencies` 等设置合并成了这个 `allowBuilds` 映射；详见 [pnpm v10 → v11 迁移说明](https://pnpm.io/migration)。）

更新到最新版：

```bash
dsh plugin --profile web update dsh-session-delete
```

卸载：

```bash
dsh plugin --profile web remove dsh-session-delete
```

### 方式二：从本地目录安装

```bash
dsh plugin --profile web add link:/absolute/path/to/dsh-session-delete
```

把路径换成下载下来的**绝对路径**。这里必须用绝对路径：`link:` 的相对路径是相对 profile 的 manifest 目录解析的（即 `~/.dsh/profiles/web/`），写成 `./dsh-session-delete` 会指向 `~/.dsh/profiles/web/dsh-session-delete` 而装不上。

### 装完之后

两种方式装完都要**重启 `dsh web`** —— bundle 与浏览器半身只在启动时加载（`patchReload: live` 只能热更新 patch，加载不了新的浏览器代码）。

用这条确认挂载成功：

```bash
dsh --profile web --dump-config   # 应能看到 `dsh-session-delete` 条目
```

## 删除一个会话时会发生什么

按顺序，任何一步失败即中止，不进入下一步：

1. **停止运行中工作** —— 派发 `workspace/session-stop`（与 DSH 归档时 `stopActivity: true` 同一事件），各 provider 取消该会话的回合、子代理、任务与提醒；随后短暂等待让取消落地。provider 抛错只记日志，**不阻断**删除。
2. **flush 屏障** —— `sessionPersistence.flush()`，确保没有缓冲事件。失败不阻断，后续的白名单校验仍然守住字节。
3. **定位目录** —— 从 header 自带的 `cwd` 算出目录。**不扫描** sessions 根目录。
4. **探测目录** —— 直接 `stat`。目录已不在则如实返回 `absent`，而不是谎报成功（`fs.rm({force:true})` 对缺失目录是静默通过的）。
5. **内容白名单校验** —— 目录内只允许 `session.v<N>.jsonl[.zstd]` 与 `session.lock`。出现任何其他文件则**拒绝删除**，错误信息列出文件名。
6. **递归删除** —— `fs.rm(dir, { recursive: true, force: true })`。若操作系统的句柄锁挡住（Windows `EPERM`/`EBUSY`，POSIX `EACCES`/`ETXTBSY`），返回 `session/in-use`，提示关掉该会话后重试。
7. **清理注册表** —— 优先走 `ctx.workspaceRegistry` 的 `unarchiveSession` / `unpinSession` / `detachSession`，它们同时更新内存缓存、持久化表与已连接浏览器的推流。没有 registry 组成时回退为原子改写 `workspace.json`（临时文件 + rename，并留一份 `.bak`）。此步失败**不阻断**删除，仅在响应里标记 `registryCleaned: false`。
8. **发布移除公告** —— 发出 `api-session/removed`，DSH 既有的转发链路会把该行从所有已连接浏览器的侧边栏移除。不发这一步，行会一直留到下次刷新。

## 会话目录是怎么算出来的（没有扫描）

JSONL 后端的目录布局是：

```
<DSH_HOME>/sessions/<projectKey(cwd)>/<encodeSegment(sessionId)>/session.v4.jsonl.zstd
```

`config.root` 是后端实例上的公开字段，`sessionPersistence.list()` 返回的每个 snapshot 的 header 又自带 `cwd`。所以目录是两个确定性变换的结果，本插件在 [`index.js`](./index.js) 里逐字符复刻了它们：

- `encodeSegment(raw)` —— 把任意字符串编码成单个安全路径段（`~`、`../`、分隔符都转成 `~XXXX`）
- `projectKey(cwd)` —— 把 cwd 变成可读的项目目录名，分隔符折叠成 `-`，两端加 `--`。例如 `/home/me/projects/demo` → `--home-me-projects-demo--`

`cwd` 已被删除或移动也不影响：`projectKey` 是纯字符串变换，不碰文件系统。

> 如果 DSH 升级改了这两个变换，删除会开始对存在的会话报 `session/absent` —— 这是安全的失败方向。届时需要同步更新这两个函数。

## HTTP 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/session-delete/sessions` | 可删会话清单 |
| POST | `/api/session-delete/delete` | 删除（body `{sessionId}`） |

两条路由都套 `ctx.connection.requestRejection()` 信任栅栏（Host/Origin 伪造 + 未认证拒绝），并且**写请求额外要求来源是回环地址**：删除不可逆，一个 Web 会话令牌不该足以让局域网里另一台机器销毁历史记录。

## 安全设计

- **目录必须在 sessions root 之内**，且 basename 必须等于 `encodeSegment(sessionId)`
- **sessionId 必须匹配** `/^[A-Za-z0-9._-]{1,128}$/`
- **内容白名单**：用户放在会话目录里的文件不是本插件该销毁的，宁可拒绝
- **先停后删**：删除前派发 `workspace/session-stop`，避免在活跃写入者下面撕裂日志；真正被句柄挡住时操作系统自己会拒绝，映射为 `session/in-use`
- **注册表原子写**（回退路径）：临时文件 + rename，崩溃不会截断 `workspace.json`，并留 `.bak`

## 不会做的事

- **不删附件存储**（`attachments` 目录）—— 内容寻址的共享存储，多个会话可能引用同一张图
- **不做批量删除** —— 只做单会话，降低误操作面
- **不做回收站/软删除** —— DSH 的归档已经是软删除，再叠一层语义混乱
- **不改 DSH 本体** —— `node_modules` 里的 `@deepseek-ai/*` 是只读安装产物
- **不全盘扫描 sessions 根目录** —— 目录由 header 的 `cwd` 确定性算出

## 结构

```
dsh-session-delete/
├── package.json      # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml  # 一行 insert 挂载
├── index.js          # Host 半身：路径构造 + 服务 + 路由 + 信任栅栏
├── client.js         # Browser 半身：菜单项 + 确认对话框 + locale
└── README.md
```

两个半身都是手写的，无构建步骤。Host 半身只用 `node:fs` 与 `node:path`；浏览器半身 require 三个 shell 已提供的模块：`react`、`@deepseek-ai/dsh-client-ui-primitives`（组件与图标）、`@deepseek-ai/dsh-client-store`（`createSnapshotStore`，让确认对话框对请求做出反应）。

`inject` 在两个半身里都是空的：cordis 会把 `inject` 点名但缺失的服务对应的 fiber 永久挂起，所以依赖统一用 `ctx.inject([...], cb)` 局部等待 —— 缺某个服务时降级的是一个功能，而不是整个插件。

## 排障

| 现象 | 原因 |
|---|---|
| 菜单里没有「删除会话」 | 插件没装上，或 `dsh web` 没重启 |
| 删除报 `unexpected-contents` | 会话目录里有非会话文件，按提示核对后手工处理 |
| 删除报 `session/in-use` | 操作系统拒绝了句柄（会话仍被某个进程握着）；关掉该会话或结束占用它的进程后重试 |
| 删除报 `session/absent` | 目录不存在；注册表残留仍会被清理。若对所有会话都这样，检查 `index.js` 的两个路径函数是否与当前 DSH 版本一致 |
| 删除成功但侧边栏行还在 | `api-session/removed` 没发出；刷新页面可确认磁盘上确实已删。检查 Host 日志有无 registry 相关告警 |
| 删除成功但归档列表有空白行 | `registryCleaned: false`；重启 DSH 后 bootstrap 会自行 reconcile |
| 403 | 非回环地址发起了写请求 |
