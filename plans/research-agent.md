# Plan: Research Agent

> Source PRD: GitHub Issue #2 — "Research Agent: Autonomous Multi-LLM Research Pipeline"

## Architectural decisions

Durable decisions that apply across all phases:

- **Routes**: `POST /api/conversations/:id/research` (start), `GET /api/conversations/:id/research/status` (progress), `GET /api/conversations/:id/research/pdf` (download). All protected by `requireAuth` + `csrfProtection`.
- **Schema**: Conversation gains a `mode` enum (`chat | research`) and a `researchStatus` enum (`idle | clarifying | researching | drafting | critiquing | fact_checking | finalizing | complete | failed`). Message gains a `metadata` JSON field for structured data (sources, scores, iteration info, report sections). File gains a `summary` text field for Tier 1 summaries.
- **Key models**: Research state is tracked on the Conversation model. Reports are stored as assistant Messages with structured metadata. No new top-level tables.
- **LLM integration**: All research LLM calls go through the existing `ai` service (`generateText` / `streamText`) and `resolveModel()`. User's `preferredModel` is respected, including Ollama.
- **Search providers**: Firecrawl (primary) with Brave Search (fallback). Abstracted behind a unified search interface. Hard cap of 20 searches per research task enforced at the search service layer.
- **Budget limits**: 20 searches, 10 LLM calls (excludes clarifying questions and file summarization), 5 max iterations. All configurable via environment variables.
- **SSE events**: Research progress uses the same SSE transport as chat streaming. New event types: `research-progress`, `research-complete`, `research-failed`.
- **Error strategy**: Fail fast with clear user-facing message. If search APIs fail and fewer than 3 sources gathered, the research task fails rather than producing low-quality output.
- **Email**: Reuses existing Resend infrastructure. Sends full HTML report + conversation link on completion.
- **PDF**: Generated on-demand from stored markdown via headless rendering (Puppeteer or lightweight alternative). Not persisted to disk.
- **Concurrency**: Single active research task per user, enforced at the service level via in-memory tracking (keyed by `researchId` to support future multi-concurrency without structural changes).

---

## Phase 1: Research Mode Toggle + Clarifying Questions

**User stories**: 1, 2, 3

### What to build

Add a research mode to the existing chat application. When a user toggles research mode on, their next message is treated as a research topic. The backend receives this message, uses the LLM to generate a set of clarifying questions about scope, depth, and focus, and returns them as an assistant message. The user answers the questions in the chat. The agent confirms it has enough information and signals readiness to begin research (actual research execution comes in Phase 2).

This requires a schema migration to add `mode` and `researchStatus` to Conversation, and a `metadata` JSON field to Message. A new research route handles the research-specific message flow. The frontend gets a toggle to switch between chat and research modes, and renders clarifying questions as normal chat messages.

### Acceptance criteria

- [ ] Schema migration adds `mode` (enum: chat/research, default: chat), `researchStatus` (enum with states listed above, default: idle) to Conversation, and `metadata` (JSON, nullable) to Message
- [ ] `POST /api/conversations/:id/research` accepts a research topic, validates the conversation is in research mode, and returns clarifying questions via the LLM
- [ ] Clarifying questions are stored as an assistant message with `metadata` indicating the message type (`clarifying_questions`)
- [ ] User's answers to clarifying questions are sent as normal messages and stored
- [ ] The agent can process the answers and confirm readiness (transitioning `researchStatus` from `clarifying` to `researching`)
- [ ] Frontend has a visible toggle to switch a conversation to research mode
- [ ] Research mode conversations are visually distinct from regular chat conversations (e.g., icon, label, or color)
- [ ] The clarifying questions render as normal chat messages in the conversation
- [ ] Toggling research mode on a conversation with existing chat messages is prevented (research mode must be set on a new or empty conversation)

---

## Phase 2: Web Search + Single Draft Report

**User stories**: 6, 7, 10, 19

### What to build

After clarifying questions are answered, the research pipeline kicks off. The backend search service queries the web using Firecrawl (falling back to Brave Search if Firecrawl fails). It runs multiple search queries derived from the user's topic and clarifying answers, collects sources, and then uses the LLM to write a single draft report from the gathered sources. The draft is stored as an assistant message with source metadata.

Progress updates are streamed to the frontend via SSE so the user sees real-time status ("Searching for: X", "Analyzing 8 sources", "Writing first draft..."). If both search providers fail, the research task fails with a clear error message.

### Acceptance criteria

