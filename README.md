# dsh-session-recycler

[English](README.en.md) | 中文

在 DeepSeek Harness 的 Web UI 里**删除指定会话记录**，并带一个**回收站**（可恢复 / 可彻底删除）。官方 UI 只提供「归档」（从列表隐藏，文件还在），不提供删除。

## 装了什么

- **Host 半** `lib/index.js`：6 个 JSON 路由
  - `GET  /x-dsh-session-recycler/list` 会话清单（标题、时间、大小、cwd、空白/运行中/被占用标记）
  - `POST /x-dsh-session-recycler/delete` 删除
  - `GET  /x-dsh-session-recycler/trash` 回收站清单
  - `POST /x-dsh-session-recycler/trash/restore` 恢复
  - `POST /x-dsh-session-recycler/trash/purge` 彻底删除
  - `GET  /x-dsh-session-recycler/ping` 自检
- **Browser 半** `lib/client.js`：侧边栏底部「删除会话」入口，弹窗内两个 tab：**会话** / **回收站**。

工具栏只有一个「全选」按钮，它本身就是个开关：全部选中时变成「取消全选」。不再单独放「清空」按钮——功能重复。

## 安装

```sh
# 从 npm（推荐）
dsh plugin --profile web add dsh-session-recycler

# 或直接从 GitHub 源码
dsh plugin --profile web add github:iamwuzhanglin/dsh-session-recycler

systemctl restart dsh-web      # bundle 层变更不走 HMR
```

装完刷新一次浏览器页面（client bundle 的 rev 变了）。

也可以在 [dsh-market](https://github.com/dsh-market/dsh-market) 插件市场里搜索 `dsh-session-recycler` 一键安装。

## 删除做了什么

1. **正在运行**的会话拒绝删除（`agent.status === 'running'`）。
2. 仍在内存里的（某个标签页打开过）会话，先 `archiveSession({ stopActivity: true })`，堵死后续写入。
3. 冷会话探测 `session.lock` 的 `flock`：被别的进程持有则拒绝。
4. 会话目录 `rename` 进回收站 `$DSH_HOME/.session-recycler-trash/<ISO时间戳>-<会话ID>/`，并在里面写一个 `.dsh-session-recycler.json` sidecar（标题/cwd/删除时间）。
5. 从 `workspaceRegistry` 的**工作区记账**和 pin 集合里摘掉（`detachSession` + `unpinSession`）。
   **归档标记（`archivedSessionIds`）对 live 会话是保留的**：宿主没有公开 API 能把 Session 从内存 store 摘掉，那条 ghost 行会一直留在 `sessionQuery.listSessions()` 里直到宿主重启；而前端把所有"不属于任何工作区"的会话塞进「未分组」，所以只有归档标记能压住它。冷会话则相反，会顺手清掉遗留的归档标记。
6. 把投影缓存 `$DSH_HOME/storages/session_projcache/sessions/<id>.json` 停进回收站条目的 `.projcache/`（标题存在这里）。
7. 广播 `api-session/removed`，已连接的页面即时移除该行。

> ⚠️ **live 会话删除后会留一条不可见的 ghost 行**，直到 `systemctl restart dsh-web`。它被归档标记挡着：列表不显示，`ArchivedSessionGate` 拒绝它的 `agent/pre-step`，所以不会"点进去聊不了"，也不会重新写日志。删除接口的结果里 `liveGhost: true` 表示遇到了这种情况。

## 回收站

回收站目录：**`$DSH_HOME/.session-recycler-trash/`**（即 `$DSH_HOME/.session-recycler-trash`）。它就是一个普通目录，不是文件。里面每一项是一次删除：

```
$DSH_HOME/.session-recycler-trash/
└── 2026-11-03T04-16-51-851Z-session-aaaa.../
    ├── session.v4.jsonl.zstd      # 会话日志本体
    ├── session.lock
    └── .dsh-session-recycler.json   # 插件写的元数据（标题、cwd、删除时间）
```

弹窗里的**回收站 tab** 可以：勾选 → 「恢复」（搬回原工作区目录）/「彻底删除」（`rm -rf`，不可逆）。也可以在终端里直接 `ls` 这个目录、手工 `mv` 回去。

恢复靠读会话日志头里的 `cwd` 反推项目目录（`projectKey()` 与 JSONL 后端同算法）；读不出来时退回 sidecar 里记的 cwd。

恢复时会**先 `unarchiveSession` 解除归档**，否则从 live 会话回收站里恢复出来的会话会一直隐藏、且被 `ArchivedSessionGate` 拦着跑不了。

**恢复不需要重启 dsh。** 恢复时插件做三件事，让已连接的页面直接更新：

1. `unstashProjectionCache()` —— 把删除时一并存进 `<条目>/.projcache/` 的投影缓存放回 `$DSH_HOME/storages/session_projcache/sessions/`。**标题存在这里**，不还原就只能显示成项目目录名。
2. `reattach()` —— `readSessionHeader()` 读 cwd → `resolveByPath()` 找工作区 → `attachSession()` 重新登记。
3. `api-session/added` —— 广播完整 summary，页面即时插入该行。

只有一种情况需要手动刷新：页面是在这次删除*之前*就打开的，且 host 端重启过（事件广播不跨进程）。

## 「空白」和「被占用」是什么

- **空白**：点了「新会话」但没发过消息。dsh 会把这 5 条初始化事件（`session`/`permission/preset`/`sandbox/mode`/`approval/policy`/`subagent/model-selection-policy`）落盘，留着给下次复用（`dsh-api-session-controller` 的 `reuseLive`）。所以点一次不聊就会攒一个，删掉没有损失。
- **被占用**：另一个进程正持有该会话 `session.lock` 的 `flock`。可能是 dsh 主进程还开着它（打开过标签页），也可能是另一个 dsh 实例。插件只对**冷**会话做这个检查；内存里的会话走「先归档再删」，所以不会误伤。
- **运行中**：该会话正在跑一轮对话。这个唯一会阻止勾选。

## 配置

`cordis.patch.yml`：

```yaml
- id: dsh-session-recycler
  name: dsh-session-recycler
  config:
    trashDir: .session-recycler-trash   # 相对 $DSH_HOME
```

## 安全边界

- 会话 ID 走白名单正则 + 逐级 `realpath` 前缀校验，杜绝 `../` 穿越。
- 只在 `$DSH_HOME/sessions/<project>/<session-id>` 形态下落手。
- 两阶段：先 `rename` 进回收站（原子），成功后才清索引。
- 索引走 `workspaceRegistry` 的正式 API，不手改 `workspace.json`。
- 回收站条目名同样做穿越校验。

## 测试

```sh
node test/host.test.mjs     # 宿主半：列表/删除/索引清理/闸门/回收站/zstd 往返
node test/routes.test.mjs   # 路由级：真实 http 服务上跑通 6 个接口
node test/client.test.mjs   # 浏览器半：工厂、槽位、弹窗、tab、不透明底色、关闭
```

## 已知限制

- 正在运行的会话必须先停掉才能删。
- **live 会话删不掉内存副本**：宿主 `sessions` 服务只暴露 `get`/`list`，`detach` 闭包握在 `agent-loop` 手里。删除后磁盘和回收站是干净的，但那条会话还在内存里，直到重启 dsh-web。插件用「保留归档」把它的可见性和运行能力都封死。
- `deleted.json` 账本**只影响插件自己的弹窗列表**，Web UI 的会话列表不读它。
- 不删 `attachments/` 里被引用的图片字节（由单独附件仓管理）。
- 会话搜索索引默认 `:memory:`，重启即重建，无需处理。
