const STATES = {
  idle: { label: '待机', category: 'relaxed', autoReturn: false },
  walk: { label: '行走', category: 'movement', autoReturn: false },
  patrol: { label: '巡游', category: 'movement', autoReturn: false },
  observe: { label: '观察', category: 'curious', autoReturn: true, timeout: 3000 },
  approach: { label: '靠近', category: 'movement', autoReturn: false },
  think: { label: '思考', category: 'active', autoReturn: false },
  speak: { label: '说话', category: 'active', autoReturn: false },
  alert: { label: '提醒', category: 'active', autoReturn: true, timeout: 2500 },
  sleep: { label: '休眠', category: 'relaxed', autoReturn: false },
  happy: { label: '开心', category: 'emotion', autoReturn: true, timeout: 2200 },
  sad: { label: '难过', category: 'emotion', autoReturn: true, timeout: 3000 },
  curious: { label: '好奇', category: 'emotion', autoReturn: true, timeout: 2500 },
  angry: { label: '生气', category: 'emotion', autoReturn: true, timeout: 2000 },
};

const TRANSITIONS = {
  idle: ['walk', 'patrol', 'observe', 'approach', 'think', 'speak', 'sleep', 'happy', 'sad', 'curious', 'angry', 'alert'],
  walk: ['idle', 'observe', 'approach', 'think', 'speak', 'sleep', 'happy', 'sad', 'curious', 'angry', 'alert'],
  patrol: ['idle', 'walk', 'observe', 'approach', 'think', 'speak', 'sleep', 'happy', 'sad', 'curious', 'angry', 'alert'],
  observe: ['idle', 'walk', 'patrol', 'approach', 'think', 'speak'],
  approach: ['idle', 'think', 'speak', 'observe'],
  think: ['idle', 'speak', 'happy', 'sad', 'curious'],
  speak: ['idle', 'think', 'happy', 'sad', 'curious', 'angry'],
  alert: ['idle', 'walk', 'patrol', 'observe', 'think', 'speak'],
  sleep: ['idle', 'alert'],
  happy: ['idle', 'walk', 'patrol', 'speak'],
  sad: ['idle', 'walk', 'sleep'],
  curious: ['idle', 'walk', 'observe', 'think'],
  angry: ['idle', 'walk'],
};

class CharacterRuntime {
  constructor() {
    this.state = 'idle';
    this.prevState = 'idle';
    this.stateTime = 0;
    this.stateStartTime = Date.now();
    this.idleSec = 0;
    this._listeners = {};
    this._timers = [];
    this._tickInterval = null;
    this._running = false;
  }

  start() {
    this._running = true;
    this._tickInterval = setInterval(() => this._tick(), 1000);
    this.emit('start');
  }

  destroy() {
    this._running = false;
    clearInterval(this._tickInterval);
    this._timers.forEach(clearTimeout);
    this._timers = [];
    this._listeners = {};
  }

  setState(newState) {
    if (newState === this.state) return;
    if (!STATES[newState]) {
      console.warn(`[CharacterRuntime] Unknown state: ${newState}`);
      return;
    }
    const allowed = TRANSITIONS[this.state];
    if (allowed && !allowed.includes(newState)) {
      console.debug(`[CharacterRuntime] Unusual transition: ${this.state} -> ${newState}`);
    }

    this.prevState = this.state;
    this.state = newState;
    this.idleSec = 0;
    this.stateStartTime = Date.now();

    const def = STATES[newState];
    if (def.autoReturn && def.timeout) {
      this._setTimeout(() => {
        if (this.state === newState) this.setState('idle');
      }, def.timeout);
    }

    this.emit('stateChange', { from: this.prevState, to: newState });
  }

  onThinking() { this.setState('think'); }
  onSpeaking() { this.setState('speak'); }
  onIdle() { this.setState('idle'); }
  onHappy() { this.setState('happy'); }
  onSad() { this.setState('sad'); }
  onCurious() { this.setState('curious'); }
  onAngry() { this.setState('angry'); }
  onSleep() { this.setState('sleep'); }
  onAlert() { this.setState('alert'); }

  onRespond(text) {
    if (!text) {
      this.onIdle();
      return;
    }
    const value = text.toLowerCase();
    if (/错误|失败|抱歉|sorry|error|fail|无法|超时/.test(value)) this.onSad();
    else if (/找到|成功|完成|great|excellent|完美/.test(value)) this.onHappy();
    else if (/搜索|查询|查找|让我|看看/.test(value)) this.onCurious();
    else this.onHappy();
  }

  requestWalk() {
    if (['idle', 'sleep', 'observe'].includes(this.state)) {
      this.setState('walk');
      return true;
    }
    return false;
  }

  requestApproach() {
    if (['idle', 'walk', 'patrol', 'observe'].includes(this.state)) {
      this.setState('approach');
      return true;
    }
    return false;
  }

  get stateDef() { return STATES[this.state]; }
  get isMoving() { return ['walk', 'patrol', 'approach'].includes(this.state); }
  get isActive() { return ['think', 'speak', 'alert'].includes(this.state); }
  get isEmotion() { return ['happy', 'sad', 'curious', 'angry'].includes(this.state); }
  get isRelaxed() { return ['idle', 'sleep', 'observe'].includes(this.state); }

  on(event, fn) {
    (this._listeners[event] ??= []).push(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    const arr = this._listeners[event];
    if (arr) this._listeners[event] = arr.filter(f => f !== fn);
  }

  emit(event, data) {
    for (const fn of (this._listeners[event] || [])) {
      try { fn(data); } catch (error) { console.error('[CharacterRuntime] Event handler error:', error); }
    }
  }

  _tick() {
    if (!this._running) return;
    this.idleSec++;
    this.stateTime = Date.now() - this.stateStartTime;
    this.emit('tick', { state: this.state, idleSec: this.idleSec });
  }

  _setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    this._timers.push(timer);
    return timer;
  }
}

window.CharacterRuntime = CharacterRuntime;
window.CHARACTER_STATES = STATES;
