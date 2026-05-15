class Live2DRenderer {
  constructor(canvas, runtime, emotion, createFallback) {
    this.canvas = canvas;
    this.runtime = runtime;
    this.emotion = emotion;
    this._fallback = createFallback();
    this._ready = false;
    this._init();
  }

  static isAvailable() {
    return Boolean(window.Live2DCubismCore && window.RAG_PET_LIVE2D_MODEL);
  }

  async _init() {
    try {
      const modelName = window.RAG_PET_LIVE2D_MODEL;
      const manifestUrl = `assets/live2d/${modelName}/model3.json`;
      const res = await fetch(manifestUrl);
      if (!res.ok) throw new Error(`Live2D model not found: ${manifestUrl}`);
      this.modelManifest = await res.json();
      console.info('[Live2DRenderer] Live2D SDK detected, model manifest loaded. Sprite fallback remains active until Cubism binding is implemented.', this.modelManifest);
      this._ready = false;
    } catch (error) {
      console.info('[Live2DRenderer] Falling back to sprite renderer:', error.message);
      this._ready = false;
    }
  }

  setFacing(dir) {
    this._fallback?.setFacing?.(dir);
  }

  onStateChange() {
    this._fallback?.onStateChange?.();
  }

  resize(width, height) {
    if (this.canvas) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  destroy() {
    this._fallback?.destroy?.();
  }
}

window.Live2DRenderer = Live2DRenderer;
