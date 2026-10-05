import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import { createLogger } from './logger.js'

const log = createLogger('edge-tts')

/**
 * 音色映射表 — 把小伴的 tone（male-low / male-warm / female-calm）映射到 Edge TTS 的 voice
 * 中文音色优先；英文文本自动切到 en-US 音色。
 */
const VOICE_MAP = {
  'zh-CN': {
    'male-low': 'zh-CN-YunxiNeural',       // 云希 — 沉稳男声
    'male-warm': 'zh-CN-YunyangNeural',    // 云扬 — 温暖男声
    'female-calm': 'zh-CN-XiaoyiNeural',   // 晓伊 — 温柔女声
  },
  'en-US': {
    'male-low': 'en-US-GuyNeural',
    'male-warm': 'en-US-DavisNeural',
    'female-calm': 'en-US-JennyNeural',
  },
}

/**
 * 根据 tone 和 lang 选 voice
 */
export function pickEdgeVoice(tone: string, lang: string): string {
  const langKey = lang?.toLowerCase().startsWith('zh') ? 'zh-CN'
    : lang?.toLowerCase().startsWith('en') ? 'en-US'
    : 'zh-CN'
  const map = VOICE_MAP[langKey as keyof typeof VOICE_MAP] || VOICE_MAP['zh-CN']
  return map[tone as keyof typeof map] || map['male-low']
}

/**
 * 根据 tone 转 SSML prosody rate/pitch
 */
function toneToProsody(tone: string): { rate: string; pitch: string } {
  switch (tone) {
    case 'male-low': return { rate: '-5%', pitch: '-10Hz' }
    case 'male-warm': return { rate: '+0%', pitch: '+0Hz' }
    case 'female-calm': return { rate: '+5%', pitch: '+15%' }
    default: return { rate: '+0%', pitch: '+0Hz' }
  }
}

/**
 * 调用 Edge TTS 合成文本，返回 MP3 音频 Buffer（完整合成后返回）。
 * 失败时抛错，由调用方决定是否回退到浏览器 TTS。
 *
 * @param text 待合成文本（建议已切句，单句效果最好）
 * @param opts { tone, lang, voice?, rate?, pitch?, volume? }
 */
export async function synthesizeEdgeTts(
  text: string,
  opts: { tone: string; lang: string; voice?: string; rate?: number; pitch?: number },
): Promise<Buffer> {
  const voice = opts.voice || pickEdgeVoice(opts.tone, opts.lang)
  const lang = opts.lang?.toLowerCase().startsWith('zh') ? 'zh-CN'
    : opts.lang?.toLowerCase().startsWith('en') ? 'en-US'
    : 'zh-CN'
  const prosody = toneToProsody(opts.tone)
  const rate = opts.rate != null ? `${Math.round((opts.rate - 1) * 100)}%` : prosody.rate
  const pitch = opts.pitch != null ? `${Math.round((opts.pitch - 1) * 12)}st` : prosody.pitch

  const tts = new MsEdgeTTS()
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)

  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">
  <voice name="${voice}">
    <prosody rate="${rate}" pitch="${pitch}">${escapeXml(text)}</prosody>
  </voice>
</speak>`

  // toStream() wraps its input in SSML; this value is already a complete document.
  const { audioStream } = tts.rawToStream(ssml)
  const chunks: Buffer[] = []
  for await (const chunk of audioStream) {
    chunks.push(Buffer.from(chunk))
  }
  try { tts.close() } catch {}
  const buf = Buffer.concat(chunks)
  if (buf.length === 0) {
    throw new Error('Edge TTS produced empty audio')
  }
  log.debug('tts synthesized', { voice, lang, textLen: text.length, bytes: buf.length })
  return buf
}

/**
 * 流式合成 — 通过 SSE 把 MP3 二进制块按序推给前端
 * 边合成边发送，首字节延迟更低。
 *
 * 注意：这里返回的是 raw MP3 字节流，前端用 ReadableStream 拼接成 Blob 后播放。
 */
export async function streamEdgeTts(
  text: string,
  opts: { tone: string; lang: string; voice?: string; rate?: number; pitch?: number },
  onChunk: (chunk: Buffer) => Promise<void>,
): Promise<void> {
  const voice = opts.voice || pickEdgeVoice(opts.tone, opts.lang)
  const lang = opts.lang?.toLowerCase().startsWith('zh') ? 'zh-CN'
    : opts.lang?.toLowerCase().startsWith('en') ? 'en-US'
    : 'zh-CN'
  const prosody = toneToProsody(opts.tone)
  const rate = opts.rate != null ? `${Math.round((opts.rate - 1) * 100)}%` : prosody.rate
  const pitch = opts.pitch != null ? `${Math.round((opts.pitch - 1) * 12)}st` : prosody.pitch

  const tts = new MsEdgeTTS()
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)

  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">
  <voice name="${voice}">
    <prosody rate="${rate}" pitch="${pitch}">${escapeXml(text)}</prosody>
  </voice>
</speak>`

  const { audioStream } = tts.rawToStream(ssml)
  for await (const chunk of audioStream) {
    await onChunk(Buffer.from(chunk))
  }
  try { tts.close() } catch {}
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * 检查 Edge TTS 是否可用（简单 ping）
 */
let _available: boolean | null = null
export async function isEdgeTtsAvailable(): Promise<boolean> {
  if (_available !== null) return _available
  try {
    const buf = await synthesizeEdgeTts('测试', { tone: 'male-low', lang: 'zh-CN' })
    _available = buf.length > 0
  } catch {
    _available = false
  }
  return _available
}
