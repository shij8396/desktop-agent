# Desktop Assistant change report

## Character-model removal

The active desktop product no longer contains a character model or animation runtime.

Removed components:

- layered 2D character renderer;
- character state machine and emotion-driven animation;
- autonomous roaming behavior;
- renderer factory and character canvas;
- skin-tone and character-floating settings;
- Three.js and VRM runtime dependencies;
- character-specific validation script.

The Tauri application now opens as a normal resizable desktop-assistant window. Chat streaming, task plans, tool progress, approval cards, model settings, local permission controls, speech, the Agent engine, RAG, memory, monitoring, and the controlled desktop-command bridge remain available.

The internal window label `pet` and some Rust command names are retained for IPC and persisted-runtime compatibility. They are implementation identifiers and do not expose character functionality.

## Durable LangGraph task workflow

The Agent runtime now uses an explicit LangGraph workflow with planning, execution, basic result verification, and finalization nodes. Task checkpoints are stored in SQLite rather than process memory. Protected file operations interrupt the graph and can resume from the same checkpoint after the user approves or rejects the action. The desktop approval card supports both decisions, and task state is exposed through a read-only status endpoint.

Explicitly complex or multi-source requests are routed to the official Deep Agents runtime, which provides todo planning, scratch files, context management, and sub-agent delegation. Real desktop access remains restricted to the existing policy-gated tools. LangSmith tracing is opt-in, tagged with session/task metadata, and accompanied by a versioned local regression dataset that can be synchronized without changing normal local-only behavior.
