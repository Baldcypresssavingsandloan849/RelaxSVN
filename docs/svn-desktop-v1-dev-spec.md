# SVN Desktop V1 开发说明

## 1. 目标

第一版做一个 macOS 上自用的 SVN 可视化客户端，不做 Finder 右键集成，不内置 SVN，不接入复杂证书体系。核心目标是把日常 SVN 操作做成稳定、清楚、可回溯的图形界面。

V1 主要覆盖：

- 添加已有 SVN 工作副本
- 检出远程仓库
- 更新工作副本或子目录
- 查看本地变更状态
- 选择文件提交并填写提交备注
- 删除文件并提交
- 冲突提示
- 冲突文件调用 VSCode 对比
- 使用本地版本、远程版本或手工处理后标记解决
- 多仓库管理
- Homebrew SVN 检测与一键安装 `subversion`
- 使用旧 TLS/旧证书兼容模式
- App 自己保存账号密码，不让 SVN 写入 macOS Keychain

V1 明确不做：

- Finder 右键菜单集成
- Finder 文件状态 badge
- 内置 SVN 二进制
- 内置 VSCode
- 自动安装 Homebrew
- 复杂三方合并器
- 复杂权限/多人账号系统
- SVN 服务端仓库创建

## 2. 当前本机环境结论

当前机器已检测到：

```text
svn 路径：/opt/homebrew/bin/svn
svn 版本：1.14.5
支持协议：http / https / svn / file
认证缓存：支持 macOS Keychain
VSCode App：/Applications/Visual Studio Code.app
VSCode CLI：/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code
```

当前 shell 里的 `svnl` 不是软链接，而是 alias：

```bash
svnl='OPENSSL_CONF=~/openssl-legacy-svn.cnf svn'
```

旧 TLS 配置文件：

```text
/Users/ww/openssl-legacy-svn.cnf
```

内容：

```ini
openssl_conf = openssl_init

[openssl_init]
ssl_conf = ssl_sect

[ssl_sect]
system_default = system_default_sect

[system_default_sect]
MinProtocol = TLSv1
CipherString = DEFAULT@SECLEVEL=0
```

因此 App 内不应该依赖 `svnl` 这个 shell alias，而应该直接调用 `/opt/homebrew/bin/svn`，并在需要时给子进程注入：

```text
OPENSSL_CONF=/Users/ww/openssl-legacy-svn.cnf
```

## 3. 总体实现路线

V1 使用系统已安装的 SVN CLI，优先通过 Homebrew 安装的 `svn`。

SVN 路径查找顺序：

```text
1. 用户手动配置的 svn 路径
2. /opt/homebrew/bin/svn
3. /usr/local/bin/svn
4. PATH 中的 svn
```

Homebrew 路径查找顺序：

```text
1. /opt/homebrew/bin/brew
2. /usr/local/bin/brew
3. PATH 中的 brew
```

如果检测不到 SVN：

- 如果检测到 Homebrew，显示“一键安装 SVN”按钮，执行：

```bash
brew install subversion
```

- 如果检测不到 Homebrew，提示用户先安装 Homebrew。App 不自动安装 Homebrew。

### 3.1 推荐技术栈

V1 推荐使用：

```text
桌面框架：Electron
前端框架：Vue 3
语言：TypeScript
状态管理：Pinia
本地存储：SQLite
命令执行：Node.js child_process.spawn
打包：electron-builder
```

推荐组合：

```text
Electron + Vue 3 + TypeScript + Pinia + SQLite
```

选择原因：

- 调用 `svn`、`brew`、`code` 这类本地命令最直接
- 适合做仓库列表、文件树、提交面板、冲突面板、日志面板
- UI 迭代速度快，适合自用工具先把流程跑顺
- SQLite 适合保存仓库配置、账号配置、操作记录和任务日志
- Electron 主进程可以统一管理子进程、环境变量、stdin 密码输入和日志脱敏

V1 不优先选择 SwiftUI/AppKit 的原因：

- 原生体验更好，但开发效率较低
- 文件状态列表、日志输出、diff 面板和任务队列实现成本更高
- 第一版不做 Finder 集成，暂时不需要优先走原生扩展路线

