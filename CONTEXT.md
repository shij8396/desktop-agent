# Context

## Current desktop architecture

| Term | Meaning |
|---|---|
| assistant window | The single Tauri window with label `pet`; the label is retained for IPC compatibility. |
| assistant UI | `desktop/pet.html`, `desktop/assistant.css`, and `desktop/assistant-window.js`. |
| settings drawer | Model configuration, local permission switches, speech, and proactive-assistance preferences. |
| desktop bridge | Frontend handler that executes approved Tauri commands and returns results to `/api/agent/desktop-result`. |
| local token | Per-launch token injected by Tauri and required by the loopback Hono service. |

The active UI has no character model, renderer, animation state machine, roaming behavior, or character appearance settings. The historical `pet` window label and `rag-pet-*` backend names remain internal compatibility identifiers and do not indicate an active character feature.
