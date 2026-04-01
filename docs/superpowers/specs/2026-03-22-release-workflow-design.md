<!-- STATUS: ✅ 已实现 -->
# Release Workflow 设计文档

**日期**：2026-03-22
**版本**：v1.1
**状态**：已批准

---

## 目标

为 open-db-studio 建立规范的发版流程，包括：

1. Git 分支策略（dev/master 双轨）
2. 语义化版本号管理
3. GitHub Actions 跨平台自动构建（Windows / macOS / Linux）
4. 自动打 tag + 创建 GitHub Release

---

## 一、分支策略

### 分支定义

| 分支 | 用途 | 规则 |
|------|------|------|
| `master` | 生产发布分支 | 只接受来自 `dev` 的 merge，每次 merge = 一次发版 |
| `dev` | 日常开发主干 | 所有功能从此拉出，PR 合回此处 |
| `feat/*` | 功能分支 | 从 `dev` 拉出，完成后 PR 合回 `dev` |
| `fix/*` | 修复分支 | 从 `dev` 拉出，完成后 PR 合回 `dev` |

### 工作流示意

```
master   ──────●──────────────────────────●──────►
               ↑ v0.1.0 merge             ↑ v0.2.0 merge
dev      ──────●──●──●──────────────────●──●──►
               (feature development)
feat/*   从 dev 拉出 → PR → dev
```

### 严格规定

- **禁止**直接向 `master` 提交代码
- **禁止**从 `master` 拉功能分支
- **发版前**必须在 `dev` 上同步更新版本号，再 merge 到 `master`
- `master` 上的每个 commit 都必须对应一个 GitHub Release
- merge 方式：使用 **merge commit**（非 squash、非 fast-forward），保留完整历史
- 是否需要 PR Review：推荐开启，可根据团队规模决定是否强制

---

## 二、版本号管理

### 单一来源原则

版本号的**唯一真相来源**是 `src-tauri/tauri.conf.json`，`package.json` 必须与之保持一致。
CI 在构建时读取 `src-tauri/tauri.conf.json`，并在 CI 步骤中校验两者一致性。

```
src-tauri/tauri.conf.json    → "version": "x.y.z"  ← 唯一真相
package.json                 → "version": "x.y.z"  ← 必须与上方一致
```

若两者不一致，CI 将在版本一致性校验步骤**立即失败**并报错，阻止构建继续。

### 语义化版本规则（SemVer）

| 变更类型 | 版本号变化 | 示例 |
|---------|-----------|------|
| 重大变更 / 破坏性 API | major +1 | 0.1.0 → 1.0.0 |
| 新功能（向后兼容） | minor +1 | 0.1.0 → 0.2.0 |
| Bug 修复 / 小改动 | patch +1 | 0.1.0 → 0.1.1 |

### 发版操作步骤

```bash
# Step 1：在 dev 分支上修改版本号（两个文件必须同步）
#   - src-tauri/tauri.conf.json → "version": "X.Y.Z"
#   - package.json              → "version": "X.Y.Z"

# Step 2：提交版本号变更
git commit -m "chore: bump version to vX.Y.Z"

# Step 3：将 dev merge 到 master（使用 merge commit，不使用 squash）
git checkout master
git merge --no-ff dev -m "release: vX.Y.Z"
git push origin master

# Step 4：CI 自动接管：校验版本一致性 → 构建 → 打 tag → 发布 Release
```

### tag 重复保护

若版本号未更新就 push master，CI 将检测 `v{version}` tag 是否已存在：
- **已存在**：CI **跳过** tag 创建和 Release 发布，输出警告日志，构建成功但不出包
- **不存在**：正常创建 tag 和 Release

---

## 三、GitHub Actions 工作流

### 前置条件：GitHub Secrets 配置

在 GitHub 仓库 Settings → Secrets and variables → Actions 中配置以下 Secrets：

| Secret 名称 | 用途 | 是否必须 |
|------------|------|---------|
| `GITHUB_TOKEN` | Actions 内置，创建 Release（需 `contents: write` 权限） | 内置，无需手动添加 |
| `APPLE_CERTIFICATE` | macOS 代码签名证书（Base64 编码的 .p12 文件） | macOS 构建必须 |
| `APPLE_CERTIFICATE_PASSWORD` | .p12 证书密码 | macOS 构建必须 |
| `APPLE_ID` | Apple Developer 账号邮箱（用于公证） | macOS 公证必须 |
| `APPLE_PASSWORD` | Apple ID 专用密码（App-Specific Password） | macOS 公证必须 |
| `APPLE_TEAM_ID` | Apple Developer Team ID | macOS 公证必须 |
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater 签名私钥（可选，用于自动更新） | 可选 |