V1 不优先选择 Tauri 的原因：

- 体积更小，但需要 Rust 侧处理命令、文件系统和权限
- 当前核心难点是 SVN 流程和 UI，不是性能和包体积

后续如果要做 Finder 右键、Finder badge、菜单栏深度集成，可以再补一个 macOS native helper 或 Finder Sync Extension。

## 4. 核心架构

建议分层：

```text
UI 层
  仓库列表、文件树、提交面板、冲突面板、日志面板、设置页

Application Service 层
  RepositoryService
  WorkingCopyService
  CommitService
  ConflictService
  DependencyService
  CredentialService

SVN Infrastructure 层
  SvnBinaryResolver
  SvnCommandBuilder
  SvnCommandRunner
  SvnXmlParser
  SvnErrorClassifier

Storage 层
  仓库配置
  账号密码
  操作历史
  App 专用 SVN config-dir
```

核心原则：

- 所有 SVN 操作都通过统一 `SvnCommandRunner` 执行
- 禁止 UI 直接拼 SVN 命令
- 密码只能走 stdin，不能进入命令参数和日志
- 所有命令保存脱敏后的执行日志，便于排错
- 所有长任务支持取消和输出流式展示

## 5. SVN 命令通用参数

所有需要认证的 SVN 命令默认加：

```bash
--non-interactive
--no-auth-cache
--username "$USERNAME"
--password-from-stdin
```

不要使用：

```bash
--password "$PASSWORD"
```

原因是密码可能暴露在进程列表、日志或崩溃报告中。

建议每个命令都加 App 专用配置目录：

```bash
--config-dir "$APP_SVN_CONFIG_DIR"
```

示例：

```text
/Users/ww/Library/Application Support/SvnDesktop/svn-config
```

App 初始化时写入 SVN 配置，禁用 SVN 自身认证缓存：

```ini
# config
[auth]
password-stores =
store-passwords = no
store-auth-creds = no
```

```ini
# servers
[global]
store-passwords = no
store-auth-creds = no
```

如果仓库开启旧 TLS 兼容模式，子进程环境变量加：

```text
OPENSSL_CONF=/Users/ww/openssl-legacy-svn.cnf
```

如果需要自动接受老证书错误，可以加：

```bash
--trust-server-cert-failures=unknown-ca,cn-mismatch,expired,not-yet-valid,other
```

## 6. 账号密码存储策略

用户明确要求：账号密码由 App 自己保存，不希望 SVN 写入钥匙串。

V1 可选方案：

### 方案 A：App 本地配置文件

优点：

- 实现简单
- 完全不依赖 Keychain
- 方便迁移和排错

缺点：

- 需要自己做加密或至少权限控制

最低要求：

- 文件权限限制为当前用户可读写
- 日志永远脱敏
- UI 中密码默认隐藏

### 方案 B：App 自己加密后保存

可用一个本地 master key 或系统安全能力做轻量加密。虽然仍然不是让 SVN 写 Keychain，但实现复杂度略高。

V1 如果只是自用，可以先用方案 A，但代码结构保留 `CredentialService`，后续可替换存储方式。

### 6.1 多仓库多账号处理

如果需要连接多个 SVN 服务器，并且每个服务器使用不同账号密码，账号密码不应该做成全局唯一配置，而应该按 credential profile 管理。

推荐模型：

```text
Credential Profile
  名称：公司 SVN
  匹配地址：https://svn.company.com
  用户名：user_a
  密码：******

Repository
  仓库名：项目 A
  远程地址：https://svn.company.com/project-a
  本地路径：/Users/ww/work/project-a
  使用账号：公司 SVN
```

多个仓库可以共用同一个账号配置。例如同一台 SVN 服务器上的多个项目共用 `公司 SVN` 账号。修改密码时只需要更新一次 credential profile。

每次执行 SVN 命令时，`SvnCommandRunner` 根据当前仓库的 `credentialId` 取账号密码：

```bash
svn update "$LOCAL_PATH" \
  --non-interactive \
  --no-auth-cache \
  --username "$USERNAME" \
  --password-from-stdin
```

