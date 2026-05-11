# Plan: Research Agent Observability with Langfuse

> Source PRD: GitHub Issue #3 — "Research Agent Observability with Langfuse"

## Architectural decisions

Durable decisions that apply across all phases:

- **Observability backend**: Langfuse Cloud (free tier, 50k observations/month). No self-hosted infrastructure.
- **SDK**: `langfuse` Node.js SDK, added as a dependency to `apps/server`.
- **Tracing model**: One Langfuse **trace** per research run, identified by conversation ID. Phases are **spans**, LLM calls are **generations**, search queries are **spans** with result metadata.
- **Non-blocking**: All Langfuse calls are fire-and-forget. If Langfuse is unreachable, log a warning and continue — never block the pipeline.
- **Isolation**: All Langfuse SDK usage is confined to a single tracing service module. The rest of the codebase interacts only with this module's interface.
- **Environment variables**: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` (defaults to `https://cloud.langfuse.com`).
- **No frontend changes**: Langfuse cloud dashboard is the monitoring UI.
- **Cost model**: Per-token pricing table mapping model IDs (e.g., `openai:gpt-4o`) to input/output costs in USD.

---

## Phase 1: Tracing foundation + pipeline skeleton

**User stories**: 1, 2, 10, 15, 18

### What to build

Install the Langfuse Node.js SDK and create a tracing service module that wraps all Langfuse SDK calls behind a simple interface. Then instrument `runResearchPipelineImpl()` to create a top-level trace when a research run starts, and wrap each major phase (searching, drafting, critiquing, fact-checking, revising, finalizing) in a named span with start/end timing.

Attach the research topic, clarifying Q&A, model ID, and conversation ID as metadata on the trace. When the pipeline completes, attach the exit reason (all_passed, converged, iterations_exhausted, budget_exhausted, critique_parse_failed). On failure, attach the error message and mark the trace with error status.

All Langfuse calls must be wrapped in try/catch so that tracing failures never crash or slow the pipeline. Flush pending events when the run completes.

### Acceptance criteria

- [ ] `langfuse` SDK is installed in `apps/server`
- [ ] A tracing service module exists that encapsulates all Langfuse SDK calls
- [ ] Every research run creates a trace visible in the Langfuse dashboard
- [ ] Each pipeline phase (searching, drafting, critiquing, fact-checking, revising, finalizing) appears as a named span with correct start/end times
- [ ] Trace metadata includes: topic, clarifying Q&A, model ID, conversation ID, exit reason
- [ ] Failed runs have error details attached and are marked as error status in Langfuse
- [ ] If Langfuse is unreachable or unconfigured, the pipeline still completes successfully with a console warning
- [ ] Pending Langfuse events are flushed at the end of each run

---

## Phase 2: LLM generation tracking + cost estimation

**User stories**: 3, 4

### What to build

Modify the LLM call path so that each call to `generateAssistantText()` can optionally accept a tracing context (parent span). When a tracing context is provided, record the call as a Langfuse **generation** with: model name, prompt tokens, completion tokens, total tokens, and latency.

Build a cost calculator utility that maintains a pricing table mapping model IDs to per-token costs (input and output, in USD). After each generation, compute and attach the estimated cost. At the end of the run, compute and attach the total run cost to the trace.

The cost calculator should be unit tested since it's pure math with no external dependencies.

### Acceptance criteria

- [ ] Every LLM call during a research run appears as a generation in Langfuse with model name, token counts (prompt, completion), and latency
- [ ] Each generation has an estimated USD cost attached
- [ ] The trace has a total estimated run cost (sum of all generations)
- [ ] The pricing table covers all models in the supported models list (gpt-4o, gpt-4o-mini, claude-3-5-sonnet, claude-3-5-haiku, llama3.1)
- [ ] The pricing table is easy to update when model prices change
- [ ] Unit tests exist for the cost calculator covering all supported models and edge cases (zero tokens, unknown model fallback)
- [ ] Generations are correctly nested under their parent phase span

---

## Phase 3: Search query instrumentation

**User stories**: 5, 11, 12, 14

### What to build

Instrument the search service so that each `search(query)` call creates a span under the searching phase. Each span records: the query text, which provider was used (Firecrawl or Brave), whether a fallback occurred, the number of results returned, and the full search results (title, URL, snippet for each result).

At the end of the searching phase, attach metadata to the trace with the total search budget usage (used vs. total), the total number of unique sources found, and whether the minimum source threshold (3) was met.

### Acceptance criteria

- [ ] Each search query appears as a span in Langfuse with query text, provider name, and result count
- [ ] When Firecrawl fails and Brave is used as fallback, the span shows both providers tried
- [ ] Full search results (title, URL, snippet) are stored as metadata on each search span
- [ ] The trace includes total search budget usage (used / total)
- [ ] The trace includes total unique sources found and the minimum threshold
- [ ] Search spans are correctly nested under the searching phase span

---

## Phase 4: Critique scores + iteration tracking

**User stories**: 7, 8, 9, 16

### What to build

After each critique iteration, push the 5 critique dimension scores (factual_accuracy, completeness, source_coverage, coherence, scope_alignment) to Langfuse as formal **scores** on the trace. Each score should include the iteration number so you can see how quality evolved across revisions.

Record the draft similarity score between iterations as span metadata on the revision span, so you can see when the agent is making diminishing revisions (approaching the 0.95 convergence threshold).

At the end of the critique loop, attach the final scores and exit reason to the trace.

### Acceptance criteria

- [ ] After each critique iteration, all 5 dimension scores are pushed to Langfuse as formal scores
- [ ] Scores include the iteration number as metadata so per-iteration quality is visible
- [ ] Final critique scores are attached to the trace
- [ ] Draft similarity between iterations is recorded on the revision span metadata
- [ ] The critique loop exit reason is attached to the trace
- [ ] Scores are filterable/sortable in the Langfuse dashboard

---

## Phase 5: Fact-checking + source attribution

**User stories**: 6, 13, 17

### What to build

Attach fact-check results to the trace after each fact-check round: number of claims extracted, how many were verified, unverified, and not-checked, the number of searches used, and whether the budget was exhausted.

After the final structured report is generated, build a source attribution tracker that cross-references the citation numbers ([1], [2], etc.) in the report against the full list of fetched sources. Attach a `cited: true/false` flag to each source in the trace metadata. Compute and attach the fetch-vs-cited ratio (e.g., "8 of 15 sources cited").

This completes the observability picture — every research run is now fully inspectable in Langfuse from search through final report.

### Acceptance criteria

- [ ] Fact-check results (claims extracted, verified, unverified, not-checked counts) are attached to the trace
- [ ] Fact-check search budget usage is recorded
- [ ] Each fetched source has a `cited: true/false` flag in the trace metadata
- [ ] The trace includes a fetch-vs-cited ratio (e.g., "8/15 sources cited")
- [ ] A completed research run in Langfuse shows the full end-to-end picture: phases with timing, LLM calls with tokens and cost, search queries with full results, critique scores per iteration, fact-check stats, and source attribution
