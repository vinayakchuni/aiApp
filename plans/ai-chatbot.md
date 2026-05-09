# Plan: AI Chatbot with Multi-Provider Support and File Upload

> Source PRD: [GitHub Issue #1](https://github.com/vinayakchuni/aiApp/issues/1)

## Architectural decisions

Durable decisions that apply across all phases:

- **Routes**:
  - `POST /api/conversations` — Create conversation
  - `GET /api/conversations` — List user's conversations
  - `GET /api/conversations/:id` — Get conversation with messages
  - `PATCH /api/conversations/:id` — Rename conversation
  - `DELETE /api/conversations/:id` — Delete conversation (cascades to messages + files)
  - `POST /api/conversations/:id/messages` — Send message, receive AI response (SSE or JSON)
  - `POST /api/conversations/:id/files` — Upload file
  - `DELETE /api/conversations/:id/files/:fileId` — Remove file
  - `GET /api/users/settings` — Get user settings
  - `PATCH /api/users/settings` — Update user settings

- **Schema** (Prisma/PostgreSQL, extends existing schema):
  - **Conversation**: `id` (uuid), `userId` (FK → User), `title` (string), `createdAt`, `updatedAt`. Cascade delete to messages and files.
  - **Message**: `id` (uuid), `conversationId` (FK → Conversation), `role` (enum: user/assistant/system), `content` (text), `createdAt`. Indexed on `conversationId` + `createdAt`.
  - **File**: `id` (uuid), `conversationId` (FK → Conversation), `originalName`, `mimeType`, `size` (int), `extractedText` (text), `storagePath`, `createdAt`.
  - **User extension**: add `preferredModel` (string, default `"openai:gpt-4o-mini"`), `streamingEnabled` (boolean, default `true`) fields.

- **Auth**: All chat/settings endpoints use existing `requireAuth` middleware + `csrfProtection` on mutations. Conversations are scoped to the authenticated user — every query filters by `userId`.

- **AI provider**: Vercel AI SDK (`ai` npm package) with provider packages `@ai-sdk/openai`, `@ai-sdk/anthropic`, `ollama-ai-provider`. Model identifier format: `"provider:model"` (e.g., `"openai:gpt-4o-mini"`).

- **Streaming**: SSE for token-by-token streaming. The `POST /api/conversations/:id/messages` endpoint checks a `stream` query param or user setting to decide between `streamText()` (SSE response) and `generateText()` (JSON response).

- **Context assembly**: Standalone service that builds the message array sent to the LLM. Order: system prompt → file content messages (with `[Uploaded file: name]` delimiters) → conversation history (chronological) → new user message. This service is the primary extension point for future agent/tool-use features.

- **File storage**: Raw files stored on local disk (configurable `UPLOAD_DIR` env var). Extracted text stored in the `File.extractedText` DB column. Text extraction via `pdf-parse` (PDF), `mammoth` (Word/docx), plain `fs.readFile` (.txt).

- **Configurable limits** (env vars with defaults):
  - `MAX_FILES_PER_CONVERSATION` = 2
  - `MAX_FILE_SIZE_MB` = 5
  - `MAX_MESSAGES_PER_CONVERSATION` = 100
  - `SUPPORTED_FILE_TYPES` = pdf,docx,txt

---

## Phase 1: Conversation CRUD + Basic Chat UI

**User stories**: 1, 4, 5, 8

### What to build

Add `Conversation` and `Message` models to the Prisma schema and create a Prisma migration. Build API endpoints for creating a conversation, listing the authenticated user's conversations, fetching a single conversation with its messages, and sending a message. In this phase, the "send message" endpoint simply echoes the user's message back as the assistant response (no AI yet) — the goal is to prove the full vertical slice works.

On the frontend, replace the current home page with a two-panel chat layout: a sidebar showing a flat chronological list of conversations, and a main area displaying the selected conversation's messages with an input box. Clicking a conversation in the sidebar loads its messages. Clicking "New conversation" creates one via the API. Sending a message posts to the API, saves both the user message and the echo response, and displays them.

Write integration tests for all four conversation API endpoints and unit tests for any conversation service logic.

### Acceptance criteria

- [ ] Prisma migration adds `Conversation` and `Message` tables with proper relations and indexes
- [ ] `POST /api/conversations` creates a conversation for the authenticated user and returns it
- [ ] `GET /api/conversations` returns the user's conversations ordered by most recent, scoped to the authenticated user only
- [ ] `GET /api/conversations/:id` returns the conversation with its messages, returns 404 for conversations belonging to other users
- [ ] `POST /api/conversations/:id/messages` accepts a `content` field, saves the user message, saves an echo assistant message, returns both
- [ ] Frontend displays a sidebar with conversation list and a main chat area
- [ ] User can create a new conversation, select it, send messages, and see the echo response
- [ ] All endpoints require authentication (401 without session) and CSRF protection on mutations
- [ ] Integration tests cover all endpoints including auth enforcement and 404 for wrong user
- [ ] Existing auth tests continue to pass

---

## Phase 2: AI Integration + SSE Streaming

**User stories**: 2, 15, 16

### What to build

Install the Vercel AI SDK (`ai`) and the OpenAI provider (`@ai-sdk/openai`). Build a context assembly service that takes a conversation (with its messages and files) and produces the message array for the LLM: system prompt first, then file content (if any — wired in Phase 5), then conversation history in chronological order. This service should be a standalone, testable module.

Replace the echo response in the message endpoint with a real AI call. When streaming is requested, use `streamText()` and pipe the result as an SSE response (`text/event-stream`). The assistant's complete message is saved to the database after the stream finishes. When streaming is not requested, use `generateText()` and return a JSON response.

On the frontend, consume the SSE stream and render tokens as they arrive. Show a loading/typing indicator while the AI is generating.

Default model: `gpt-4o-mini`. Hardcoded for now — user-configurable model selection comes in Phase 4.

Write unit tests for the context assembly service and integration tests for the message endpoint (mock the AI SDK to avoid real API calls in tests).

### Acceptance criteria

- [ ] Vercel AI SDK and OpenAI provider are installed and configured
- [ ] Context assembly service builds the correct message array from a conversation's messages (unit tested)
- [ ] `POST /api/conversations/:id/messages` calls `streamText()` and returns an SSE stream with token-by-token AI responses
- [ ] `POST /api/conversations/:id/messages?stream=false` calls `generateText()` and returns a JSON response
- [ ] The assistant's complete response is persisted as a Message record after generation completes
- [ ] Frontend renders streaming tokens incrementally as they arrive
- [ ] A typing/loading indicator is visible while the AI is generating
- [ ] The AI response uses conversational context (previous messages in the conversation are included)
- [ ] Unit tests for context assembly cover: empty conversation, conversation with history, system prompt inclusion
- [ ] Integration tests for the message endpoint verify SSE headers, message persistence, and error cases (mocked AI SDK)

---

## Phase 3: Conversation Management

**User stories**: 6, 7

### What to build

Add rename and delete functionality for conversations. The `PATCH /api/conversations/:id` endpoint accepts a `title` field and updates the conversation. The `DELETE /api/conversations/:id` endpoint removes the conversation and cascades to its messages and files.

Auto-generate a conversation title: when the first user message is sent in a conversation that still has the default title, automatically set the title to a truncated version of the first message (e.g., first 50 characters). This keeps the sidebar useful without requiring manual renaming.

On the frontend, add rename and delete actions to each conversation in the sidebar. Rename should be inline-editable (click title to edit). Delete should show a confirmation. After deleting the active conversation, redirect to a "no conversation selected" state or create a new one.

Write integration tests for rename and delete endpoints, including ownership checks.

### Acceptance criteria

- [ ] `PATCH /api/conversations/:id` updates the title, returns 404 for other users' conversations
- [ ] `DELETE /api/conversations/:id` removes the conversation and all associated messages, returns 404 for other users' conversations
- [ ] Conversation title is auto-generated from the first user message (truncated to ~50 chars) when the title is still the default
- [ ] Sidebar shows inline rename (click-to-edit) and delete (with confirmation dialog) for each conversation
- [ ] Deleting the currently active conversation navigates to a clean state
- [ ] Integration tests cover rename, delete, ownership enforcement, and cascade deletion

---

## Phase 4: User Settings + Model Configuration

**User stories**: 3, 13, 14

### What to build

Extend the User model with `preferredModel` (string, default `"openai:gpt-4o-mini"`) and `streamingEnabled` (boolean, default `true`). Create a Prisma migration. Build `GET /api/users/settings` and `PATCH /api/users/settings` endpoints.

Install the Anthropic provider (`@ai-sdk/anthropic`) and the Ollama provider (`ollama-ai-provider`). Build a model registry service that maps `"provider:model"` identifiers to AI SDK provider instances. Validate that the user's selected model is in the registry before making AI calls.

On the frontend, add a settings UI (modal or page) where users can select their preferred model from a dropdown and toggle streaming on/off. The message endpoint should read the user's settings to determine which model and mode to use, with per-request overrides possible via query params.

Write unit tests for the model registry and integration tests for the settings endpoints.

### Acceptance criteria

- [ ] Prisma migration adds `preferredModel` and `streamingEnabled` fields to the User model
- [ ] `GET /api/users/settings` returns the user's model preference and streaming toggle
- [ ] `PATCH /api/users/settings` updates preferences, validates the model identifier against the registry
- [ ] Model registry maps identifiers to AI SDK providers for OpenAI, Anthropic, and Ollama
- [ ] The message endpoint uses the user's preferred model and streaming setting
- [ ] Frontend settings UI allows model selection from a dropdown and streaming toggle
- [ ] The current model is visible somewhere in the chat UI (e.g., header or settings indicator)
- [ ] Invalid model identifiers are rejected with a clear error message
- [ ] Integration tests cover settings CRUD and validation
- [ ] Unit tests cover the model registry

---

## Phase 5: File Upload + Context Injection

**User stories**: 9, 10, 11, 12, 22

### What to build

Add the `File` model to the Prisma schema and create a migration. Build the file upload endpoint (`POST /api/conversations/:id/files`) using `multer` or a similar multipart middleware. Validate file type (PDF, DOCX, TXT), file size (max 5MB), and file count per conversation (max 2). Store raw files on disk and extract text server-side: `pdf-parse` for PDFs, `mammoth` for Word documents, `fs.readFile` for plain text. Save extracted text in the `File.extractedText` column.

Build a file deletion endpoint (`DELETE /api/conversations/:id/files/:fileId`) that removes the DB record and the file from disk.

Update the context assembly service to inject file content into the LLM context with clear delimiters (`[Uploaded file: name]` ... `[End of file: name]`), positioned after the system prompt and before conversation history.

On the frontend, add a file upload button next to the message input (click-to-upload). Show attached files as chips with the file name and a remove button. Display file attachment indicators in the conversation view.

Write unit tests for the text extraction service and integration tests for file upload/delete endpoints including validation (wrong type, too large, too many files).

### Acceptance criteria

- [ ] Prisma migration adds the `File` table with proper relations
- [ ] `POST /api/conversations/:id/files` accepts multipart upload, validates type/size/count, extracts text, stores file and metadata
- [ ] `DELETE /api/conversations/:id/files/:fileId` removes the file record and file from disk
- [ ] Text extraction works correctly for PDF, DOCX, and TXT files
- [ ] Context assembly injects file content with clear `[Uploaded file: ...]` / `[End of file: ...]` delimiters
- [ ] Upload rejects files over 5MB with a clear error (422 or 400)
- [ ] Upload rejects when the conversation already has the maximum number of files
- [ ] Upload rejects unsupported file types
- [ ] Frontend shows an upload button, file chips for attached files, and a remove action
- [ ] Unit tests cover text extraction for each file type
- [ ] Integration tests cover upload, delete, and all validation cases

---

## Phase 6: Chat UX Polish

**User stories**: 17, 18, 19, 20, 21, 23

### What to build

Add markdown rendering for AI responses using `react-markdown` with syntax highlighting for code blocks. Implement auto-scroll behavior that follows new tokens as they arrive but stops if the user scrolls up. Add a "stop generating" button that aborts the SSE connection mid-stream and saves the partial response.

Implement error handling throughout the chat UI: display user-friendly messages for rate limits, provider errors (model down, invalid API key), network failures, and file upload rejections. Errors should appear inline in the chat or as toast notifications — not raw error objects.

Enforce the 100-message-per-conversation limit: the backend rejects new messages after 100, and the frontend shows a message prompting the user to start a new conversation.

Make the layout responsive: on mobile viewports, the sidebar collapses into a hamburger menu or slide-out drawer. The chat area fills the full width on mobile.

### Acceptance criteria

- [ ] AI responses render markdown correctly: headings, bold, italic, lists, code blocks with syntax highlighting, links
- [ ] Chat auto-scrolls as new tokens arrive during streaming
- [ ] Auto-scroll pauses when the user manually scrolls up, resumes when they scroll back to the bottom
- [ ] A "stop generating" button appears during streaming and successfully aborts the stream
- [ ] Partial responses from aborted streams are saved and displayed
- [ ] Error messages are user-friendly and displayed inline or as toasts (not raw error objects)
- [ ] The backend returns 400 when a conversation reaches 100 messages, with a clear error message
- [ ] The frontend displays a prompt to start a new conversation when the limit is reached
- [ ] The layout is responsive: sidebar collapses on mobile, chat area is full-width
- [ ] On mobile, a hamburger/menu button toggles the sidebar
