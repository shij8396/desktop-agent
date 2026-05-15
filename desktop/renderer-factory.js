const RENDERER_BACKENDS = {
  sprite: 'sprite',
  live2d: 'live2d',
  rive: 'rive',
  image: 'image',
};

function createRenderer(backend, canvas, runtime, emotion, spriteManager) {
  if (backend === RENDERER_BACKENDS.live2d && window.Live2DRenderer?.isAvailable?.()) {
    return new Live2DRenderer(canvas, runtime, emotion, () => new SpriteRenderer(canvas, runtime, emotion, spriteManager));
  }
  return new SpriteRenderer(canvas, runtime, emotion, spriteManager);
}

function detectBestRenderer() {
  if (window.Live2DRenderer?.isAvailable?.()) return RENDERER_BACKENDS.live2d;
  if (typeof rive !== 'undefined') return RENDERER_BACKENDS.rive;
  return RENDERER_BACKENDS.sprite;
}

window.RENDERER_BACKENDS = RENDERER_BACKENDS;
window.createRenderer = createRenderer;
window.detectBestRenderer = detectBestRenderer;