密码通过 stdin 写入子进程，不拼进命令参数。这样可以避免多个服务器账号串用，也不会让 SVN 自己写入 Keychain。

添加仓库时的推荐交互：

1. 用户输入远程 URL。
2. App 解析协议、host 和根地址。
3. 如果已有匹配的 credential profile，默认选中。
4. 如果没有匹配账号，引导用户新增账号。
5. 连接测试成功后，把仓库和 credential profile 关联保存。
6. 后续登录失败时，提示更新密码或切换账号。

匹配规则建议：

```text
优先：完整认证域，例如 https://svn.example.com
其次：协议 + host
最后：用户手动选择
```

不要只按用户名匹配，因为不同 SVN 服务器可能有相同用户名但密码不同。

## 7. 多仓库配置模型

仓库配置只保存仓库自身信息，并通过 `credentialId` 引用账号配置：

```json
{
  "id": "uuid",
  "name": "Project A",
  "remoteUrl": "https://svn.example.com/project-a",
  "localPath": "/Users/ww/work/project-a",
  "svnPath": "/opt/homebrew/bin/svn",
  "credentialId": "cred-1",
  "legacyTls": true,
  "opensslConfigPath": "/Users/ww/openssl-legacy-svn.cnf",
  "trustServerCertFailures": true,
  "lastOpenedAt": "2026-07-03T00:00:00Z"
}
```

账号配置单独保存：

```json
{
  "id": "cred-1",
  "name": "公司 SVN",
  "matchUrl": "https://svn.example.com",
  "username": "user",
  "password": "encrypted-or-local-saved",
  "createdAt": "2026-07-03T00:00:00Z",
  "updatedAt": "2026-07-03T00:00:00Z"
}
```

如果 V1 使用 SQLite，建议至少两张表：

```sql
repositories(id, name, remote_url, local_path, svn_path, credential_id, legacy_tls, openssl_config_path, trust_server_cert_failures, last_opened_at)
credentials(id, name, match_url, username, password, created_at, updated_at)
```

仓库列表 UI 显示：

- 仓库名
- 本地路径
- 远程 URL
- 当前分支/URL 信息
- 最后更新时间
- 是否开启旧 TLS 兼容
- 是否有未提交变更
- 是否存在冲突

## 8. 主要页面设计

### 8.1 启动依赖检测页

显示：

- SVN 是否存在
- SVN 路径
- SVN 版本
- Homebrew 是否存在
- VSCode 是否存在
- 旧 TLS 配置是否存在

操作：

- 重新检测
- 手动选择 SVN 路径
- 一键安装 SVN
- 打开 Homebrew 安装说明

### 8.2 仓库列表页

操作：

- 添加已有工作副本
- 检出新仓库
- 删除仓库记录
- 打开本地目录
- 打开 VSCode
- 仓库设置

### 8.3 工作副本页面

布局建议：

```text
左侧：仓库列表
中间：文件树 / 变更列表
右侧：详情、diff、日志、冲突信息
底部：命令输出 / 操作日志
```

常用操作：

- 刷新状态
- 更新
- 提交
- 删除
- 还原
- 添加未版本控制文件
- 清理 cleanup
- 查看日志

### 8.4 提交面板

功能：

- 显示变更文件列表
- 支持勾选要提交的文件
- 显示文件状态：新增、修改、删除、冲突、未版本控制
- 填写提交备注
- 提交前检查是否有冲突
- 提交后显示新 revision

提交建议使用临时 targets 文件和 message 文件：

```bash
svn commit --targets "$TARGETS_FILE" -F "$MESSAGE_FILE"
```

不要把提交备注直接拼在命令行里，避免引号和换行问题。

### 8.5 冲突面板

冲突文件点击后显示：

- 文件路径
- 冲突类型：文本冲突、属性冲突、树冲突
- SVN 原始冲突说明
- 操作按钮：
  - 使用本地版本
  - 使用远程版本
  - 用 VSCode 对比
  - 手工处理完成
  - 打开所在目录
  - 查看原始 SVN 输出

映射关系：

```text
使用本地版本 -> svn resolve --accept mine-full PATH
使用远程版本 -> svn resolve --accept theirs-full PATH
手工处理完成 -> svn resolve --accept working PATH
```

