// Shared utilities for desktop frontend scripts.
// Eliminates duplicated Tauri helpers, API client, and SSE parsing logic.

(function () {
  let API = 'http://127.0.0.1:3000';
  let runtimeToken = '';

  // ---- Tauri helpers ----

  function getTauri() { return window.__TAURI__ || {}; }
  function getInternals() { return window.__TAURI_INTERNALS__ || {}; }
  // Tauri v2: @tauri-apps/api provides __TAURI__.core.invoke, but pure-HTML
  // frontends without the npm package must use the auto-injected
  // __TAURI_INTERNALS__.invoke instead.
  function getInvoke() { return getTauri().core?.invoke || getInternals().invoke; }
  function getEmit() { return getTauri().event?.emit; }
  function getListen() { return getTauri().event?.listen; }
  function getCurrentWindow() { return getTauri().window?.getCurrentWindow?.() || null; }

  // ---- API client ----

  async function initApi() {
    const invoke = getInvoke();
    if (!invoke) return;
    try {
      const runtime = await invoke('get_runtime_config');
      API = runtime?.api_base_url || API;
      runtimeToken = runtime?.local_token || '';
    } catch (error) {
      console.error('[assistant] runtime configuration unavailable', error);
    }
  }

  function apiHeaders(extra) {
    if (extra === undefined) extra = {};
    return runtimeToken ? Object.assign({}, extra, { 'X-Assistant-Token': runtimeToken }) : extra;
  }

  function getApiBase() { return API; }

  // ---- SSE stream parser ----

  /**
   * Parses an SSE response body and dispatches events to handlers.
   * @param {Response} response - Fetch response with a readable body
   * @param {Object} handlers - { onToken, onTool, onToolResult, onError }
   * @param {AbortSignal} [signal] - Optional abort signal
   */
  async function parseSSEStream(response, handlers, signal) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        if (signal?.aborted) { reader.cancel(); break; }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6).trim());
            if (event.token && handlers.onToken) handlers.onToken(event.token, event);
            if (event.tool && handlers.onTool) handlers.onTool(event.tool, event);
            if (event.toolResult && handlers.onToolResult) handlers.onToolResult(event.toolResult, event);
            if (event.error && handlers.onError) handlers.onError(event.error, event);
          } catch { /* incomplete SSE frame */ }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }

  // ---- Agent engine stream parser ----

  /**
   * Execute a query via the Agent engine and stream reasoning events.
   * @param {string} question
   * @param {string} sessionId
   * @param {Object} handlers - { onThought, onAction, onObservation, onAnswer, onPlan, onStepUpdate, onError, onDone }
   * @param {AbortSignal} signal
   */
  async function executeAgent(question, sessionId, handlers, signal, options) {
    const body = { question, sessionId };
    // If the caller provides a screenshot (base64 PNG), forward it so the
    // agent's capture_screen_vision tool can send it to Ollama llava.
    if (options?.screenshot) body.screenshot = options.screenshot;
    if (options?.forceWeb) body.forceWeb = true;
    if (options?.requestId) body.requestId = options.requestId;
    const response = await fetch(getApiBase() + '/api/agent/execute', {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok || !response.body) throw new Error('HTTP ' + response.status);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      if (signal?.aborted) { reader.cancel(); break; }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE frames: "event: xxx\ndata: yyy\n\n"
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';

      for (const frame of frames) {
        const lines = frame.split('\n');
        let eventData = '';
        for (const line of lines) {
          if (line.startsWith('data: ')) eventData += line.slice(6);
          else if (line.startsWith('data:')) eventData += line.slice(5);
        }
        if (!eventData) continue;
        try {
          const event = JSON.parse(eventData);
          switch (event.type) {
            case 'thought': handlers.onThought?.(event.content, event); break;
            case 'action': handlers.onAction?.(event.content, event); break;
            case 'observation': handlers.onObservation?.(event.content, event); break;
            case 'desktop_request': handlers.onDesktopRequest?.(event, event); break;
            case 'confirmation_required': handlers.onConfirmationRequired?.(event, event); break;
            case 'answer': handlers.onAnswer?.(event.content, event); break;
            case 'plan': handlers.onPlan?.(event.plan, event); break;
            case 'step_update': handlers.onStepUpdate?.(event.step_id, event.content, event); break;
            case 'error': handlers.onError?.(event.content, event); break;
            case 'done': handlers.onDone?.(event.content, event); break;
          }
        } catch (e) { /* skip malformed */ }
      }
    }
  }

  // ---- Wait for server ----

  async function waitForServer(maxAttempts, intervalMs) {
    maxAttempts = maxAttempts || 30;
    intervalMs = intervalMs || 500;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await fetch(API + '/api/status', { headers: apiHeaders() });
        if (response.ok) return await response.json();
      } catch {}
      await new Promise(function (resolve) { setTimeout(resolve, intervalMs); });
    }
    return null;
  }

  // ---- System monitoring (Tauri commands) ----

  async function getSystemStats() {
    const invoke = getInvoke();
    if (!invoke) throw new Error('Tauri not available');
    return invoke('get_system_stats');
  }

  async function getDiskUsage(volume) {
    const invoke = getInvoke();
    if (!invoke) throw new Error('Tauri not available');
    return invoke('get_disk_usage', { volume });
  }

  window.AssistantShared = {
    getInvoke: getInvoke,
    getEmit: getEmit,
    getListen: getListen,
    getCurrentWindow: getCurrentWindow,
    initApi: initApi,
    apiHeaders: apiHeaders,
    getApiBase: getApiBase,
    parseSSEStream: parseSSEStream,
    executeAgent: executeAgent,
    waitForServer: waitForServer,
    getSystemStats: getSystemStats,
    getDiskUsage: getDiskUsage,
  };
})();
