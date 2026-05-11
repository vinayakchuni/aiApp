# Langfuse Tracing Guide

This guide explains how to set up and use the Langfuse observability tracing built into the research pipeline.

## Quick Start

### 1. Get Langfuse Credentials

Sign up at [cloud.langfuse.com](https://cloud.langfuse.com) (free tier available), create a project, and grab your API keys from **Settings → API Keys**.

### 2. Set Environment Variables

Add these to your `.env` file:

```env
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
# Optional — defaults to https://cloud.langfuse.com
# LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

### 3. Start the Server

No code changes needed. The tracing service initializes lazily on first research request. If the keys are missing, tracing silently degrades to no-ops — the pipeline works exactly the same either way.

### 4. Run a Research Query

Trigger any research through the app. Once it completes, open **[cloud.langfuse.com](https://cloud.langfuse.com)** → your project → **Traces** to see the full breakdown.

---

## What Gets Traced

Every research execution creates **one trace** containing:

| Layer | What | Examples |
|-------|------|----------|
| **Trace** | Entire research run | Topic, user, model, exit reason, total cost |
| **Spans** | Pipeline phases | `searching`, `drafting`, `critiquing`, `fact-checking`, `revising`, `finalizing` |
| **Child Spans** | Sub-operations | `search-query` (one per web search, nested under `searching`) |
| **Generations** | LLM calls | `plan-search-queries`, `draft`, `critique`, `revise`, with full input/output and token counts |
| **Scores** | Critique evaluations | `critique_factual_accuracy`, `critique_completeness`, `critique_source_coverage`, `critique_coherence`, `critique_scope_alignment` (1–5 each, per iteration) |

### Trace Metadata (on finish)

- **Exit reason** — `all_passed`, `converged`, `iterations_exhausted`, `budget_exhausted`, `ai_error`, etc.
- **Cost totals** — `totalInputTokens`, `totalOutputTokens`, `totalCostUsd`, `generationsCount`
- **Fact-check rollup** — `totalClaimsExtracted`, `verifiedClaims`, `unverifiedClaims`, `searchesUsed`
- **Source citation** — list of all sources with `cited: true/false`, plus totals

---

## Viewing Traces in the Dashboard

Once you open your Langfuse project:

- **Traces** — shows all research runs. Filter by tag `research`, user ID, or session (conversation) ID.
- **Click a trace** to see the full span tree with timing, nested generations, token usage, and costs.
- **Sessions** — groups traces by `conversationId`, so you can see all research in a conversation.
- **Scores** — view critique score trends across iterations and research runs.
- **Metrics** — track cost, latency, and token usage over time.

---

## Cost Tracking

Every LLM generation records estimated cost using a built-in pricing table:

| Model | Input (per 1M tokens) | Output (per 1M tokens) |
|-------|----------------------|------------------------|
| `openai:gpt-4o-mini` | $0.15 | $0.60 |
| `openai:gpt-4o` | $2.50 | $10.00 |
| `anthropic:claude-3-5-sonnet-latest` | $3.00 | $15.00 |
| `anthropic:claude-3-5-haiku-latest` | $0.80 | $4.00 |
| `ollama:llama3.1` | $0.00 | $0.00 |

Costs are accumulated across all generations and attached to the trace at finish. Unknown models default to $0.

---

## Pipeline Budget Controls

These environment variables control research limits (and show up in trace metadata):

| Variable | Default | Purpose |
|----------|---------|---------|
| `MAX_RESEARCH_ITERATIONS` | 5 | Max critique → revision rounds |
| `MAX_LLM_CALLS_PER_RESEARCH` | 10 | Max total LLM calls |
| `MAX_SEARCHES_PER_RESEARCH` | 20 | Max web searches |
| `MAX_FACT_CHECK_CLAIMS_PER_ITERATION` | 8 | Max claims fact-checked per round |

When a budget is exhausted, the trace records the corresponding `exitReason`.

---

## Error Handling

- **Tracing never crashes the pipeline.** All Langfuse SDK calls are wrapped in a `safe()` helper that catches errors and logs warnings.
- **Failed spans** are marked with `level: 'ERROR'` and a `statusMessage`.
- **Network issues** with Langfuse degrade gracefully — the research completes normally.
- **Missing credentials** — tracing returns no-op objects; zero overhead.

---

## Key Source Files

| File | Purpose |
|------|---------|
| `apps/server/src/services/tracing.ts` | Core tracing service (all Langfuse SDK calls) |
| `apps/server/src/services/cost.ts` | Cost calculation and pricing table |
| `apps/server/src/services/research.ts` | Pipeline orchestration (creates traces, manages spans) |
| `apps/server/src/services/ai.ts` | LLM integration (threads trace context) |
| `apps/server/src/services/search.ts` | Search instrumentation (child spans per query) |

---

## Self-Hosting Langfuse

If you prefer to self-host instead of using cloud.langfuse.com:

1. Deploy Langfuse via Docker ([docs](https://langfuse.com/docs/deployment/self-host))
2. Set `LANGFUSE_BASE_URL` to your instance URL
3. Use the API keys from your self-hosted instance

Everything else works identically.
