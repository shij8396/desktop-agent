# Desktop Assistant

A security-first desktop AI assistant built with Tauri, TypeScript, Hono, and LangChain.

## Features

- RAG chat over a local knowledge base
- Read-only system assistance: disk space, authorized directory listing, and file search
- Focused desktop chat window with task progress and approval cards
- First-run DeepSeek/OpenAI settings panel
- Optional voice input and read-aloud, off by default and enabled from Settings without re-entering the model API key
- Native resizable Tauri desktop window
- Policy-controlled local web search for every model provider
- Document ingestion for PDF, DOCX, HTML, Markdown, and TXT files
- Streaming responses over SSE
- Durable LangGraph task activity with SQLite checkpoints and approval resume
- Deep Agents routing for explicit complex and multi-source work
- Optional LangSmith tracing and a reusable regression dataset

## Architecture

```text
desktop/
  pet.html            Desktop assistant window
  assistant-window.js Chat, settings, SSE, and desktop-tool bridge
  assistant.css       Desktop interface styles
  shared.js           Tauri and API helpers
  voice.js            Speech input and output

src/
  server.ts           Hono HTTP server
  ragAgent.ts         LangChain application facade and model routing
  agent/engine.ts     Durable LangGraph workflow around the LangChain agent
  agent/workflow.ts   Task activity projection, risk, and step transitions
  agent/prompts.ts    ChatPromptTemplate and RunnableSequence chains
  agent/langchainTools.ts LangChain tools and Retriever chain
  tools.ts            Policy-gated read-only tools for KB, files, disk, calculation, and web search
  audit.ts            Hash-only local tool audit log
  document.ts         Document loader and chunker
  embedding.ts        LangChain local embedding implementation
  vectorStore.ts      LangChain VectorStore/Retriever with disk persistence
  memory.ts           Durable transcript and user-profile storage
  config.ts           Environment configuration

src-tauri/
  src/main.rs         Tauri setup, server spawn, window commands
  tauri.conf.json     Desktop window config
```

## Quick Start

### Prerequisites

- Node.js 22+ (required by the latest `@langchain/openai`)
- Rust, for Tauri desktop builds
- A DeepSeek API key, Ollama for local mode, or an OpenAI API key

### Setup

```bash
npm install
cp .env.example .env
# DeepSeek mode: set DEEPSEEK_API_KEY in .env
npm test
npm run build
npm run check:desktop
```

Optional LangSmith setup is documented in `.env.example`. After configuring a LangSmith API key, `npm run eval:sync` creates the desktop-agent regression dataset once.

### Desktop Mode

```bash
npm run tauri:dev
```

The desktop application opens directly to the assistant conversation. It shows streamed answers, actual tool activity, confirmation cards, model settings, local permission controls, and optional speech input/output. Character modeling and animation are intentionally outside the product scope.
When the Tauri application owns the local service, API requests require its per-launch token. Opening `http://127.0.0.1:3000/pet.html` separately in a regular browser does not grant that token and cannot execute protected tasks; use the desktop window for those tasks.

### CLI / Server Mode

```bash
npm run serve
npm run dev
```

## Configuration

## Security model (current release)

Read-only tools include disk usage, authorized file listing/search, knowledge-base search, time, calculation, and web search. Selected side-effecting desktop and file tools are available only through authorized paths, local permission switches, and the confirmation bridge. Arbitrary shell execution remains unavailable; the runtime must not claim a protected action succeeded before receiving its actual desktop result. Knowledge-base ingestion through the public HTTP endpoint remains disabled.

The Tauri desktop process generates a per-launch local token and the Hono service listens only on `127.0.0.1`. UI requests must provide that token. Tool audit records contain only input/result hashes, never raw document or clipboard contents.

Development mode starts the TypeScript server with `npx tsx`. For a Windows NSIS installer, run `npm run package:windows` (or `npm run tauri:build`). The release script stages a matching Node executable, compiled server, desktop assets, and production-only dependencies, smoke-tests the staged service, and bundles them with Tauri. The resulting installer is under `src-tauri/target/release/bundle/nsis/`. A local build is not code-signed and has not been validated on a clean second computer; do not represent it as a signed public release.

Desktop runtime settings are stored in the user's app data directory, for example:

```text
%APPDATA%\RAG Pet\config.json
%APPDATA%\RAG Pet\data\
%APPDATA%\RAG Pet\chat-history\
%APPDATA%\RAG Pet\logs\rag-pet.log
```

`.env` is still supported as a development fallback.

```env
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=your-deepseek-api-key-here
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_MODEL=deepseek-chat
SERVER_PORT=3000
CHUNK_SIZE=500
CHUNK_OVERLAP=100
TOP_K=5
```

For free local Ollama mode, set:

```env
LLM_PROVIDER=ollama
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=ollama
OPENAI_MODEL=qwen2.5:7b
```

For paid OpenAI mode, set:

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=your-api-key-here
OPENAI_MODEL=gpt-5.4-mini
```

All providers use the same policy-controlled LangChain `web_search` tool backed by the existing Bing/DuckDuckGo HTML search code.

## API Endpoints

| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/status` | GET | Server status and knowledge base count |
| `/api/ask` | POST | Ask a question |
| `/api/ask/stream` | POST | Ask a question with SSE streaming |
| `/api/ingest` | POST | Ingest documents into the knowledge base |
| `/api/clipboard` | GET | Read system clipboard |

## Verification

```bash
npm test
npm run build
npm run check:desktop
cd src-tauri && cargo check
```

`npm run tauri:build` may compile the release executable successfully and still fail while bundling an installer if WiX has to be downloaded and the download times out. For this delivery target, a runnable local desktop app is the pass condition.

## License

MIT

The active desktop path does not include character-model runtimes or character assets.
