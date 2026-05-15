# RAG Pet

A desktop AI assistant with a cute pet companion, built with Tauri + TypeScript + Hono.

## Features

- **RAG-powered chat** — Ask questions, get answers from your local knowledge base
- **Desktop pet** — Animated character that patrols your desktop, reacts to conversations
- **Dual window** — Separate chat panel and pet window, communicating via Tauri events
- **Web search** — Built-in Bing/DuckDuckGo search fallback
- **Document ingestion** — Load PDF, DOCX, HTML, Markdown, TXT into the knowledge base
- **Streaming responses** — Real-time token-by-token output via SSE

## Architecture

```
desktop/
  index.html        Chat window (Hono frontend)
  pet.html           Pet window (animated character)
  app.js             Chat UI logic
  pet-window.js      Pet initialization and movement
  desktop-behavior.js  Autonomous patrol engine
  character-runtime.js State machine (13 states)
  emotion-state.js   Emotion tracking and decay
  sprite-renderer.js Canvas sprite renderer
  character-sprites.js SVG chibi character definitions
  live2d-renderer.js Live2D adapter (optional, fallback to sprite)
  renderer-factory.js  Renderer backend selector
  context-menu.js    Right-click menu (toggle chat / quit)
  style.css          Chat panel styles
  pet.css            Pet window styles

src/
  server.ts          Hono HTTP server
  ragAgent.ts        Claude/MiMo API agent with tool-use loop
  tools.ts           14 tools (search, file ops, calculate, etc.)
  document.ts        Document loader and chunker
  embedding.ts       BM25 text retrieval with Chinese tokenizer
  vectorStore.ts     In-memory vector store with disk persistence
  memory.ts          Session-based chat history
  webSearch.ts       Dual-engine web search
  config.ts          Environment configuration
  clipboard.ts       Cross-platform clipboard reading

src-tauri/
  src/main.rs        Tauri setup, server spawn, window management
  tauri.conf.json    Window config (chat + pet)
  Cargo.toml         Rust dependencies
  capabilities/      Tauri IPC permissions
```

## Quick Start

### Prerequisites

- Node.js 18+
- Rust (for Tauri desktop build)
- An API key for the AI model (MiMo or compatible Anthropic endpoint)

### Setup

```bash
# Clone
git clone <repo-url>
cd rag-agent

# Install dependencies
npm install

# Configure API
cp .env.example .env
# Edit .env with your API key and endpoint

# Run tests
npm test

# Build TypeScript
npm run build
```

### Desktop Mode (recommended)

```bash
# Start in desktop mode (launches chat + pet windows)
npm run tauri:dev
```

### CLI Mode (development)

```bash
# Start server only
npm run serve

# Or use the dev script
npm run dev
```

## Configuration

Edit `.env` (copy from `.env.example`):

```env
ANTHROPIC_API_KEY=your-api-key
ANTHROPIC_BASE_URL=https://your-api-endpoint/anthropic
ANTHROPIC_MODEL=mimo-v2-pro[1m]
PORT=3000
CHUNK_SIZE=500
CHUNK_OVERLAP=100
TOP_K=5
```

## Pet Window

The pet character:
- Patrols the desktop autonomously after 8 seconds idle
- Approaches the chat window when you type
- Reacts to conversation success/failure with emotions
- Right-click to toggle chat or quit

### Live2D (optional)

Place Live2D models at `desktop/assets/live2d/<model>/model3.json`. The renderer auto-detects and falls back to sprite if unavailable.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Server status and knowledge base count |
| `/api/ask` | POST | Ask a question (non-streaming) |
| `/api/ask/stream` | POST | Ask a question (SSE streaming) |
| `/api/ingest` | POST | Ingest documents into knowledge base |
| `/api/clipboard` | GET | Read system clipboard |

## Testing

```bash
npm test          # Run all tests
npm run build     # TypeScript compilation check
```

## License

MIT
