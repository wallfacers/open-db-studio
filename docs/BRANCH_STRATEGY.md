# 分支策略规范 — open-db-studio

本文档定义 open-db-studio 项目的 Git 分支管理策略，所有贡献者必须严格遵守。

---

## 1. 分支定义

| 分支 | 用途 | 允许操作 | 禁止操作 |
|------|------|----------|----------|
| `master` | 生产分支，代表已发布的稳定版本 | 接受来自 `dev` 的 merge commit；打 tag；触发 CI 发版 | 直接 push；fast-forward merge；squash merge；从此拉功能分支 |
| `dev` | 日常开发主干，所有功能分支的起点和汇聚点 | 接受来自 `feat/*`、`fix/*`、`hotfix/*` 的 PR；更新版本号；日常 push | 直接向 `master` push；未经 lint/test 的合并 |
| `feat/*` | 功能分支，用于开发单个新功能 | 从 `dev` 拉出；本地自由 commit；完成后向 `dev` 提 PR | 直接合入 `master`；长期不合并堆积大量变更 |
| `fix/*` | 修复分支，用于修复非紧急 bug | 从 `dev` 拉出；完成后向 `dev` 提 PR | 直接合入 `master` |
| `hotfix/*` | 紧急修复分支，仅用于生产环境紧急缺陷 | 从 `master` 拉出；修复后同时合回 `master` 和 `dev` | 用于普通功能开发；长期存活 |

---

## 2. 分支流程图

### 日常功能开发流程

```
dev ──────────────────────────────────────────────── dev
 │                                                    ▲
 │  git checkout -b feat/my-feature                   │ PR merge (--no-ff)
 ▼                                                    │
feat/my-feature ── commit ── commit ── push ──────────┘
```

### 发版流程（dev → master）

```
dev ── chore: bump version ── push ──┐
                                     │ git merge --no-ff
master ◄─────────────────────────────┘
   │
   └── CI: 构建三平台安装包 → 打 tag vX.Y.Z → 创建 GitHub Release
```

### 完整分支关系图

```
master ────────────────────────────────────────────────► (生产)
  │  ▲                                         ▲
  │  │ merge --no-ff (发版)                    │ merge --no-ff (hotfix)
  │  │                                         │
  │  dev ──────────────────────────────────────┤◄── hotfix/* ──┐
  │   │  ▲          ▲                          │               │
  │   │  │ PR merge │ PR merge                 │               │
  │   ▼  │          │                          │               │
  │  feat/* ──────  fix/* ──────               │               │
  │                                            │               │
  └──────────────── hotfix/* ──────────────────┘               │
                        │ (同步到 dev)                         │
                        └─────────────────────────────────────-┘
```

---

## 3. 严格规则

以下规则为强制执行，违反视为流程事故：

1. **禁止直接向 `master` push 代码。** `master` 只能通过 `git merge --no-ff` 接受来自 `dev`（发版）或 `hotfix/*`（紧急修复）的变更。

2. **禁止从 `master` 拉功能分支。** 唯一例外是 `hotfix/*` 分支（仅限生产紧急缺陷）。

3. **发版前必须在 `dev` 上更新版本号。** 两个文件必须同步修改：
   - `package.json` → `"version": "X.Y.Z"`
   - `src-tauri/tauri.conf.json` → `"version": "X.Y.Z"`
   版本号提交后方可 merge 到 `master`。

4. **`master` 上的每个 commit 必须对应一个 GitHub Release。** 禁止在 `master` 上出现无对应 Release 的 merge commit。

5. **merge 到 `master` 必须使用 `--no-ff`（non-fast-forward merge commit）。** 禁止 squash merge 和 fast-forward merge，以保留完整的合并历史和版本追溯性。

6. **PR 合并到 `dev` 前必须通过本地 lint 和 test。** 提交 PR 前在本地执行：
   ```bash
   npm run lint && npm test
   ```
   CI 检查不通过的 PR 禁止合并。

7. **功能分支应保持短生命周期。** 建议单个 `feat/*` 分支存活不超过 2 周，避免与 `dev` 产生大量冲突。

8. **分支命名必须遵循约定。** 使用 `feat/`、`fix/`、`hotfix/` 前缀，后接简短的英文短语（kebab-case），例如 `feat/sql-ghost-text`、`fix/connection-timeout`。

---

## 4. 发版操作步骤

```bash
# Step 1: 确保 dev 是最新的
git checkout dev && git pull origin dev

# Step 2: 更新版本号（两个文件必须同步）
# 编辑 package.json → "version": "X.Y.Z"
# 编辑 src-tauri/tauri.conf.json → "version": "X.Y.Z"

# Step 3: 提交版本号变更
git add package.json src-tauri/tauri.conf.json
git commit -m "chore: bump version to vX.Y.Z"
git push origin dev

# Step 4: merge dev → master（使用 --no-ff）
git checkout master
git pull origin master
git merge --no-ff dev -m "release: vX.Y.Z"
git push origin master

# CI 自动触发：构建三平台安装包 → 打 tag v{version} → 创建 GitHub Release
```