- [ ] Search service abstraction with `search(query)` and `scrape(url)` methods
- [ ] Firecrawl integration with automatic failover to Brave Search
- [ ] Hard cap of 20 searches enforced via decrementing counter — no searches issued after counter hits 0
- [ ] Search budget tracking (remaining count) accessible to the orchestrator
- [ ] Orchestrator generates 3-5 search queries from the topic + clarifying answers using the LLM
- [ ] Search results (title, URL, snippet, full content where scraped) stored in message metadata
- [ ] LLM generates a draft report from collected sources, stored as an assistant message
- [ ] SSE progress events stream to the frontend: `searching`, `analyzing_sources`, `writing_draft`
- [ ] Progress events include descriptive detail (e.g., the actual search query, number of sources found)
- [ ] Frontend displays a progress indicator that updates in real-time during the research pipeline
- [ ] If both Firecrawl and Brave Search fail, research status transitions to `failed` with a user-facing error message
- [ ] If fewer than 3 sources are gathered, research fails with a clear message rather than producing a low-quality draft
- [ ] Environment variables: `FIRECRAWL_API_KEY`, `BRAVE_SEARCH_API_KEY`, `MAX_SEARCHES_PER_RESEARCH` (default: 20)

---

## Phase 3: Document Context Integration

**User stories**: 4, 5

### What to build

Integrate uploaded files into the research pipeline using a two-tier strategy. When a user uploads files to a research conversation, the document analyzer summarizes each file via the LLM (Tier 1) and stores the summary. During research, the orchestrator provides summaries to the LLM by default. If the agent determines it needs deeper context from a specific file, it can request the full extracted text (Tier 2).

The frontend shows that files are being analyzed with a status indicator, and summaries are visible to the user.

### Acceptance criteria

- [ ] Schema migration adds `summary` (text, nullable) to the File model
- [ ] Document analyzer service: takes a file's extracted text, generates a concise summary via LLM, stores it in the `summary` field
- [ ] Summarization happens automatically when a file is uploaded to a research conversation
- [ ] Summaries are included in the LLM context during search query generation and draft writing (Tier 1)
- [ ] The orchestrator can request full file content for specific files when the LLM indicates it needs more detail (Tier 2)
- [ ] Summarization LLM calls do NOT count against the 10 LLM call budget
- [ ] Frontend shows a "Analyzing document..." status when a file is being summarized
- [ ] File summaries are visible in the UI (e.g., expandable section under the file attachment)
- [ ] Files uploaded to non-research conversations continue to work as before (no summarization, just extraction)

---

## Phase 4: Critique + Iteration Loop

**User stories**: 8, 9, 10

### What to build

After the first draft is generated, a critic LLM evaluates it against five criteria: factual accuracy, completeness, source coverage, coherence, and scope alignment. Each criterion is scored 1-5. If any score is below 4, the LLM revises the draft incorporating the critique. This loop repeats until all scores reach 4/5 or higher, the changes between iterations are minimal (convergence), or the budget limits are hit (max 5 iterations, 10 total LLM calls).

The frontend shows iteration progress ("Revision 2 of 5 — improving source coverage...").

### Acceptance criteria

- [ ] Critic LLM evaluates drafts on 5 criteria (factual accuracy, completeness, source coverage, coherence, scope alignment), each scored 1-5
- [ ] Scores and critique text are stored in message metadata for each iteration
- [ ] Revision loop: if any criterion < 4, the LLM revises the draft using the critique as guidance
- [ ] Convergence detection: if the diff between consecutive revisions is below a threshold, the loop exits early
- [ ] Hard cap of 5 iterations enforced — loop exits regardless of scores after 5 rounds
- [ ] Hard cap of 10 LLM calls enforced across drafting, critiquing, and revising (not counting clarifying questions or file summarization)
- [ ] Environment variables: `MAX_RESEARCH_ITERATIONS` (default: 5), `MAX_LLM_CALLS_PER_RESEARCH` (default: 10)
- [ ] SSE progress events show current iteration and which criteria are being improved
- [ ] Frontend progress indicator displays iteration count and current activity ("Critique round 2 — improving coherence...")
- [ ] Final scores are included in the report metadata and accessible to later phases

---

## Phase 5: Fact Checker

**User stories**: 8, 16

### What to build

Add a fact-checking step to the iteration loop. After the critic scores the draft, a fact-checking phase runs: the LLM identifies specific claims in the draft that need verification, then targeted web searches check those claims. The results (verified, unverified, corrected) feed back into the next revision cycle. The fact checker shares the 20-search budget with the initial research phase.

The frontend displays fact-check annotations — sources show reliability indicators and the report includes verification status.

### Acceptance criteria

