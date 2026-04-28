---
name: do-work-skill
description: Plan, implement, validate, and commit a piece of work end-to-end. Use when user asks to build a feature, fix a bug, or do any implementation task that should be planned, tested, and committed.
---

# Do Work

## Workflow


### 1. Plan
- Read relevant files to understand the current codebase context
- If a plan is not already provided, create one by following these steps:
-If a plan is provided follow the plan
- Reason through the approach: what needs to change, which files are involved, and what order to work in
- Present a brief summary of the plan to the user before writing code

### 2. Implement (Red-Green-Refactor)

Apply the red-green-refactor cycle **only to backend code** (services, db, lib, utils). Frontend code (route components, loaders, actions, UI) should still be implemented when the task requires it, but without the TDD cycle.

For backend work, use a tracer-bullet style — one thin vertical slice at a time. For each vertical slice:

1. **Red** — Write ONE failing test for the next small piece of behavior. Run it to confirm it fails:
   ```
   pnpm run test -- <test-file>
   ```
2. **Green** — Write the minimum code to make that test pass. No more. Run the test again to confirm it's green.
3. **Refactor** — Clean up the code you just wrote (remove duplication, improve names) while keeping the test green. Run the test again.

Repeat this cycle for each behavior. Do NOT write multiple tests at once or implement ahead of tests. One test, one pass, one cleanup — then the next slice.

Follow all project conventions in CLAUDE.md (object params for same-typed args, tests for services, etc.).

### 3. Validate

After all red-green-refactor cycles are complete, run the full suite:

```
pnpm typecheck
pnpm run test
```

If either fails, diagnose and fix the issue, then re-run both until they pass.

### 4. Commit

- Stage all relevant changed files
- Write a descriptive commit message based on the feature/work done
- Format: `<descriptive summary of the change>`
- Append `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`
