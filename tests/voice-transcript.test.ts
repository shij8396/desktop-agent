import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

function createAssembler() {
  const window: Record<string, any> = {}
  const source = readFileSync(fileURLToPath(new URL('../desktop/voice-transcript.js', import.meta.url)), 'utf8')
  runInNewContext(source, { window })
  return window.AssistantTranscript.createTranscriptAssembler()
}

describe('desktop voice transcript assembly', () => {
  it('keeps an unfinished segment through a recognizer restart without duplicating a later final', () => {
    const transcript = createAssembler()
    transcript.begin('')
    transcript.provisional('我想打开')
    expect(transcript.segmentEnd()).toBe('我想打开')
    expect(transcript.final('我想打开记事本')).toBe('我想打开记事本')
    expect(transcript.finish()).toBe('我想打开记事本')
  })

  it('preserves separate segments until the user finishes speaking', () => {
    const transcript = createAssembler()
    transcript.begin('请')
    transcript.final('帮我')
    transcript.provisional('查一下天气')
    transcript.segmentEnd()
    transcript.final('北京今天的天气')
    expect(transcript.finish()).toContain('北京今天的天气')
    expect(transcript.finish()).toBe(transcript.text())
  })

  it('keeps the last provisional words if the recognizer never emits final text', () => {
    const transcript = createAssembler()
    transcript.begin('')
    transcript.provisional('写一份周报')
    expect(transcript.finish()).toBe('写一份周报')
  })
})
