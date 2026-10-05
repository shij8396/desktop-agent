import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

function preference() {
  const window = {} as any
  runInNewContext(readFileSync(fileURLToPath(new URL('../desktop/voice-preference.js', import.meta.url)), 'utf8'), { window })
  return window.AssistantVoicePreference
}

describe('desktop voice opt-in', () => {
  it('defaults off even when the legacy preference was implicitly on', () => {
    const voice = preference()
    expect(voice.isEnabled({})).toBe(false)
    expect(voice.isEnabled({ voiceEnabled: true })).toBe(false)
    expect(voice.isEnabled({ voicePreferenceVersion: 2, voiceEnabled: false })).toBe(false)
  })

  it('persists an explicit opt-in without losing other preferences', () => {
    const voice = preference()
    const enabled = voice.update({ desktopAccess: true }, true)
    expect(enabled).toMatchObject({ desktopAccess: true, voiceEnabled: true, voicePreferenceVersion: 2 })
    expect(voice.isEnabled(enabled)).toBe(true)
    expect(voice.isEnabled(voice.update(enabled, false))).toBe(false)
  })
})