注意文案：

- UI 可以写“本地版本/远程版本”
- 内部不要用“新版/旧版”作为唯一概念，因为树冲突不一定能用新旧解释

## 9. 关键 SVN 命令

### 9.1 检查仓库连接

```bash
svn info "$URL" \
  --non-interactive \
  --no-auth-cache \
  --username "$USERNAME" \
  --password-from-stdin \
  --config-dir "$APP_SVN_CONFIG_DIR"
```

连接流程：

1. 先用普通模式尝试
2. 如果失败并识别为 TLS/证书问题，自动用旧 TLS 模式重试
3. 如果旧 TLS 模式成功，保存 `legacyTls=true`
4. 如果仍失败，显示错误详情

### 9.2 检出

```bash
svn checkout "$URL" "$TARGET_DIR" \
  --non-interactive \
  --no-auth-cache \
  --username "$USERNAME" \
  --password-from-stdin \
  --config-dir "$APP_SVN_CONFIG_DIR"
```

### 9.3 状态

优先使用 XML：

```bash
svn status "$LOCAL_PATH" --xml
```

需要检查远端是否有更新时：

```bash
svn status "$LOCAL_PATH" --xml --show-updates
```

### 9.4 更新

```bash
svn update "$PATH" \
  --non-interactive \
  --no-auth-cache \
  --username "$USERNAME" \
  --password-from-stdin \
  --config-dir "$APP_SVN_CONFIG_DIR" \
  --accept postpone
```

更新时建议默认 `--accept postpone`，不要自动覆盖冲突。

### 9.5 提交

```bash
svn commit \
  --targets "$TARGETS_FILE" \
  -F "$MESSAGE_FILE" \
  --non-interactive \
  --no-auth-cache \
  --username "$USERNAME" \
  --password-from-stdin \
  --config-dir "$APP_SVN_CONFIG_DIR"
```

### 9.6 删除

工作副本内删除：

```bash
svn delete "$PATH"
```

之后进入待提交状态，由用户统一提交。

V1 不建议直接做：

```bash
svn delete "$URL" -m "message"
```

原因是远程直接删除风险更高，不利于图形界面预览。

### 9.7 还原

```bash
svn revert "$PATH"
```

目录还原需要用户确认是否递归：

```bash
svn revert "$PATH" --depth infinity
```

### 9.8 清理

```bash
svn cleanup "$LOCAL_PATH"
```

当出现 locked、previous operation has not finished 等错误时，UI 应引导用户执行 cleanup。

### 9.9 日志

```bash
svn log "$PATH" --xml --limit 50
```

V1 可以先做基础日志列表，不必做复杂图谱。

### 9.10 VSCode 对比

优先调用：

```bash
/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code --diff "$LEFT" "$RIGHT"
```

如果不存在，再尝试：

```bash
code --diff "$LEFT" "$RIGHT"
```

如果仍不存在，提示用户安装 VSCode 或启用 VSCode shell command。

## 10. 自动旧 TLS 尝试

登录时不需要让用户选择 SVN 协议版本。

用户只需要输入完整 URL：

```text
https://...
http://...
svn://...
svn+ssh://...
file://...
```

自动尝试流程：

```text
用户输入 URL、账号、密码
  -> 普通 svn info
    -> 成功：保存普通模式
    -> 失败：判断是否 TLS/证书错误
      -> 是：带 OPENSSL_CONF 重试
        -> 成功：保存 legacyTls=true
        -> 失败：显示错误
      -> 否：显示错误
```

TLS/证书错误关键词可先覆盖：

```text
SSL
TLS
handshake failure
unsupported protocol
protocol version
certificate verify failed
unknown ca
certificate expired
certificate
```

## 11. 错误处理

错误要分层展示：

- 用户友好提示
- 原始 SVN 输出
- 脱敏后的完整命令
- 可执行建议

常见错误分类：

```text
SVN_NOT_FOUND
BREW_NOT_FOUND
AUTH_FAILED
CERT_FAILED
TLS_FAILED
NETWORK_FAILED
WORKING_COPY_LOCKED
CONFLICT_EXISTS
NOT_WORKING_COPY
OUT_OF_DATE
PATH_NOT_FOUND
PERMISSION_DENIED
UNKNOWN
```