- [ ] Fact checker LLM extracts a list of verifiable claims from the current draft
- [ ] Each claim is searched via the search service (using the shared 20-search budget, with ~8 searches reserved for fact-checking)
- [ ] Claims are annotated as verified, unverified, or corrected based on search results
- [ ] Annotated claims feed back into the revision step so the LLM can fix or remove unverified claims
- [ ] Fact-check results (claim text, status, supporting URLs) stored in message metadata
- [ ] Fact-checking searches count against the 20-search hard cap — if the budget is exhausted, remaining claims are noted as "not verified (budget exhausted)"
- [ ] Frontend renders source reliability indicators alongside claims in the report
- [ ] The methodology section of the report includes what was fact-checked and verification results
- [ ] Fact-checking LLM calls count against the 10 LLM call budget

---

## Phase 6: Structured Report + PDF Download

**User stories**: 13, 14, 15, 17, 21

### What to build

Replace the raw draft with a properly structured report. The report generator takes the final revised draft, critique scores, fact-check results, and search metadata, and produces a structured markdown document with five sections: Executive Summary, Key Findings, Detailed Analysis, Sources (with URLs and reliability notes), and Methodology (searches performed, iterations, fact-check results).

Add a PDF generation endpoint that renders the markdown report as a clean, branded PDF. The frontend displays the report with clear section headings and a download button.

### Acceptance criteria

- [ ] Report generator produces structured markdown with sections: Executive Summary, Key Findings, Detailed Analysis, Sources, Methodology
- [ ] Sources section includes URLs, page titles, and reliability notes from fact-checking
- [ ] Methodology section includes: search queries used, number of iterations, quality scores per iteration, fact-check summary
- [ ] Detail level is adjustable — a follow-up message requesting more detail produces an expanded version
- [ ] Structured report sections stored in message metadata as separate fields for frontend rendering
- [ ] `GET /api/conversations/:id/research/pdf` generates and returns a PDF from the stored report
- [ ] PDF has clean, readable formatting with placeholder app branding (logo area, colors, typography)
- [ ] PDF includes all report sections with proper headings, page breaks, and source links
- [ ] Frontend renders the report with distinct section headings, collapsible sections, and visual hierarchy
- [ ] Frontend shows a "Download PDF" button on completed research reports
- [ ] PDF is generated on-demand, not persisted — each download request renders fresh

---

## Phase 7: Email Notification + Completion Flow

**User stories**: 11, 12, 20, 22

### What to build

When a research task completes, send an email notification to the user's registered email address containing the full HTML-formatted report and a link back to the conversation. Implement the single-active-research constraint so users can only run one research task at a time. Enable follow-up questions — after research completes, the user can send messages in the same conversation and the LLM responds with the full research context available.

### Acceptance criteria

- [ ] On research completion, an email is sent to the user's registered email via Resend
- [ ] Email contains the full report rendered as HTML with proper formatting
- [ ] Email includes a clickable link back to the specific conversation in the app
- [ ] Email uses a clean template consistent with existing verification/reset emails
- [ ] Single-active-research enforcement: attempting to start a second research task while one is running returns an error with a clear message
- [ ] Enforcement is at the service level (in-memory or DB query), not at the database constraint level
- [ ] After research completes, the user can send follow-up messages in the same conversation
- [ ] Follow-up messages are answered by the LLM with the full research report and sources in context
- [ ] Frontend shows a "Research complete" indicator when the pipeline finishes
- [ ] If research fails, an appropriate error message is shown in the conversation (not an email)
- [ ] The conversation list in the sidebar shows research status for research conversations (e.g., "Researching...", "Complete")

---

## Phase 8: Model Selection + UI Polish

**User stories**: 18, 10, 1

### What to build

Ensure research mode respects the user's model selection (including Ollama). Polish the frontend: refine the progress indicator with animations and descriptive stage messages, add visual differentiation for research conversations throughout the app (sidebar, chat area, message styling), and ensure the overall research UX feels cohesive and polished.

### Acceptance criteria

- [ ] Research pipeline uses the user's `preferredModel` for all LLM calls
- [ ] Ollama models work correctly for the full research pipeline (search, draft, critique, fact-check, report generation)
- [ ] Model selection in settings works for research mode — changing the model applies to the next research task
- [ ] Progress indicator has smooth animations/transitions between stages
- [ ] Progress messages are descriptive (e.g., "Searching for: climate change impacts on agriculture" not just "Searching...")
- [ ] Research conversations have distinct visual treatment in the sidebar (icon or label)
- [ ] Research mode toggle is intuitive and clearly communicates what it does
- [ ] The chat input area adapts to research mode (e.g., placeholder text changes to "Enter your research topic...")
- [ ] Error states are styled consistently with the rest of the app
- [ ] Mobile responsiveness is maintained for all research UI elements
- [ ] Loading and empty states are handled gracefully throughout the research flow