> **注意：** 发版操作只有 maintainer 有权限执行。普通贡献者只需将功能合入 `dev`，发版由 maintainer 统一协调。

---

## 5. 版本号规则（SemVer）

版本号格式：`MAJOR.MINOR.PATCH`，遵循 [Semantic Versioning 2.0.0](https://semver.org/)。

| 变更类型 | 操作 | 示例 |
|----------|------|------|
| 重大/破坏性变更（API 不兼容、数据库 schema 重构等） | MAJOR +1，MINOR 和 PATCH 归零 | `0.3.1` → `1.0.0` |
| 新功能（向后兼容，如新增数据源支持、新 UI 模块） | MINOR +1，PATCH 归零 | `0.1.0` → `0.2.0` |
| Bug 修复、性能优化、小改动（向后兼容） | PATCH +1 | `0.1.0` → `0.1.1` |

**版本号唯一真相来源：`src-tauri/tauri.conf.json`**，`package.json` 必须与之保持同步。
CI 读取 `tauri.conf.json` 中的版本号自动打 tag，两者不一致时 CI 构建失败。

---

## 6. 日常开发流程

```bash
# Step 1: 从最新的 dev 拉出功能分支
git checkout dev && git pull origin dev
git checkout -b feat/my-feature

# Step 2: 开发、提交
git add <files>
git commit -m "feat: 描述本次变更"

# Step 3: 保持分支与 dev 同步（长期开发时定期执行）
git fetch origin
git rebase origin/dev   # 或 git merge origin/dev，二选一，团队统一即可

# Step 4: 推送并创建 PR 到 dev
git push origin feat/my-feature
# 在 GitHub 上创建 PR: feat/my-feature → dev

# Step 5: PR 合并后删除本地和远程功能分支（清理）
git branch -d feat/my-feature
git push origin --delete feat/my-feature
```

### PR 描述规范

PR 标题格式：`feat: 简短描述` / `fix: 简短描述`（与 commit message 风格一致）

PR body 应包含：
- 变更目的（Why）
- 主要改动点（What）
- 测试方式（How to test）
- 相关 issue 链接（如有）

---

## 7. 紧急修复流程（hotfix）

hotfix 仅用于生产环境（`master`）出现的严重缺陷，必须立即修复且不能等待下次常规发版。

```bash
# Step 1: 从 master 拉 hotfix 分支
git checkout master && git pull origin master
git checkout -b hotfix/critical-bug

# Step 2: 修复问题，提交
git add <files>
git commit -m "fix: 描述紧急修复内容"

# Step 3: 更新版本号（patch +1）
# 编辑 package.json 和 src-tauri/tauri.conf.json
git add package.json src-tauri/tauri.conf.json
git commit -m "chore: bump version to vX.Y.Z (hotfix)"

# Step 4: 合回 master（触发发版）
git checkout master
git merge --no-ff hotfix/critical-bug -m "hotfix: fix critical bug (vX.Y.Z)"
git push origin master

# Step 5: 同步到 dev（防止下次发版时修复丢失）
git checkout dev
git merge --no-ff hotfix/critical-bug -m "hotfix: sync critical bug fix to dev"
git push origin dev

# Step 6: 清理 hotfix 分支
git branch -d hotfix/critical-bug
git push origin --delete hotfix/critical-bug

# CI 自动触发：构建三平台安装包 → 打 tag vX.Y.Z → 创建 GitHub Release
```

> **重要：** hotfix 合入 `master` 后必须立即同步到 `dev`，否则下次从 `dev` 发版时该修复会丢失。

---

## 8. CI/CD 集成说明

| 触发条件 | CI 行为 |
|----------|---------|
| push 到 `master` | 读取 `src-tauri/tauri.conf.json` 中的版本号，构建 Windows/macOS/Linux 三平台安装包，打 tag `v{version}`，创建 GitHub Release 并上传安装包 |
| push 到 `dev` | 执行 lint、test、`cargo check`，验证代码质量 |
| PR 到 `dev` / `master` | 执行 lint、test、`cargo check`，检查不通过则阻止合并 |

**防重复发版机制：** CI 在打 tag 前会检查 tag 是否已存在。若 `v{version}` tag 已存在，CI 跳过构建，并输出警告日志。这意味着同一版本号只能发版一次，需要重新发版必须先升版本号。

详见 `.github/workflows/release.yml`（CI 配置文件）。

---

## 附录：Commit Message 规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

| 前缀 | 场景 |
|------|------|
| `feat:` | 新功能 |
| `fix:` | Bug 修复 |
| `chore:` | 构建、依赖、版本号等维护性变更 |
| `refactor:` | 重构（不改变功能） |
| `docs:` | 文档变更 |
| `test:` | 测试相关 |
| `ci:` | CI/CD 配置变更 |
| `perf:` | 性能优化 |
| `release:` | 发版 merge commit（仅用于 master） |
| `hotfix:` | 紧急修复 merge commit |