> **注意**：macOS 代码签名需要有效的 Apple Developer Program 账号（年费 $99）。未签名的 .dmg 在 macOS 上会被 Gatekeeper 拦截，用户无法安装。

> **sidecar 下载权限**：opencode-cli 从公开 GitHub Release 下载，内置 `GITHUB_TOKEN` 权限足够。若将来迁移到私有仓库，需额外配置具有 `repo` 权限的 Personal Access Token（PAT）并加入 Secrets。

### 触发条件

```yaml
on:
  push:
    branches:
      - master
```

### 构建矩阵（三平台并行）

| Runner | 目标平台 | 产物格式 |
|--------|---------|---------|
| `ubuntu-22.04` | Linux (x86_64) | `.deb`, `.AppImage` |
| `macos-latest` (Apple Silicon) | macOS (ARM) | `.dmg` |
| `macos-13` (Intel) | macOS (x86_64) | `.dmg` |
| `windows-latest` | Windows (x86_64) | `.msi`, `.exe` (NSIS) |

> 初期若无 Apple Developer 账号，可暂时仅构建 Windows + Linux，macOS 构建留待后续。

### 流水线步骤

```
1. checkout 代码（master 分支）
2. 读取 src-tauri/tauri.conf.json 中的 version 字段
3. 校验 package.json 与 tauri.conf.json 版本号一致性（不一致则失败）
4. 检测 v{version} tag 是否已存在
   - 已存在 → 跳过后续构建，输出警告，工作流成功退出
   - 不存在 → 继续
5. 安装 Node.js 22 + Rust stable（含 target triple）
6. 安装平台系统依赖：
   - Linux: libwebkit2gtk-4.1-dev, libappindicator3-dev,
            libgtk-3-dev, librsvg2-dev, patchelf
   - macOS: 无额外依赖（Xcode Command Line Tools 已内置）
   - Windows: 无额外依赖
7. npm ci
8. 下载 sidecar：npm run download:sidecar
   （opencode-cli 从 GitHub Release 下载，CI 使用 GITHUB_TOKEN 认证）
9. 构建 skills：npm run build:skills
   （失败则中断整个工作流，阻止发版）
10. tauri build（各平台生成安装包）
    - macOS：使用 APPLE_CERTIFICATE 签名，完成后执行 notarization 公证
11. 创建 git tag v{version}（仅 ubuntu runner 执行一次，避免重复）
12. 各平台 runner 分别上传产物到同一 GitHub Release
    - 使用 `softprops/action-gh-release` 或 `gh release upload`，指定同一 tag
    - 三平台并行上传，Release 会自动汇聚所有产物
```

### Release 产物命名

| 平台 | 文件示例 |
|------|---------|
| Windows | `open-db-studio_0.1.0_x64-setup.exe` |
| macOS (Apple Silicon) | `open-db-studio_0.1.0_aarch64.dmg` |
| macOS (Intel) | `open-db-studio_0.1.0_x64.dmg` |
| Linux | `open-db-studio_0.1.0_amd64.AppImage` |

---

## 四、初始化操作（v0.1.0）

当前版本 `0.1.0` 需要执行以下初始化步骤（按顺序）：

1. 在当前 `master` 上打 tag `v0.1.0`（标记历史起点）
2. 从 `master` 拉出 `dev` 分支，作为后续开发主干
3. 添加 `.github/workflows/release.yml` 文件（push 到 `dev`，通过 PR 合到 `master`）
4. 新建 `docs/BRANCH_STRATEGY.md`（分支规范文档）
5. 更新 `CLAUDE.md` 文档导航表，引用 `docs/BRANCH_STRATEGY.md`

---

## 五、紧急回滚策略

当某版本发布后发现严重 Bug，执行以下回滚流程：

```bash
# Step 1：在 dev 上 revert 问题 commit
git revert <bad-commit-hash>
git commit -m "revert: revert bad commit"

# Step 2：bump patch 版本号（例如 0.2.0 → 0.2.1）
# Step 3：merge dev → master，触发新一轮构建

# 可选：撤回有问题的 GitHub Release（在 GitHub UI 操作）
# 可选：删除对应 tag（谨慎操作，会影响 Release 关联）
```

> 不推荐 `git reset --hard` 或 `git push --force` 到 master，避免破坏公开 Release 关联。

---

## 六、文档规范要求

- 分支规范详细文档：`docs/BRANCH_STRATEGY.md`
- `CLAUDE.md` 文档导航表中必须包含 `docs/BRANCH_STRATEGY.md` 的引用
- 每次修改分支策略需同步更新上述两个文档
