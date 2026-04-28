# AI App — Getting Started

## Key Commands

| Command            | What it does                                        |
| ------------------ | --------------------------------------------------- |
| `pnpm dev`         | Starts both web (3000) and server (4000) concurrently |
| `pnpm build`       | Builds all packages in dependency order             |
| `pnpm typecheck`   | Runs TypeScript checks across all packages          |
| `pnpm lint`        | Lints all packages with ESLint                      |
| `pnpm test`        | Runs Vitest across all packages                     |
| `pnpm format`      | Formats all files with Prettier                     |
| `pnpm format:check`| Checks formatting without writing changes           |

### Running a single app

```bash
pnpm --filter @ai-app/web dev      # Start only the frontend
pnpm --filter @ai-app/server dev   # Start only the backend
pnpm --filter @ai-app/shared build # Build only the shared package
```

---

## Project Structure

```
aiApp/
├── package.json              # Root config — workspaces, shared scripts, Turborepo
├── pnpm-workspace.yaml       # Tells pnpm which folders are workspace packages
├── turbo.json                # Turborepo task pipeline config
├── tsconfig.base.json        # Base TypeScript config inherited by all packages
├── .prettierrc               # Prettier formatting rules
├── .gitignore
│
├── apps/                     # Deployable applications
│   ├── web/                  # Next.js 15 frontend (React 19) — runs on port 3000
│   │   ├── app/
│   │   │   ├── layout.tsx    # Root layout
│   │   │   └── page.tsx      # Home page — calls the server's health endpoint
│   │   ├── next.config.ts
│   │   └── tsconfig.json
│   │
│   └── server/               # Express 5 backend — runs on port 4000
│       ├── src/
│       │   └── index.ts      # Entry point with /api/health endpoint
│       └── tsconfig.json
│
└── packages/                 # Internal shared libraries (not deployed on their own)
    ├── shared/               # @ai-app/shared — types and utilities
    │   └── src/
    │       ├── index.ts      # Re-exports everything
    │       └── types.ts      # ApiResponse<T>, HealthCheck
    │
    └── eslint-config/        # @ai-app/eslint-config — shared lint rules
        ├── base.js           # Base config (used by server + shared)
        └── react.js          # Extends base with React rules (used by web)
```

---

## What Is a Monorepo?

A **monorepo** is a single Git repository that contains multiple projects — in our case, a frontend, a backend, and shared libraries. Instead of maintaining separate repos for each piece, they all live together.

### Why use a monorepo?

1. **Shared code without publishing.** The `@ai-app/shared` package is used by both the frontend and backend. In a monorepo, you just reference it with `"@ai-app/shared": "workspace:*"` in `package.json` — no npm publishing, no versioning headaches. Change a type in `shared/`, and both apps see it immediately.

2. **Atomic changes.** If you rename a field in a shared type, you can update the frontend, backend, and shared package all in one commit. In separate repos, this would require coordinated PRs across multiple repositories.

3. **Consistent tooling.** ESLint, Prettier, TypeScript, and testing are configured once at the root and shared across all packages. No drift between projects.

4. **Simpler local development.** One `pnpm dev` starts everything. No need to clone multiple repos, manage linking, or keep multiple terminals in sync.

### How the tools work together

- **pnpm workspaces** — pnpm reads `pnpm-workspace.yaml` and treats each folder under `apps/` and `packages/` as a separate package. When one package depends on another (e.g., `@ai-app/web` depends on `@ai-app/shared`), pnpm symlinks them together instead of downloading from npm.

- **Turborepo** — Orchestrates tasks across packages. When you run `pnpm build`, Turbo reads `turbo.json` to know that `build` depends on `^build` (meaning: build my dependencies first). So it builds `shared` before `web` and `server`. It also caches results — if `shared` hasn't changed, it skips rebuilding it.

- **TypeScript project references** — Each package has its own `tsconfig.json` that extends the root `tsconfig.base.json`. This gives you consistent compiler settings everywhere while allowing per-package overrides (e.g., the server uses CommonJS modules, while the web app uses ESNext).

### How packages reference each other

In any `package.json`, you add a workspace dependency:

```json
{
  "dependencies": {
    "@ai-app/shared": "workspace:*"
  }
}
```

The `workspace:*` protocol tells pnpm to resolve this from the local workspace, not from npm. Then in your code, you import from it like any normal package:

```ts
import type { ApiResponse, HealthCheck } from '@ai-app/shared';
```

This is how the Express server and the Next.js frontend both share the same `ApiResponse` and `HealthCheck` types — a single source of truth.
