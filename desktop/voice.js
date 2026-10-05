/**
 * VoiceModule — 贾维斯式语音交互层
 *
 * 核心能力：
 * 1. 持续对话模式（continuous + 自动重启）
 * 2. Barge-in 打断（TTS 播放时 VAD 监听，检测到说话立即停 TTS）
 * 3. 唤醒词检测（能量阈值 + 关键词匹配，离线可用）
 * 4. 流式 TTS 队列（句子级播报，来一句播一句）
 * 5. 对话状态机（idle / listening / thinking / speaking）
 *
 * 浏览器原生 Web Speech API 实现，零依赖。
 * Windows 上调用 Edge 在线 ASR/TTS。
 */
(function () {
  'root' in window || (window.root = undefined);

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const SpeechSynthesis = window.speechSynthesis;

  // === API 工具（从 AssistantShared 取，用于 Edge TTS 调用）===
  const Shared = window.AssistantShared || {};
  const getApiBase = Shared.getApiBase;
  const apiHeaders = Shared.apiHeaders;

  // === TTS 后端选择 ===
  // 'auto'：优先 Edge TTS（在线真人音色），失败回退到 Web Speech
  // 'edge'：强制使用 Edge TTS
  // 'web'：强制使用浏览器内置 TTS（离线/兜底）
  let _ttsBackend = 'auto';
  let _edgeTtsAvailable = null; // null = 未检测，true/false = 已检测

  // === 对话状态机 ===
  const State = {
    IDLE: 'idle',           // 待机（未启用持续对话）
    LISTENING: 'listening', // 正在录音
    THINKING: 'thinking',  // LLM 推理中
    SPEAKING: 'speaking',  // TTS 播报中
  };

  const Voice = {
    recognition: null,
    isListening: false,
    isSpeaking: false,
    state: State.IDLE,
    onStateChange: null,        // 状态变化回调
    onSpeechStart: null,
    onSpeechEnd: null,          // (aborted: boolean) => void
    onSegmentEnd: null,         // 浏览器自动结束一个识别片段，仍会继续收音
    onResult: null,             // (finalText: string) => void
    onError: null,              // (code: string) => void
    onInterimResult: null,      // (interim: string) => void
    onWakeWord: null,           // 唤醒词触发回调
    onTtsFallback: null,        // 神经语音不可用时通知界面（每轮只提示一次）
    // 配置
    bargeInEnabled: true,
    continuousMode: true,        // 持续对话模式（识别结束自动重启）
    wakeWordEnabled: false,     // 唤醒词开关（默认关闭，需用户显式开启）
    _abortedManually: false,
    _sendOnStop: true,
    _captureRequested: false,
    _recognitionStarted: false,
    _finishNotified: false,
    _stopTimer: null,
    _networkErrorCount: 0,
    _restartTimer: null,        // 自动重启的退避定时器
    _restartCount: 0,           // 连续重启次数（用于退避）
    lang: 'zh-CN',
    tone: 'male-warm',
    _voicesCache: null,
    _voicesLoaded: false,
    // VAD（Barge-in 用）
    _vadStream: null,
    _vadContext: null,
    _vadAnalyser: null,
    _vadRunning: false,
    // 唤醒词 VAD
    _wakeVadStream: null,
    _wakeVadContext: null,
    _wakeVadRunning: false,
    _lastWakeTime: 0,           // 上次唤醒时间戳（防误触）
    // TTS 队列（流式播报）
    _ttsQueue: [],
    _ttsPlaying: false,
    _currentAudio: null, // 当前正在播放的 Edge TTS audio 元素（用于 stopSpeaking）
    _interruptAudio: null, // 当前 Edge TTS promise 的中断器（pause 不触发 onended，需手动 resolve）
  };

  // === 状态管理 ===
  function setState(newState) {
    if (Voice.state === newState) return;
    Voice.state = newState;
    Voice.onStateChange?.(newState);
  }

  // === TTS Voice Selection ===
  function ensureVoicesLoaded() {
    if (Voice._voicesLoaded) return Promise.resolve(Voice._voicesCache || []);
    return new Promise((resolve) => {
      const voices = SpeechSynthesis?.getVoices?.() || [];
      if (voices.length) {
        Voice._voicesCache = voices;
        Voice._voicesLoaded = true;
        resolve(voices);
        return;
      }
      let settled = false;
      const handler = () => {
        if (settled) return;
        settled = true;
        Voice._voicesCache = SpeechSynthesis?.getVoices?.() || [];
        Voice._voicesLoaded = true;
        resolve(Voice._voicesCache);
      };
      try {
        SpeechSynthesis.addEventListener?.('voiceschanged', handler, { once: true });
      } catch {}
      setTimeout(handler, 1500); // 延长到 1500ms，某些 webview 慢
    });
  }

  function pickVoice() {
    if (!Voice._voicesCache || !Voice._voicesCache.length) return null;
    const langPrefix = (Voice.lang || 'zh-CN').split('-')[0];
    const candidates = Voice._voicesCache.filter(v =>
      v.lang?.toLowerCase().startsWith(langPrefix)
    );
    if (!candidates.length) return null;
    const femaleKeywords = /(female|woman|女|xiaoyi|yaoyao|huihui|tingting|zhiyu|yunxi)/i;
    const maleKeywords = /(male|man|男|yunyang|kangkang)/i;
    const wantFemale = Voice.tone === 'female-calm';
    const wantMale = Voice.tone === 'male-low' || Voice.tone === 'male-warm';
    if (wantFemale) {
      return candidates.find(v => femaleKeywords.test(v.name))
        || candidates.find(v => !maleKeywords.test(v.name))
        || candidates[0];
    }
    if (wantMale) {
      return candidates.find(v => maleKeywords.test(v.name))
        || candidates[0];
    }
    return candidates[0];
  }

  function toneToPitch(tone) {
    if (tone === 'male-low') return 0.75;
    if (tone === 'male-warm') return 1.0;
    if (tone === 'female-calm') return 1.08;
    return 1.0;
  }

  // === Speech Recognition (STT) ===
  function finishCapture(manual) {
    if (Voice._finishNotified) return;
    Voice._finishNotified = true;
    Voice._captureRequested = false;
    if (Voice._restartTimer) clearTimeout(Voice._restartTimer);
    if (Voice._stopTimer) clearTimeout(Voice._stopTimer);
    Voice._restartTimer = null;
    Voice._stopTimer = null;
    Voice.isListening = false;
    Voice._recognitionStarted = false;
    setState(State.IDLE);
    Voice.onSpeechEnd?.(manual);
  }

  function initRecognition() {
    if (!SpeechRecognition) return false;
    const rec = new SpeechRecognition();
    rec.lang = Voice.lang || 'zh-CN';
    rec.continuous = Voice.continuousMode; // 持续模式
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      Voice.isListening = true;
      setState(State.LISTENING);
      Voice.onSpeechStart?.();
    };

    rec.onend = () => {
      Voice.isListening = false;
      Voice._recognitionStarted = false;
      if (Voice._stopTimer) clearTimeout(Voice._stopTimer);
      Voice._stopTimer = null;
      const shouldRestart = Voice._captureRequested
        && Voice.continuousMode
        && Voice.state !== State.THINKING
        && Voice.state !== State.SPEAKING;
      setState(State.IDLE);
      if (shouldRestart) {
        Voice.onSegmentEnd?.();
        scheduleRestart();
      } else {
        finishCapture(Voice._abortedManually && Voice._sendOnStop);
      }
      Voice._abortedManually = false;
    };

    rec.onerror = (event) => {
      Voice.isListening = false;
      if (Voice._abortedManually) return;
      const raw = event?.error || 'unknown';
      let code = raw;
      if (raw === 'not-allowed' || raw === 'service-not-allowed') code = 'mic-blocked';
      else if (raw === 'aborted') code = 'aborted';
      else if (raw === 'no-speech') code = 'no-speech';
      else if (raw === 'network') code = 'network';
      if (code === 'network') Voice._networkErrorCount++;
      if (code !== 'aborted') {
        Voice.onError?.(code);
      }
      // 权限/设备故障不能通过重启修复；网络故障只有限次重试。
      if (!['no-speech', 'aborted', 'network'].includes(code) || Voice._networkErrorCount >= 3) {
        Voice._captureRequested = false;
        Voice._stopTimer = setTimeout(() => finishCapture(false), 1500);
      }
    };

    rec.onresult = (event) => {
      if (Voice._finishNotified) return;
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          final += transcript;
        } else {
          interim += transcript;
        }
      }
      if (interim) Voice.onInterimResult?.(interim);
      if (final) {
        Voice._restartCount = 0;
        Voice._networkErrorCount = 0;
        Voice.onResult?.(final.trim());
      }
    };

    Voice.recognition = rec;
    return true;
  }

  /**
   * 自动重启 STT，带退避策略
   * 避免浏览器 "too many calls" 限制
   */
  function scheduleRestart() {
    if (Voice._restartTimer) clearTimeout(Voice._restartTimer);
    Voice._restartCount++;
    // 退避：100ms, 200ms, 400ms, ... 最大 2000ms
    const delay = Math.min(100 * Math.pow(2, Voice._restartCount - 1), 2000);
    Voice._restartTimer = setTimeout(() => {
      Voice._restartTimer = null;
      if (Voice._captureRequested && Voice.continuousMode && Voice.state === State.IDLE) {
        try {
          Voice.recognition.lang = Voice.lang || 'zh-CN';
          Voice._recognitionStarted = true;
          Voice.recognition.start();
        } catch (e) {
          Voice._recognitionStarted = false;
          // 启动失败，再退避重试
          scheduleRestart();
        }
      }
    }, delay);
  }

  Voice.start = function () {
    if (!Voice.recognition && !initRecognition()) {
      Voice.onError?.('not-supported');
      return false;
    }
    if (Voice._captureRequested || Voice._recognitionStarted) return false;
    if (Voice._restartTimer) {
      clearTimeout(Voice._restartTimer);
      Voice._restartTimer = null;
    }
    Voice._captureRequested = true;
    Voice._abortedManually = false;
    Voice._sendOnStop = true;
    Voice._finishNotified = false;
    Voice._restartCount = 0;
    Voice._networkErrorCount = 0;
    if (Voice._ttsPlaying) {
      Voice.stopSpeaking();
      setState(State.IDLE);
    }
    try {
      Voice.recognition.lang = Voice.lang || 'zh-CN';
      Voice._recognitionStarted = true;
      Voice.recognition.start();
      return true;
    } catch (e) {
      // 已经在运行或者启动过快
      Voice.onError?.('start-failed');
      Voice._captureRequested = false;
      Voice._recognitionStarted = false;
      return false;
    }
  };

  Voice.stop = function (send = true) {
    Voice._captureRequested = false;
    Voice._abortedManually = true;
    Voice._sendOnStop = send;
    if (Voice._restartTimer) {
      clearTimeout(Voice._restartTimer);
      Voice._restartTimer = null;
    }
    if (Voice._recognitionStarted && Voice.recognition) {
      try {
        Voice.recognition.stop();
        if (!Voice._finishNotified) Voice._stopTimer = setTimeout(() => finishCapture(send), 1500);
      } catch { finishCapture(send); }
    } else {
      finishCapture(send);
    }
  };

  Voice.isSupported = function () {
    return !!SpeechRecognition;
  };

  Voice.isCapturing = function () {
    return Voice._captureRequested;
  };

  Voice.setContinuousMode = function (enabled) {
    Voice.continuousMode = enabled;
    if (Voice.recognition) {
      Voice.recognition.continuous = enabled;
    }
  };

  Voice.setState = function (newState) {
    setState(newState);
  };

  // === Speech Synthesis (TTS) — 流式队列 ===
  /**
   * 将长文本按句子切分（句号、感叹号、问号、换行）
   * 注意：不能预先合并所有空白，否则换行被吃掉无法切分
   */
  function splitSentences(text) {
    return text
      .replace(/[ \t]+/g, ' ')  // 仅合并空格和制表符，保留换行
      .split(/(?<=[。！？!?\n])/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }

  /**
   * 流式 TTS：把文本切句后入队，逐句播报
   * 支持中途打断（stopSpeaking 清空队列）
   */
  Voice.speak = async function (text, options = {}) {
    if (!SpeechSynthesis) return;
    // 切句入队
    const sentences = splitSentences(text);
    for (const s of sentences) {
      Voice._ttsQueue.push({ text: s, options });
    }
    // 如果没在播，启动播报循环
    if (!Voice._ttsPlaying) {
      playTtsQueue();
    }
  };

  /**
   * 检查 Edge TTS 是否可用（首次调用时检测，结果缓存）
   * 失败/不可用时返回 false，前端会回退到 Web Speech API
   */
  async function checkEdgeTtsAvailable() {
    if (_edgeTtsAvailable !== null) return _edgeTtsAvailable;
    if (!getApiBase || !apiHeaders) { _edgeTtsAvailable = false; return false; }
    try {
      const r = await fetch(`${getApiBase()}/api/tts/status`, { headers: apiHeaders() });
      if (!r.ok) { _edgeTtsAvailable = false; return false; }
      const data = await r.json();
      _edgeTtsAvailable = !!data.available;
    } catch {
      _edgeTtsAvailable = false;
    }
    return _edgeTtsAvailable;
  }

  /**
   * 调用 Node 后端 Edge TTS 合成单句并播放
   * @returns {Promise<void>} 播放完成时 resolve，失败时 reject
   */
  async function playWithEdgeTts(text, options) {
    if (!getApiBase || !apiHeaders) throw new Error('api not available');
    const r = await fetch(`${getApiBase()}/api/tts/synthesize`, {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        text,
        tone: Voice.tone || 'male-low',
        lang: options.lang || Voice.lang || 'zh-CN',
        rate: options.rate,
        pitch: options.pitch,
      }),
    });
    if (!r.ok) throw new Error(`tts http ${r.status}`);
    const blob = await r.blob();
    if (!blob.size) throw new Error('empty audio');
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.volume = Math.min(1, Math.max(0, options.volume ?? 1));
    Voice._currentAudio = audio; // 让 stopSpeaking 能停掉
    // 播放失败时（autoplay 限制等）抛错，由调用方回退
    try {
      await audio.play();
    } catch (e) {
      URL.revokeObjectURL(url);
      Voice._currentAudio = null;
      throw e;
    }
    return new Promise((resolve, reject) => {
      // HTMLAudioElement 的 onended 只在自然播完时触发，pause() 不会触发。
      // 因此 stopSpeaking/skipCurrent 必须通过 _interruptAudio 手动 resolve，
      // 否则播放循环会永远卡在这一句（Bug 3 修复）。
      const done = () => {
        URL.revokeObjectURL(url);
        Voice._currentAudio = null;
        if (Voice._interruptAudio === interrupt) Voice._interruptAudio = null;
        resolve();
      };
      const interrupt = () => done();
      Voice._interruptAudio = interrupt;
      audio.onended = done;
      audio.onerror = (e) => {
        URL.revokeObjectURL(url);
        Voice._currentAudio = null;
        if (Voice._interruptAudio === interrupt) Voice._interruptAudio = null;
        reject(new Error('audio error'));
      };
    });
  }

  /**
   * 用 Web Speech API 播放单句（fallback 路径）
   */
  function playWithWebSpeech(text, options) {
    return new Promise((resolve, reject) => {
      if (!SpeechSynthesis) { reject(new Error('no speech synthesis')); return; }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = options.lang || (/[\u3400-\u9fff]/.test(text) ? 'zh-CN' : 'en-US');
      const voice = pickVoice();
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      }
      utterance.rate = options.rate ?? 0.95;
      utterance.volume = options.volume ?? 1;
      utterance.pitch = options.pitch ?? toneToPitch(Voice.tone);
      utterance.onend = () => resolve();
      utterance.onerror = () => reject(new Error('speech synthesis error'));
      SpeechSynthesis.speak(utterance);
    });
  }

  async function playTtsQueue() {
    if (Voice._ttsQueue.length === 0) {
      Voice._ttsPlaying = false;
      setState(State.IDLE);
      return;
    }
    Voice._ttsPlaying = true;
    setState(State.SPEAKING);

    const item = Voice._ttsQueue.shift();

    // TTS 开始时启动 VAD 监听 barge-in（无论哪个后端）
    if (Voice.bargeInEnabled) {
      startBargeInVAD();
    }
    item.options.onStart?.();

    let played = false;
    // 优先尝试 Edge TTS（除非强制用 web）
    if (_ttsBackend !== 'web' && _edgeTtsAvailable !== false) {
      if (_edgeTtsAvailable === null) {
        await checkEdgeTtsAvailable();
      }
      if (_edgeTtsAvailable) {
        try {
          await playWithEdgeTts(item.text, item.options);
          played = true;
        } catch (e) {
          // Edge TTS 失败 — 标记不可用，后续直接走 Web Speech
          _edgeTtsAvailable = false;
        }
      }
    }

    // Web Speech API fallback
    if (!played && SpeechSynthesis) {
      if (_ttsBackend !== 'web' && !Voice._fallbackNotified) {
        Voice._fallbackNotified = true;
        Voice.onTtsFallback?.();
      }
      if (!Voice._voicesLoaded) await ensureVoicesLoaded();
      try {
        await playWithWebSpeech(item.text, item.options);
        played = true;
      } catch (e) {
        // Web Speech 也失败 — 静默跳过这句
      }
    }

    // 处理下一句（与原 onend 逻辑一致）
    if (Voice._ttsQueue.length > 0 && Voice.state === State.SPEAKING) {
      playTtsQueue();
    } else {
      Voice._ttsPlaying = false;
      Voice._fallbackNotified = false;
      // 若 state 已被外部改变（barge-in/cancel 等已切到 listening/idle），
      // 不要再覆盖——否则会把 triggerBargeIn 刚设置的 LISTENING 打回 IDLE（Bug 4 修复）
      if (Voice.state === State.SPEAKING) {
        // 持续模式下 TTS 结束后自动恢复 listening
        if (Voice._captureRequested && Voice.continuousMode) {
          setState(State.IDLE);
          // 自动重启 STT（如果之前在 listening 状态被打断）
          if (!Voice.isListening) {
            Voice.start();
          }
        } else {
          setState(State.IDLE);
        }
      }
      item.options.onEnd?.();
    }
  }

  Voice.stopSpeaking = function () {
    Voice._fallbackNotified = false;
    if (SpeechSynthesis) {
      try { SpeechSynthesis.cancel(); } catch {}
    }
    // 唤醒正在播放的 Edge TTS promise（pause 不触发 onended）
    if (Voice._interruptAudio) {
      try { Voice._interruptAudio(); } catch {}
      Voice._interruptAudio = null;
    }
    // 停掉 Edge TTS 正在播放的 audio（此时 promise 已由中断器 resolve）
    if (Voice._currentAudio) {
      try { Voice._currentAudio.pause(); Voice._currentAudio.src = ''; } catch {}
      Voice._currentAudio = null;
    }
    Voice._ttsQueue = []; // 清空队列
    Voice._ttsPlaying = false;
    Voice.isSpeaking = false;
    stopBargeInVAD();
  };

  /**
   * 跳过当前 TTS（不清空队列，继续播下一句）
   * 用户点 Esc 或点角色时调用
   */
  Voice.skipCurrent = function () {
    if (SpeechSynthesis) {
      try { SpeechSynthesis.cancel(); } catch {}
    }
    // 唤醒 Edge TTS 的 pending promise，让队列续播下一句（Bug 3 修复）
    if (Voice._interruptAudio) {
      try { Voice._interruptAudio(); } catch {}
      Voice._interruptAudio = null;
    }
    // 停掉 Edge TTS audio，让 playWithEdgeTts 的 promise resolve，触发下一句
    if (Voice._currentAudio) {
      try { Voice._currentAudio.pause(); } catch {}
    }
    // 不清空队列，让 onend 触发播下一句
  };

  // === Barge-in VAD（TTS 期间监听用户开口）===
  async function startBargeInVAD() {
    if (Voice._vadRunning) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);
      Voice._vadStream = stream;
      Voice._vadContext = audioContext;
      Voice._vadAnalyser = analyser;
      Voice._vadRunning = true;
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      let speechFrames = 0;
      function check() {
        if (!Voice._vadRunning) return;
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        // 能量阈值 35（经验值，高于环境噪声）
        if (avg > 35) {
          speechFrames++;
          // 连续 3 帧检测到说话（约 50ms）才触发，避免误报
          if (speechFrames >= 3) {
            triggerBargeIn();
            return;
          }
        } else {
          speechFrames = 0;
        }
        requestAnimationFrame(check);
      }
      requestAnimationFrame(check);
    } catch (e) {
      // 麦克风不可用，barge-in 静默失效
    }
  }

  function stopBargeInVAD() {
    Voice._vadRunning = false;
    if (Voice._vadStream) {
      Voice._vadStream.getTracks().forEach(t => t.stop());
      Voice._vadStream = null;
    }
    if (Voice._vadContext) {
      try { Voice._vadContext.close(); } catch {}
      Voice._vadContext = null;
    }
    Voice._vadAnalyser = null;
  }

  function triggerBargeIn() {
    // 停止 TTS
    Voice.stopSpeaking();
    setState(State.LISTENING);
    // 启动 STT（如果不在运行）
    if (!Voice.isListening) {
      Voice.start();
    }
  }

  // === 唤醒词检测（能量 + 关键词匹配）===
  /**
   * 启动唤醒词监听：用 VAD 检测说话，然后 STT 短暂识别是否包含唤醒词
   * 检测到唤醒词后触发 onWakeWord 回调
   */
  Voice.startWakeWordDetection = async function () {
    if (!Voice.wakeWordEnabled) return;
    if (Voice._wakeVadRunning) return;
    if (!SpeechRecognition) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      Voice._wakeVadStream = stream;
      Voice._wakeVadContext = audioContext;
      Voice._wakeVadRunning = true;
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      let speechFrames = 0;
      let silenceFrames = 0;
      let wasSpeaking = false;
      function check() {
        if (!Voice._wakeVadRunning) return;
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        if (avg > 30) {
          speechFrames++;
          if (speechFrames >= 5 && !wasSpeaking) { // 约 80ms 持续说话
            wasSpeaking = true;
            silenceFrames = 0;
            tryWakeWordMatch();
          }
        } else if (wasSpeaking) {
          silenceFrames++;
          if (silenceFrames > 30) { // 约 500ms 静默
            wasSpeaking = false;
            speechFrames = 0;
          }
        } else {
          speechFrames = 0;
        }
        requestAnimationFrame(check);
      }
      requestAnimationFrame(check);
    } catch (e) {
      // 麦克风不可用
    }
  };

  Voice.stopWakeWordDetection = function () {
    Voice._wakeVadRunning = false;
    if (Voice._wakeVadStream) {
      Voice._wakeVadStream.getTracks().forEach(t => t.stop());
      Voice._wakeVadStream = null;
    }
    if (Voice._wakeVadContext) {
      try { Voice._wakeVadContext.close(); } catch {}
      Voice._wakeVadContext = null;
    }
  };

  /**
   * 短暂启动 STT 检测唤醒词
   */
  function tryWakeWordMatch() {
    // 防抖：10 秒内只触发一次
    const now = Date.now();
    if (now - Voice._lastWakeTime < 10000) return;
    // 如果已经在 listening（用户主动开启），不触发
    if (Voice.isListening || Voice.state === State.THINKING || Voice.state === State.SPEAKING) return;
    // 创建临时识别器
    if (!SpeechRecognition) return;
    const tempRec = new SpeechRecognition();
    tempRec.lang = Voice.lang || 'zh-CN';
    tempRec.continuous = false;
    tempRec.interimResults = false;
    tempRec.maxAlternatives = 1;
    let settled = false;
    tempRec.onresult = (event) => {
      if (settled) return;
      settled = true;
      const transcript = event.results[0]?.[0]?.transcript?.toLowerCase() || '';
      // 唤醒词：小伴 / 你好 / hey / jarvis / 伙计
      const wakeWords = ['小伴', '你好', 'hey', 'jarvis', '贾维斯', '嘿', 'hi', '你好小伴'];
      if (wakeWords.some(w => transcript.includes(w.toLowerCase()))) {
        Voice._lastWakeTime = now;
        Voice.onWakeWord?.(transcript);
      }
      try { tempRec.stop(); } catch {}
    };
    tempRec.onerror = () => {
      if (settled) return;
      settled = true;
    };
    tempRec.onend = () => {
      if (settled) return;
      settled = true;
    };
    try {
      tempRec.start();
      // 2 秒超时
      setTimeout(() => {
        if (!settled) {
          settled = true;
          try { tempRec.stop(); } catch {}
        }
      }, 2000);
    } catch {}
  }

  Voice.enableBargeIn = function (enabled) {
    Voice.bargeInEnabled = enabled;
    if (!enabled) stopBargeInVAD();
  };

  Voice.preloadVoices = function () {
    if (SpeechSynthesis) {
      ensureVoicesLoaded().catch(() => {});
    }
  };

  /**
   * 切换 TTS 后端
   * @param {'auto'|'edge'|'web'} backend
   * - 'auto'：优先 Edge TTS，失败回退到 Web Speech
   * - 'edge'：强制 Edge TTS（不可用时报错）
   * - 'web'：强制 Web Speech API
   */
  Voice.setTtsBackend = function (backend) {
    if (backend === 'auto' || backend === 'edge' || backend === 'web') {
      _ttsBackend = backend;
      // 切换到 edge 时重置检测缓存，重新探测
      if (backend === 'edge') _edgeTtsAvailable = null;
    }
  };

  Voice.getTtsBackend = function () {
    return _ttsBackend;
  };

  /**
   * 主动探测 Edge TTS 可用性（应用启动时调用一次）
   */
  Voice.checkTtsAvailable = function () {
    return checkEdgeTtsAvailable();
  };

  window.VoiceModule = Voice;
  window.VoiceState = State;
})();
