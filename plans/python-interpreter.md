# Plan: Python Interpreter Tool for Research Agent

> Source PRD: [GitHub Issue #4](https://github.com/vinayakchuni/aiApp/issues/4)

## Architectural decisions

Durable decisions that apply across all phases:

- **Sandbox**: Each research session with data files gets a Docker container running a Jupyter kernel (IPython). The container is created at pipeline start and destroyed on completion/failure. All data file parsing happens inside the container — the server never parses CSV/XLSX contents.
- **Docker image**: A pre-built image (`aiapp-sandbox`) containing Python 3.11+, pandas, numpy, matplotlib, seaborn, scikit-learn, statsmodels, scipy, openpyxl, ipykernel, jupyter_client. Built at deploy time, not per-request.
- **Docker security**: Every container runs with `--network=none`, `--read-only`, `--memory=256m`, `--cpus=0.5`, `--pids-limit=50`, `--security-opt=no-new-privileges`, tmpfs for `/tmp` and kernel working dir. Uploaded files copied in via `docker cp` to a read-only directory.
- **Communication**: Server communicates with the Jupyter kernel inside the container via Jupyter messaging protocol (ZeroMQ through jupyter_client) or Jupyter Server REST API on a localhost-only mapped port.
- **File types**: CSV (`text/csv`) and XLSX (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`) added alongside existing PDF, DOCX, TXT.
- **Limits**: 5 files per conversation, 10MB per file, 100K row cap (enforced in sandbox), 15 code cells per research, 30s timeout per cell, 3 retries per failed cell.
- **Import whitelist**: pandas, numpy, openpyxl, csv, json, re, math, datetime, collections, itertools, functools, matplotlib, seaborn, sklearn, statsmodels, scipy, os.path, io, warnings, typing. Everything else blocked.
- **Code review**: A separate LLM call validates each code cell against the whitelist and checks for disallowed patterns before execution.
- **Output capture**: Text/tables from stdout + cell output. Charts as base64 PNG via Jupyter's display mechanism. Both embedded in the research report and PDF.
- **Research metadata**: `research_final` message metadata extended with a `codeExecutions` array (cell code, output, images, duration, retry count).
- **Tracing**: New `code-execution` spans added using the existing Langfuse tracing infrastructure (`trace.startSpan()` / `span.startGeneration()` pattern already used by searching, drafting, critiquing phases). No new tracing plumbing needed.
- **SSE progress events**: New `executing_code` stage added to `ResearchProgressStage` union, with cell count and output preview in the progress payload.

---

## Phase 1: Docker Sandbox Service

**User stories**: 16, 17, 18

### What to build

Build the Dockerfile and a sandbox service that manages container lifecycle and code execution. The Dockerfile installs Python 3.11+ with all whitelisted libraries and Jupyter kernel components. The sandbox service exposes a simple interface: `start(files)` to spin up a container with data files copied in, `execute(code)` to send a code cell to the Jupyter kernel and return structured output (stdout, stderr, display images), and `stop()` to tear down the container. All Docker security flags are applied at container creation. Each cell execution enforces the 30-second timeout by interrupting the kernel. End-to-end verifiable: call `start()`, `execute('print(1+1)')`, assert stdout contains `2`, call `stop()`.

### Acceptance criteria

- [ ] Dockerfile builds successfully with all whitelisted libraries available for import
- [ ] Container starts with all security flags (no network, read-only FS, memory/CPU/PID limits, no-new-privileges)
- [ ] Files can be copied into the container and read by Python code inside it
- [ ] Code cells execute and return structured output (stdout, stderr, base64 images)
- [ ] Cells exceeding 30 seconds are interrupted and return a timeout error
- [ ] Container is fully removed after `stop()` — no leaked containers
- [ ] Integration test: execute a pandas operation on a small CSV, get correct output

---

## Phase 2: CSV/XLSX Upload Support

**User stories**: 1, 2, 3, 15

### What to build

Extend the file upload pipeline to accept CSV and XLSX files. Add the new MIME types and extensions to the supported types. Increase the per-conversation file limit to 5 and the file size limit to 10MB. Since data files are parsed exclusively inside the Docker sandbox (not on the server), store a lightweight placeholder as `extractedText` (e.g., "Data file — analysis will run in sandbox"). When a data file is uploaded to a research conversation, skip the existing LLM summarization step (it can't meaningfully summarize raw tabular data). Update the frontend file upload UI to accept `.csv` and `.xlsx` extensions.

### Acceptance criteria

- [ ] CSV and XLSX files can be uploaded successfully
- [ ] Up to 5 files per conversation allowed
- [ ] Files up to 10MB accepted, larger files rejected
- [ ] Unsupported file types still rejected
- [ ] Data files stored with placeholder extractedText (no server-side parsing of contents)
- [ ] LLM summarization skipped for CSV/XLSX files
- [ ] Frontend file picker accepts .csv and .xlsx

---

## Phase 3: LLM Code Review Gate

**User stories**: 19

### What to build

A code review function that takes a code string and sends it to the LLM with a system prompt containing the import whitelist and disallowed patterns. The LLM returns SAFE or UNSAFE with a reason. If UNSAFE, the original code-generating LLM is asked to regenerate (up to the retry limit). The review checks for: disallowed imports, filesystem writes outside `/tmp`, environment variable access, obfuscated execution (eval/exec/compile on dynamic strings), and attempts to access system information. This is a defense-in-depth layer on top of the Docker sandbox — even if the review misses something, the container prevents damage.

### Acceptance criteria

- [ ] Code with only whitelisted imports passes review
- [ ] Code with disallowed imports (e.g., `import subprocess`) fails review
- [ ] Code using `eval()`, `exec()`, `compile()` on dynamic strings fails review
- [ ] Code accessing `os.environ` or `sys` modules fails review
- [ ] Failed review triggers code regeneration (not immediate execution rejection)
- [ ] Review result is structured (safe/unsafe + reason) for logging

---

## Phase 4: Research Pipeline Integration

**User stories**: 4, 5, 7, 12, 13, 14, 20

### What to build

Wire the sandbox into `runResearchPipeline`. When the conversation has CSV/XLSX files: (1) start the sandbox container before the main pipeline loop, (2) run automatic schema extraction as the first cell (column names, dtypes, row count, first 5 rows, row cap enforcement at 100K), (3) inject the schema preview into the LLM system prompt alongside instructions for using the Python tool, (4) during drafting and revision phases, allow the LLM to emit `EXECUTE_CODE:` blocks which are parsed, reviewed (Phase 3), and sent to the sandbox, (5) capture outputs (text + images) and include them in the research context so subsequent LLM calls can reference the results, (6) track cell execution count against the 15-cell budget, (7) retry failed cells up to 3 times by feeding the error back to the LLM, (8) tear down the container in the `finally` block. The persistent Jupyter kernel means variables and DataFrames survive between cells. Add the `executing_code` stage to `ResearchProgressStage` and emit SSE progress events with cell count.

### Acceptance criteria

- [ ] Sandbox starts automatically when research pipeline runs with data files present
- [ ] Schema extraction runs as the first cell and its output reaches the LLM
- [ ] LLM can generate and execute code cells during drafting and revision
- [ ] Code outputs (text/tables) are included in research context for subsequent LLM calls
- [ ] State persists between cells (DataFrame from cell 1 available in cell 2)
- [ ] Failed cells retry up to 3 times with error feedback to LLM
- [ ] 15-cell budget enforced — no more cells after budget exhausted
- [ ] Sandbox torn down on pipeline completion and on failure
- [ ] SSE progress events emitted for code execution stages
- [ ] Row count capped at 100K during schema extraction

---

## Phase 5: Chart Capture + Report Embedding

**User stories**: 8, 9, 10

### What to build

Capture base64 PNG images from Jupyter display outputs (matplotlib/seaborn figures) and thread them through the report. During pipeline execution, images are stored alongside text outputs in the `codeExecutions` metadata. In the structured report, images are embedded as inline base64 `<img>` tags or markdown images within the detailed analysis section. The PDF export (pdfkit) renders these inline images. The frontend report display renders base64 images inline within the report text. The methodology section shows which cells produced which charts.

### Acceptance criteria

- [ ] Matplotlib/seaborn charts generated inside the sandbox are captured as base64 PNG
- [ ] Images stored in `codeExecutions` metadata on the research_final message
- [ ] Charts appear inline in the structured report HTML/markdown
- [ ] Charts render correctly in the downloadable PDF
- [ ] Frontend displays charts inline within the report view
- [ ] Multiple charts from different cells all captured and displayed

---

## Phase 6: ML/Predictions + Observability

**User stories**: 6, 11, 21

### What to build

Augment the research system prompt with guidance for when and how to use scikit-learn and statsmodels — e.g., regression for trend prediction, classification for categorical outcomes, time-series decomposition for temporal patterns. The LLM should explain its modeling choices in the report text. Add a `code-execution` span to the existing Langfuse trace using the existing `trace.startSpan('code-execution')` API, recording cell code, execution time, success/failure, retry count, and output type per cell. Add a `code-review` generation span under each code-execution span for the LLM safety review call. Expose code cells and their outputs in the methodology section of the report so users can see exactly what analysis was performed.

### Acceptance criteria

- [ ] System prompt includes guidance for predictive modeling with sklearn/statsmodels
- [ ] LLM generates and executes ML code (regression, classification) when appropriate for the data
- [ ] Each code cell execution creates a Langfuse `code-execution` span with metadata (code, duration, success, retries, output type)
- [ ] LLM code review calls appear as `code-review` generation spans nested under the code-execution span
- [ ] Methodology section of the report lists all executed code cells and their outputs
- [ ] Cell budget usage (e.g., 7/15 cells used) reported in SSE progress events
