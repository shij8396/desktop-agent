// ===== Sprite Manager — Loads and manages sprite frames per state =====

/**
 * Manages a single animation sequence (one state).
 * Frames are Image objects pre-loaded from SVG strings or image URLs.
 */
class SpriteSheet {
  constructor(name, frames, fps = 8) {
    this.name = name;
    this.frames = frames;   // Image[]
    this.fps = fps;
    this.frameDuration = 1000 / fps;
  }

  get frameCount() { return this.frames.length; }

  /** Get the frame index for a given elapsed time (ms) */
  frameIndex(elapsedMs) {
    if (this.frames.length <= 1) return 0;
    return Math.floor(elapsedMs / this.frameDuration) % this.frames.length;
  }

  /** Get the current frame Image */
  getFrame(elapsedMs) {
    return this.frames[this.frameIndex(elapsedMs)] || null;
  }
}

/**
 * Central sprite manager — registers state animations and provides frames.
 * Supports both SVG-to-Image conversion and direct Image loading.
 */
class SpriteManager {
  constructor() {
    this._sheets = {};           // state -> SpriteSheet
    this._loaded = false;
    this._loadPromise = null;
  }

  /** Register a state with SVG frame strings */
  registerState(stateName, svgFrames, fps = 8) {
    const images = svgFrames.map(svg => this._svgToImage(svg));
    this._sheets[stateName] = new SpriteSheet(stateName, images, fps);
  }

  /** Preload all registered frames — returns a Promise */
  async preloadAll() {
    if (this._loadPromise) return this._loadPromise;

    const allImages = [];
    for (const sheet of Object.values(this._sheets)) {
      allImages.push(...sheet.frames);
    }

    this._loadPromise = Promise.all(
      allImages.map(img => {
        if (img.complete) return Promise.resolve();
        return new Promise((resolve) => {
          img.onload = resolve;
          img.onerror = () => {
            console.warn(`[SpriteManager] Failed to load image`);
            resolve(); // don't block on error
          };
        });
      })
    ).then(() => {
      this._loaded = true;
    });

    return this._loadPromise;
  }

  /** Get the SpriteSheet for a state */
  getSheet(stateName) {
    return this._sheets[stateName] || this._sheets['idle'] || null;
  }

  /** Get the current frame Image for a state at elapsed time */
  getFrame(stateName, elapsedMs) {
    const sheet = this.getSheet(stateName);
    return sheet ? sheet.getFrame(elapsedMs) : null;
  }

  /** Check if a state has a registered sheet */
  hasState(stateName) {
    return !!this._sheets[stateName];
  }

  get isLoaded() { return this._loaded; }

  /** Convert an SVG string to an Image object */
  _svgToImage(svgString) {
    const blob = new Blob([svgString], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    // Note: blob URLs are kept alive for the lifetime of the app
    // In a desktop app this is fine; for web apps you'd want to revoke after load
    return img;
  }
}

window.SpriteManager = SpriteManager;
window.SpriteSheet = SpriteSheet;
