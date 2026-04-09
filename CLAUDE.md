# CLAUDE.md — open-db-studio Agent Context

This file is the primary context entry point for Claude Code. Read this file before starting any task, then consult the relevant sub-documents based on the task type.

## Project Overview

**open-db-studio** is a local-first AI database IDE desktop application, replicating the core features of chat2db.

Core value: Connect to multiple data sources -> Natural language to SQL -> Execute queries -> Visualize results, **all running locally**.

Product positioning: **AI-Native Database Client**

## Tech Stack

| Layer | Technology |
|-------|------------|
| Desktop Framework | Tauri 2.x |
| Frontend | React 18 + TypeScript + Vite |
| State Management | Zustand |
| Routing | React Router v6 |
| Backend | Rust |
| Built-in Database | SQLite (via rusqlite) — stores app configuration |
| External Data Sources | MySQL, PostgreSQL, Oracle (placeholder), SQL Server (placeholder) |
| AI Integration | Rust-layer unified proxy (OpenAI-compatible API) |

## Directory Structure

```
open-db-studio/
├── CLAUDE.md              # This file (agent context entry point)
├── ARCHITECTURE.md        # Detailed system architecture
├── src/                   # React frontend
├── src-tauri/             # Rust backend
│   └── src/
│       ├── commands.rs    # All Tauri invoke command registrations
│       ├── db/            # Built-in SQLite (config storage)
│       ├── datasource/    # Multi-datasource connection management
│       └── llm/           # AI request unified proxy
├── prompts/               # SQL generation/explanation/optimization prompt templates
├── schema/                # Built-in SQLite DDL (init.sql)
└── docs/                  # Documentation system (see navigation below)
```

## Documentation Navigation

| Document | Purpose |
|----------|---------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System architecture, module descriptions, data flow |
| [docs/DESIGN.md](./docs/DESIGN.md) | UI/UX design specifications |
| [docs/FRONTEND.md](./docs/FRONTEND.md) | Frontend development standards and component docs |
| [docs/PLANS.md](./docs/PLANS.md) | Current development plan and roadmap |
| [docs/BRANCH_STRATEGY.md](./docs/BRANCH_STRATEGY.md) | Branch strategy and release process |
| [docs/QUALITY_SCORE.md](./docs/QUALITY_SCORE.md) | Code quality standards |
| [docs/SECURITY.md](./docs/SECURITY.md) | Security policies (API keys, connection credentials) |
| [docs/design-docs/datasource-arch.md](./docs/design-docs/datasource-arch.md) | Multi-datasource architecture design |
| [docs/design-docs/ai-pipeline.md](./docs/design-docs/ai-pipeline.md) | AI SQL generation pipeline |
| [docs/adr/](./docs/adr/) | Architecture Decision Records (ADR) |

## Shell Environment

This project is developed on Windows. Determine the current shell before running commands:

| Shell | Path Format |
|-------|-------------|
| Git Bash / MSYS2 | `/d/project/java/source/open-db-studio/...` or relative paths |
| PowerShell / CMD | `D:\project\java\source\open-db-studio\...` |

In Git Bash, `\` is an escape character — backslashes in `D:\project\...` will be swallowed, causing path errors. Prefer **relative paths** to avoid shell differences.

## Development Commands

```bash
npm run dev              # Frontend only (port 1420)
npm run tauri:dev        # Tauri full-stack dev
npm run tauri:build      # Production build
npx tsc --noEmit         # TypeScript type checking
cd src-tauri && cargo check   # Rust compile check
```

## Frontend-Backend Communication

The frontend calls Rust commands (defined in `src-tauri/src/commands.rs`) via Tauri `invoke()`:

```typescript
import { invoke } from '@tauri-apps/api/core'
await invoke('test_connection', { config: { driver: 'mysql', host: '...', port: 3306, database: '...', username: '...', password: '...' } })
await invoke('execute_query', { connectionId: 1, sql: 'SELECT 1' })
await invoke('ai_generate_sql', { prompt: 'Query first 10 rows from users table', connectionId: 1 })
```

## Key Conventions

- All database operations (built-in SQLite + external data sources) run in the Rust layer; the frontend never accesses databases directly
- All AI requests go through `src-tauri/src/llm/client.rs` unified proxy
- Connection passwords MUST be stored with AES-256 encryption — see [docs/SECURITY.md](./docs/SECURITY.md)
- Timestamps are stored as ISO 8601 strings
- New Rust commands MUST be registered in `generate_handler![]` in `lib.rs`
- After modifying code, check the documentation freshness trigger table in [docs/PLANS.md](./docs/PLANS.md)
- Branch strategy: daily development on `dev` branch, `master` is for releases only — see [docs/BRANCH_STRATEGY.md](./docs/BRANCH_STRATEGY.md)
- Release process: merging `dev` -> `master` triggers CI to auto-build installers for 3 platforms and create a tag — see `.github/workflows/release.yml`

## Working Behavior Rules

### Bug Fixes
- When fixing a bug, proactively inspect related code and fix associated issues together

### Post-Edit Verification
- After every code edit, you **MUST** run type checking (`npx tsc --noEmit`) and Rust compile check (`cd src-tauri && cargo check`)

### Response Style
- Be concise and direct. No filler explanations

### Plan Mode (MANDATORY)
- For multi-step changes that don't qualify as major refactors, you **MUST** use `/plan` (Plan Mode) to align on the approach before writing code

### Brainstorming (MANDATORY)
- For major changes (new modules, architecture adjustments, cross-module refactors), you **MUST** invoke the `brainstorming` skill first

### Testing
- New features **MUST** have corresponding tests. No tests = not done

### Clarify Before Acting
- If requirements, scope, or implementation approach are unclear, you **MUST** ask the user for clarification first. Never guess

## Pre-Task Checklist

1. Read CLAUDE.md (this file)
2. Consult relevant documents based on task type (see Documentation Navigation)
3. Understand existing code in related modules before making changes
4. Follow the quality standards in [docs/QUALITY_SCORE.md](./docs/QUALITY_SCORE.md)
