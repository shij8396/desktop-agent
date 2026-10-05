# Architecture

## System overview

```text
Tauri desktop window
  ├─ conversation and settings UI
  ├─ speech input/output
  └─ controlled desktop-command bridge
          │
          ▼
Hono loopback service (127.0.0.1:3000 + per-launch token)
  ├─ LangGraph task workflow (context → agent → verify → finalize)
  ├─ LangChain v1 createAgent (ReAct tool executor)
  ├─ LangChain Prompt Templates and Runnable chains
  ├─ LangChain VectorStore / Retriever RAG
  ├─ SQLite LangGraph checkpoints + durable app history
  ├─ Deep Agents route for explicitly complex work
  ├─ opt-in LangSmith tracing and regression dataset
  ├─ model-provider routing
  └─ policy-gated LangChain tools and middleware
          │
          ▼
Rust adapters
  ├─ filesystem and clipboard
  ├─ system and process metrics
  ├─ window and input control
  └─ screen capture and monitoring
```

## Desktop files

| File | Purpose |
|---|---|
| `desktop/pet.html` | Single desktop-assistant document; the filename is retained for runtime compatibility. |
| `desktop/assistant.css` | Resizable conversation and settings layout. |
| `desktop/assistant-window.js` | Chat streaming, settings, approvals, voice hooks, and desktop-tool bridge. |
| `desktop/shared.js` | Tauri helpers, authenticated API client, and SSE parsing. |
| `desktop/voice.js` | Speech recognition and speech synthesis. |

## Request flow

```text
User request
  → POST /api/agent/execute
  → LangGraph creates a task activity record with no speculative tool steps
  → small evidence policy pre-reads date/web/KB facts when the request explicitly needs them
  → LangChain createAgent executes the current task
  → dynamic ReAct tool selection
  → LangChain tool policy check / retry / call limit
  → Retriever, local tool, or Tauri tool execution
  → ToolMessage observation
  → result verification and durable completion state
  → streamed answer
```

## LangChain building blocks

- **Model:** `ChatOpenAI` with OpenAI-compatible endpoints for OpenAI, DeepSeek, and Ollama.
- **Prompts:** `ChatPromptTemplate` renders the agent and summary prompts.
- **Chains:** `RunnableSequence` powers retrieval formatting and conversation summarization.
- **Retrieval:** a persistent local implementation of LangChain `VectorStore`, exposed as `VectorStoreRetriever`.
- **Agent:** LangChain v1 `createAgent` with LangChain tools and middleware.
- **Evidence policy:** a thin application guard calls required read-only fact tools before the official agent loop for date-sensitive, current-web, and explicit knowledge-base questions. It does not generate or execute a competing model plan.
- **Source audit:** successful web tools contribute URL identifiers to an in-run ledger. The verify node removes answer URLs absent from that ledger and labels search-result-only evidence separately from extracted page content. This checks citation provenance, not whether every factual claim in a page is true.
- **Workflow:** LangGraph owns the `prepare_context → execute_agent → verify_result → finalize_task` state machine; task steps are projected only from actual tool calls. The old model-generated planner is no longer in the execution path.
- **Checkpoints:** `SqliteSaver` persists task state in `data/langgraph-checkpoints.sqlite`; transcript/profile storage remains on disk.
- **Long-term user memory:** explicit `remember` entries live in `data/user_memory.json`, are loaded for relevant future questions across agent restarts, and remain inspectable/editable/deletable. LangGraph checkpoints preserve task state; no in-memory LangGraph Store is presented as durable memory. Deep Agents scratch files are not persisted across restarts.
- **Human approval:** protected file actions call LangGraph `interrupt()`. Approval or rejection resumes the same task checkpoint; pending confirmation records are also persisted in `data/pending-actions.json` for restart recovery.
- **Cancellation and loop safety:** while a task is running, the chat submit button becomes Stop. It sends an authenticated `/api/agent/cancel` request for the exact request ID; the backend aborts its LangGraph/LangChain invocation and marks the task cancelled. Cancellation prevents further steps but does not undo actions already completed. Model/tool call limits and a repeated-identical-tool guard stop non-converging runs with a readable error before they can loop indefinitely.
- **Deep Agents:** explicit research, multi-source, batch-analysis, and sub-agent requests use `createDeepAgent`; its built-in filesystem is scratch state, while real desktop access still goes through policy-gated tools.
- **LangSmith:** tracing is opt-in through `LANGSMITH_TRACING=true`; graph runs include task/session metadata. `npm run eval:sync` creates the maintained regression dataset when credentials are configured.

Task state is available through `GET /api/agent/tasks/:sessionId`. Confirmation endpoints execute or reject the protected action and then resume the interrupted graph.

Deep Agents `1.14.1` currently requires LangSmith `<0.10.0`, so the runtime pins LangSmith `0.9.0`, the newest mutually compatible release, while keeping the other LangChain packages on the latest compatible releases checked on 2026-09-29.

Desktop-only tools use an explicit request/result bridge. The Node agent emits a `desktop_request` event, the frontend invokes the registered Tauri command after checking local permission switches, and the result is returned to `/api/agent/desktop-result`.

Windows release builds stage the compiled Node service, desktop assets, production dependencies, and matching `node.exe` under `runtime/` as Tauri bundle resources. Release mode starts `runtime/node.exe dist/server.js` from that resource directory; only development mode falls back to `npx tsx src/server.ts`. `npm run smoke:release` tests the staged service with isolated data before packaging.

## Security boundaries

- The HTTP service listens on loopback only.
- Tauri injects a new local request token for every launch. API calls require that token even when a caller sends a Tauri-like `Origin`; `Origin` alone is not authentication.
- Filesystem access is limited to authorized roots.
- Side-effecting actions use confirmation records and audit events.
- The model never receives arbitrary shell access.

Character modeling and animation are outside the current product scope.
