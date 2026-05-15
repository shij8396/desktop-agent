const EMOTIONS = {
  neutral: { decay: 0, color: '#fff', moveSpeed: 1.0, label: '平静' },
  happy: { decay: 0.02, color: '#ff6b6b', moveSpeed: 1.3, label: '开心' },
  sad: { decay: 0.015, color: '#74b9ff', moveSpeed: 0.7, label: '难过' },
  curious: { decay: 0.025, color: '#fdcb6e', moveSpeed: 1.1, label: '好奇' },
  angry: { decay: 0.01, color: '#e17055', moveSpeed: 1.4, label: '警觉' },
};

class EmotionState {
  constructor() {
    this._intensities = { neutral: 1, happy: 0, sad: 0, curious: 0, angry: 0 };
    this._dominant = 'neutral';
  }

  get dominant() { return this._dominant; }
  intensity(emotion) { return this._intensities[emotion] || 0; }

  get moveSpeed() {
    return EMOTIONS[this._dominant]?.moveSpeed || 1.0;
  }

  get color() {
    return EMOTIONS[this._dominant]?.color || '#fff';
  }

  boost(emotion, amount = 0.6) {
    if (!EMOTIONS[emotion]) return;
    this._intensities[emotion] = Math.min(1, this._intensities[emotion] + amount);
    for (const key of Object.keys(this._intensities)) {
      if (key !== emotion && key !== 'neutral') {
        this._intensities[key] = Math.max(0, this._intensities[key] - amount * 0.2);
      }
    }
    this._recalcDominant();
  }

  set(emotion) {
    if (!EMOTIONS[emotion]) return;
    for (const key of Object.keys(this._intensities)) {
      this._intensities[key] = key === emotion ? 0.8 : 0;
    }
    this._intensities.neutral = emotion === 'neutral' ? 1 : 0;
    this._recalcDominant();
  }

  decay() {
    for (const [key, def] of Object.entries(EMOTIONS)) {
      if (key === 'neutral') continue;
      this._intensities[key] = Math.max(0, this._intensities[key] - def.decay);
    }
    const total = Object.values(this._intensities).reduce((sum, value) => sum + value, 0);
    this._intensities.neutral = total > 0 ? Math.max(0, 1 - total + this._intensities.neutral) : 1;
    this._recalcDominant();
  }

  handleEvent(event) {
    switch (event) {
      case 'query_start': this.boost('curious', 0.5); break;
      case 'query_success': this.boost('happy', 0.6); break;
      case 'query_error': this.boost('sad', 0.7); break;
      case 'search_start': this.boost('curious', 0.4); break;
      case 'search_fail': this.boost('sad', 0.3); break;
      case 'user_greet': this.boost('happy', 0.5); break;
      case 'long_idle': this.set('neutral'); break;
      case 'alert': this.boost('angry', 0.3); break;
      case 'tool_use': this.boost('curious', 0.3); break;
    }
  }

  _recalcDominant() {
    let max = 0;
    let dominant = 'neutral';
    for (const [key, value] of Object.entries(this._intensities)) {
      if (value > max) {
        max = value;
        dominant = key;
      }
    }
    this._dominant = max > 0.1 ? dominant : 'neutral';
  }
}

window.EmotionState = EmotionState;
