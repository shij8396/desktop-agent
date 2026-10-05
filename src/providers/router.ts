import { config } from '../config.js'
import { createLogger } from '../logger.js'

const log = createLogger('model-router')

export type ConnectivityState = 'online' | 'unstable' | 'offline'

export interface ProviderSelection {
  provider: string
  model: string
  online: boolean
  fallback: boolean
  reason: string
}

/**
 * Model router that selects the appropriate LLM provider based on
 * network connectivity and data classification.
 */
export class ModelRouter {
  private lastCheck: number = 0
  private cachedState: ConnectivityState = 'online'
  private checkIntervalMs: number = 30_000 // Check connectivity every 30s (shorter = faster recovery)

  /**
   * Probe the user-configured provider endpoint once.
   * Uses GET /v1/models with Authorization header — empirically more reliable
   * than HEAD (some CDNs/proxies reject HEAD) and avoids the 401 path that
   * some custom base URLs return differently. A 401/403/404 still counts as
   * reachable (endpoint responded, just auth/route mismatch).
   * Returns true on reachability, false on network-level failure.
   */
  private async probeOnce(baseUrl: string, apiKey: string, timeoutMs: number): Promise<boolean> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers: Record<string, string> = {}
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
      const response = await fetch(`${baseUrl}/v1/models`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      })
      // Any HTTP response (even 401/403/404) means the endpoint is reachable.
      return response.status < 500
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * Check network connectivity by attempting a lightweight HTTP request.
   * Probes the user-configured provider endpoint (DeepSeek/OpenAI/Ollama)
   * instead of a hardcoded URL — otherwise users on networks where OpenAI
   * is blocked but DeepSeek is reachable get falsely flagged offline.
   *
   * Robustness measures (fix for "false offline" flaps):
   *   1. GET + Authorization header (most reliable method empirically)
   *   2. 8s timeout (DNS/TCP handshake can be slow on first call)
   *   3. Retry once on failure with longer timeout before declaring offline
   */
  async checkConnectivity(): Promise<ConnectivityState> {
    const now = Date.now()
    if (now - this.lastCheck < this.checkIntervalMs) {
      return this.cachedState
    }
    this.lastCheck = now

    const baseUrl = (config.openaiBaseUrl || 'https://api.deepseek.com').replace(/\/$/, '')
    const provider = config.llmProvider

    // Ollama uses a different health endpoint and needs no auth.
    if (provider === 'ollama') {
      const ok = await this.checkOllama()
      this.cachedState = ok ? 'online' : 'offline'
      log.info('Connectivity check', { state: this.cachedState, provider, baseUrl })
      return this.cachedState
    }

    const apiKey = config.openaiApiKey

    // First attempt: 8s timeout
    let reachable = false
    try {
      reachable = await this.probeOnce(baseUrl, apiKey, 8000)
    } catch {
      reachable = false
    }

    // Retry once on failure with a longer timeout before declaring offline.
    // This absorbs transient DNS/TCP hiccups that previously caused false offline.
    if (!reachable) {
      try {
        reachable = await this.probeOnce(baseUrl, apiKey, 12_000)
      } catch {
        reachable = false
      }
    }

    if (reachable) {
      this.cachedState = 'online'
    } else {
      // Last resort: ping-style HEAD without auth (some proxies strip Authorization
      // and return 200). Any HTTP response still means network is up.
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 8000)
        const resp = await fetch(`${baseUrl}/v1/models`, {
          method: 'HEAD',
          signal: controller.signal,
        })
        clearTimeout(timeout)
        this.cachedState = resp.status < 500 ? 'online' : 'unstable'
      } catch {
        this.cachedState = 'offline'
      }
    }

    log.info('Connectivity check', { state: this.cachedState, provider, baseUrl })
    return this.cachedState
  }

  /**
   * Check if Ollama is running locally.
   */
  private async checkOllama(): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 2000)
      const response = await fetch(`${config.ollamaBaseUrl}/api/tags`, {
        signal: controller.signal,
      })
      clearTimeout(timeout)
      return response.ok
    } catch {
      return false
    }
  }

  /**
   * Select the appropriate provider based on connectivity and user config.
   */
  async selectProvider(): Promise<ProviderSelection> {
    const connectivity = await this.checkConnectivity()

    if (connectivity === 'online') {
      return {
        provider: config.llmProvider,
        model: config.llmModel,
        online: true,
        fallback: false,
        reason: 'Online — using configured provider',
      }
    }

    // Offline or unstable — try Ollama
    const ollamaAvailable = await this.checkOllama()
    if (ollamaAvailable) {
      return {
        provider: 'ollama',
        model: config.ollamaModel,
        online: false,
        fallback: true,
        reason: 'Offline — switched to local Ollama model',
      }
    }

    // No LLM available — tools only
    return {
      provider: 'none',
      model: '',
      online: false,
      fallback: true,
      reason: 'Offline and no local model available — tools only mode',
    }
  }

  /**
   * Get the current connectivity state without checking.
   */
  get currentState(): ConnectivityState {
    return this.cachedState
  }

  /**
   * Force a connectivity check on the next call.
   */
  invalidateCache(): void {
    this.lastCheck = 0
  }
}

export const modelRouter = new ModelRouter()