示例：

```text
认证失败：请检查账号或密码。

原始错误：
svn: E170001: Authentication failed
```

## 12. 日志与脱敏

操作日志应记录：

- 操作类型
- 仓库 ID
- 执行时间
- 退出码
- stdout
- stderr
- 脱敏后的命令

必须脱敏：

- 密码
- token
- URL 中可能带的账号密码
- 临时认证文件路径中的敏感片段

因为密码走 stdin，正常不会出现在命令参数里，但日志层仍然要做防御。

## 13. 任务与取消

以下命令可能耗时，需要作为后台任务：

- checkout
- update
- commit
- log
- status --show-updates
- cleanup

任务模型：

```json
{
  "id": "uuid",
  "type": "update",
  "repositoryId": "uuid",
  "status": "running",
  "startedAt": "2026-07-03T00:00:00Z",
  "finishedAt": null,
  "exitCode": null
}
```

取消任务时终止子进程。UI 需要提示：SVN 操作被中断后，工作副本可能需要 cleanup。

## 14. V1 推荐迭代计划

### 第 1 阶段：基础骨架

- SVN/Homebrew/VSCode 检测
- App 专用 SVN config-dir 初始化
- 仓库配置存储
- 统一命令执行器
- 日志脱敏

### 第 2 阶段：仓库连接

- 添加已有工作副本
- 检出新仓库
- 账号密码保存
- 普通模式和旧 TLS 模式自动尝试
- 连接失败错误分类

### 第 3 阶段：日常操作

- 文件状态列表
- 更新
- 添加
- 删除
- 还原
- 提交备注和选择文件提交
- cleanup

### 第 4 阶段：冲突处理

- 冲突检测
- 冲突文件详情
- VSCode 对比
- 使用本地版本
- 使用远程版本
- 手工处理完成

### 第 5 阶段：体验完善

- 操作历史
- 日志列表
- 常见错误引导
- 任务取消
- 设置页
- 手动选择 SVN 和 VSCode 路径

## 15. 预计工期

按自用工具、范围克制估算：

```text
基础可用版：2-3 周
比较顺手版：3-5 周
```

如果后续增加 Finder 集成、内置 SVN、复杂冲突合并、状态 badge，工期需要另算。

## 16. 最大风险

### 16.1 密码存储

用户要求不让 SVN 写 Keychain，因此 App 需要自己承担密码存储责任。V1 可接受简单实现，但必须保证不进入命令参数和日志。

### 16.2 旧 TLS 兼容

当前 `OPENSSL_CONF` 方案可行，但只保证对当前 Homebrew SVN 和当前系统环境有效。如果未来 Homebrew 更新 OpenSSL/serf 行为，可能需要重新验证。

### 16.3 冲突类型复杂

文本冲突比较好处理，树冲突会复杂。V1 可以先展示原始说明，并提供保守操作，不强行自动解决所有树冲突。

### 16.4 GUI App 环境和终端环境不同

macOS GUI App 启动时不一定有 shell PATH、alias、环境变量。因此必须使用绝对路径和显式环境变量，不依赖用户 shell 配置。

## 17. V1 成功标准

满足以下场景即可认为 V1 达标：

1. 用户首次打开 App，能检测 SVN 和 VSCode。
2. 没有 SVN 但有 Homebrew 时，能一键安装 `subversion`。
3. 能添加已有 SVN 工作副本。
4. 能输入 URL、账号、密码检出仓库。
5. 遇到旧 TLS 仓库时，能自动切换 legacy 模式。
6. 能看到文件修改、新增、删除、冲突状态。
7. 能更新工作副本。
8. 能选择文件并填写备注提交。
9. 能删除文件并提交删除。
10. 遇到冲突时能明确提示。
11. 能用 VSCode 打开对比。
12. 能选择使用本地版本、远程版本或手工处理完成。
13. SVN 不把密码写入 macOS Keychain。
14. 失败时能看到脱敏后的原始 SVN 输出。
