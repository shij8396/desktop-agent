import { describe, expect, it, vi } from 'vitest'
import { runWithReadOnlyRetry } from '../src/agent/langchainTools.js'

describe('LangChain tool retry boundary', () => {
  it('retries a transient read failure once', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('NETWORK_TIMEOUT'))
      .mockResolvedValueOnce('ok')
    await expect(runWithReadOnlyRetry('web_search', operation)).resolves.toBe('ok')
    expect(operation).toHaveBeenCalledTimes(2)
  })

  it('never retries a mutating tool after a transient-looking failure', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('NETWORK_TIMEOUT'))
    await expect(runWithReadOnlyRetry('write_file', operation)).rejects.toThrow('NETWORK_TIMEOUT')
    expect(operation).toHaveBeenCalledTimes(1)
  })
})
