import { beforeEach, describe, expect, it, vi } from 'vitest'

const ttsMock = vi.hoisted(() => ({
  rawToStream: vi.fn(),
  toStream: vi.fn(),
  setMetadata: vi.fn(),
  close: vi.fn(),
}))

vi.mock('msedge-tts', () => ({
  OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'mp3' },
  MsEdgeTTS: class {
    setMetadata = ttsMock.setMetadata
    rawToStream = ttsMock.rawToStream
    toStream = ttsMock.toStream
    close = ttsMock.close
  },
}))

import { synthesizeEdgeTts, streamEdgeTts } from '../src/edgeTts.js'

describe('Edge TTS SSML', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ttsMock.rawToStream.mockImplementation(() => ({
      audioStream: (async function* () { yield Buffer.from('audio') })(),
    }))
  })

  it('sends one complete SSML document without wrapping it again', async () => {
    const audio = await synthesizeEdgeTts('你好 <朋友>', { tone: 'male-warm', lang: 'zh-CN' })
    expect(audio.toString()).toBe('audio')
    expect(ttsMock.toStream).not.toHaveBeenCalled()
    expect(ttsMock.rawToStream).toHaveBeenCalledOnce()
    const ssml = ttsMock.rawToStream.mock.calls[0][0] as string
    expect(ssml.match(/<speak\b/g)).toHaveLength(1)
    expect(ssml).toContain('你好 &lt;朋友&gt;')
  })

  it('uses the same raw SSML path for streaming audio', async () => {
    const chunks: Buffer[] = []
    await streamEdgeTts('继续', { tone: 'female-calm', lang: 'zh-CN' }, async chunk => { chunks.push(chunk) })
    expect(Buffer.concat(chunks).toString()).toBe('audio')
    expect(ttsMock.toStream).not.toHaveBeenCalled()
    expect(ttsMock.rawToStream).toHaveBeenCalledOnce()
  })
})
