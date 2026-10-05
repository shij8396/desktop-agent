import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

describe('desktop voice capture', () => {
  afterEach(() => vi.useRealTimers())

  it('retains a long 60-second dictation across repeated recognizer boundaries', () => {
    vi.useFakeTimers()
    class Recognition {
      onstart?: () => void
      onend?: () => void
      onresult?: (event: any) => void
      starts = 0
      start() { this.starts++; this.onstart?.() }
      stop() { this.onend?.() }
    }
    const window = { SpeechRecognition: Recognition, AssistantShared: {} } as any
    runInNewContext(readFileSync(fileURLToPath(new URL('../desktop/voice.js', import.meta.url)), 'utf8'), { window, setTimeout, clearTimeout })
    runInNewContext(readFileSync(fileURLToPath(new URL('../desktop/voice-transcript.js', import.meta.url)), 'utf8'), { window })
    const voice = window.VoiceModule
    const transcript = window.AssistantTranscript.createTranscriptAssembler()
    const endings: boolean[] = []
    transcript.begin('')
    voice.onResult = (text: string) => transcript.final(text)
    voice.onSegmentEnd = () => transcript.segmentEnd()
    voice.onSpeechEnd = (manual: boolean) => endings.push(manual)
    voice.start()
    const recognition = voice.recognition as Recognition
    for (let i = 1; i <= 12; i++) {
      recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: `第${i}段。` } }] })
      recognition.onend?.()
      vi.advanceTimersByTime(5000)
      expect(voice.isCapturing()).toBe(true)
    }
    expect(recognition.starts).toBe(13)
    expect(endings).toEqual([])
    voice.stop()
    expect(endings).toEqual([true])
    for (let i = 1; i <= 12; i++) expect(transcript.finish()).toContain(`第${i}段。`)
  })

  it('keeps listening across a short recognition stop and finishes only when the user stops it', () => {
    vi.useFakeTimers()
    const starts: number[] = []
    class Recognition {
      onstart?: () => void
      onend?: () => void
      onresult?: (event: any) => void
      start() { starts.push(1); this.onstart?.() }
      stop() { this.onend?.() }
    }
    const window = { SpeechRecognition: Recognition, AssistantShared: {} } as any
    const source = readFileSync(fileURLToPath(new URL('../desktop/voice.js', import.meta.url)), 'utf8')
    runInNewContext(source, { window, setTimeout, clearTimeout })
    const voice = window.VoiceModule
    const results: string[] = []
    const ends: boolean[] = []
    voice.onResult = (text: string) => results.push(text)
    voice.onSpeechEnd = (manual: boolean) => ends.push(manual)

    expect(voice.start()).toBe(true)
    const recognition = voice.recognition as Recognition
    recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: '第一段' } }] })
    recognition.onend?.()
    expect(voice.isCapturing()).toBe(true)
    expect(ends).toEqual([])
    vi.advanceTimersByTime(100)
    expect(starts).toHaveLength(2)
    recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: '第二段' } }] })
    voice.stop()

    expect(results).toEqual(['第一段', '第二段'])
    expect(ends).toEqual([true])
    expect(voice.isCapturing()).toBe(false)
    vi.advanceTimersByTime(3000)
    expect(starts).toHaveLength(2)
  })

  it('can disable an active capture without submitting a voice message', () => {
    vi.useFakeTimers()
    class Recognition {
      onstart?: () => void
      onend?: () => void
      start() { this.onstart?.() }
      stop() { this.onend?.() }
    }
    const window = { SpeechRecognition: Recognition, AssistantShared: {} } as any
    runInNewContext(readFileSync(fileURLToPath(new URL('../desktop/voice.js', import.meta.url)), 'utf8'), { window, setTimeout, clearTimeout })
    const voice = window.VoiceModule
    const endings: boolean[] = []
    voice.onSpeechEnd = (send: boolean) => endings.push(send)
    voice.start()
    expect(voice.isCapturing()).toBe(true)
    voice.stop(false)
    expect(voice.isCapturing()).toBe(false)
    expect(endings).toEqual([false])
    vi.advanceTimersByTime(2000)
    expect(endings).toEqual([false])
  })

  it('waits for the final transcript when the user stops after a recognition error', () => {
    vi.useFakeTimers()
    class Recognition {
      onstart?: () => void
      onend?: () => void
      onerror?: (event: any) => void
      onresult?: (event: any) => void
      start() { this.onstart?.() }
      stop() { /* Chromium may deliver the final result before onend. */ }
    }
    const window = { SpeechRecognition: Recognition, AssistantShared: {} } as any
    runInNewContext(readFileSync(fileURLToPath(new URL('../desktop/voice.js', import.meta.url)), 'utf8'), { window, setTimeout, clearTimeout })
    const voice = window.VoiceModule
    const results: string[] = []
    const ends: boolean[] = []
    voice.onResult = (text: string) => results.push(text)
    voice.onSpeechEnd = (manual: boolean) => ends.push(manual)

    voice.start()
    const recognition = voice.recognition as Recognition
    recognition.onerror?.({ error: 'no-speech' })
    voice.stop()
    expect(ends).toEqual([])
    recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: '最后一句' } }] })
    recognition.onend?.()
    expect(results).toEqual(['最后一句'])
    expect(ends).toEqual([true])
    vi.advanceTimersByTime(2000)
    expect(ends).toEqual([true])
  })

  it('stops retrying after repeated network errors instead of pretending to listen forever', () => {
    vi.useFakeTimers()
    class Recognition {
      onstart?: () => void
      onend?: () => void
      onerror?: (event: any) => void
      starts = 0
      start() { this.starts++; this.onstart?.() }
      stop() { this.onend?.() }
    }
    const window = { SpeechRecognition: Recognition, AssistantShared: {} } as any
    runInNewContext(readFileSync(fileURLToPath(new URL('../desktop/voice.js', import.meta.url)), 'utf8'), { window, setTimeout, clearTimeout })
    const voice = window.VoiceModule
    const ends: boolean[] = []
    voice.onSpeechEnd = (manual: boolean) => ends.push(manual)
    voice.start()
    const recognition = voice.recognition as Recognition
    for (let attempt = 0; attempt < 3; attempt++) {
      recognition.onerror?.({ error: 'network' })
      recognition.onend?.()
      vi.advanceTimersByTime(500)
    }
    expect(recognition.starts).toBe(3)
    expect(voice.isCapturing()).toBe(false)
    expect(ends).toEqual([false])
  })

  it('preserves a recognition boundary and ends once when Chromium never sends onend', () => {
    vi.useFakeTimers()
    class Recognition {
      onstart?: () => void
      onend?: () => void
      onresult?: (event: any) => void
      start() { this.onstart?.() }
      stop() { /* Simulate a stuck Web Speech service. */ }
    }
    const window = { SpeechRecognition: Recognition, AssistantShared: {} } as any
    runInNewContext(readFileSync(fileURLToPath(new URL('../desktop/voice.js', import.meta.url)), 'utf8'), { window, setTimeout, clearTimeout })
    const voice = window.VoiceModule
    const boundaries: number[] = []
    const ends: boolean[] = []
    voice.onSegmentEnd = () => boundaries.push(1)
    voice.onSpeechEnd = (manual: boolean) => ends.push(manual)

    voice.start()
    voice.recognition.onend?.()
    expect(boundaries).toHaveLength(1)
    vi.advanceTimersByTime(100)
    voice.stop()
    vi.advanceTimersByTime(1500)
    expect(ends).toEqual([true])
    voice.recognition.onend?.()
    expect(ends).toEqual([true])
  })
})
