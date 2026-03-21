# Release Workflow 设计文档

**日期**：2026-03-22
**版本**：v1.0
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

---

## 二、版本号管理

### 单一来源原则

版本号只在以下两个文件维护，**两者必须保持一致**：

```
package.json                  → "version": "x.y.z"
src-tauri/tauri.conf.json     → "version": "x.y.z"
```

### 语义化版本规则（SemVer）

| 变更类型 | 版本号变化 | 示例 |
|---------|-----------|------|
| 重大变更 / 破坏性 API | major +1 | 0.1.0 → 1.0.0 |
| 新功能（向后兼容） | minor +1 | 0.1.0 → 0.2.0 |
| Bug 修复 / 小改动 | patch +1 | 0.1.0 → 0.1.1 |

### 发版操作步骤

```bash
# Step 1：在 dev 分支上修改版本号（两个文件同步）
# Step 2：提交版本号变更
git commit -m "chore: bump version to vX.Y.Z"
# Step 3：merge dev → master（PR 或直接 merge）
# Step 4：CI 自动构建、打 tag、发布 Release
```

---

## 三、GitHub Actions 工作流

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
| `ubuntu-22.04` | Linux | `.deb`, `.AppImage` |
| `macos-latest` | macOS | `.dmg` |
| `windows-latest` | Windows | `.msi`, `.exe` (NSIS) |

### 流水线步骤

```
1. checkout 代码（master 分支）
2. 安装 Node.js 22 + Rust stable
3. 安装平台系统依赖
   - Linux: libwebkit2gtk-4.1-dev, libappindicator3-dev 等
4. npm ci
5. 下载 sidecar：npm run download:sidecar
6. 构建 skills：npm run build:skills
7. tauri build（各平台生成安装包）
8. 读取 src-tauri/tauri.conf.json 中的 version 字段
9. 创建 git tag v{version}（仅 ubuntu runner 执行，避免重复）
10. 创建/更新 GitHub Release，上传三平台安装包
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

当前版本 `0.1.0` 需要执行以下初始化步骤：

1. 创建 `dev` 分支（从当前 `master` 拉出）
2. 在 `master` 上打 tag `v0.1.0`
3. 添加 `.github/workflows/release.yml` 文件
4. 更新 `docs/BRANCH_STRATEGY.md`（分支规范文档）
5. 更新 `CLAUDE.md` 引用分支规范文档

---

## 五、文档规范要求

- 分支规范详细文档：`docs/BRANCH_STRATEGY.md`
- `CLAUDE.md` 文档导航表中必须包含 `docs/BRANCH_STRATEGY.md` 的引用
- 每次修改分支策略需同步更新上述两个文档
