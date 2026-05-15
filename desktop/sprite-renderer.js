// ===== Sprite Renderer — Renders sprites from SpriteManager onto Canvas =====
// Replaces the old pet-engine.js character drawing with sprite-based rendering.
// Keeps particle effects and adds smooth transitions.

class SpriteRenderer {
  constructor(canvas, runtime, emotion, spriteManager) {
    this.c = canvas;
    this.x = canvas.getContext('2d');
    this.w = canvas.width;
    this.h = canvas.height;
    this.runtime = runtime;
    this.emotion = emotion;
    this.sprites = spriteManager;

    // Timing
    this.t = 0;                    // total elapsed seconds
    this.stateStartTime = Date.now();
    this._running = true;

    // Visual state
    this.facing = 1;               // 1 = right, -1 = left
    this.jump = 0;
    this.breathe = 0;

    // Effects
    this.fx = [];                  // floating emoji effects
    this.particles = [];           // particle system

    // Start render loop
    this._loop();
    this._emotionInterval = setInterval(() => {
      if (this.emotion) this.emotion.decay();
    }, 2000);
  }

  destroy() {
    this._running = false;
    clearInterval(this._emotionInterval);
    this.particles = [];
    this.fx = [];
  }

  setFacing(dir) {
    this.facing = dir;
  }

  // ── Render Loop ─────────────────────────────────────────────────────────

  _loop() {
    if (!this._running) return;
    this.t += 0.016;
    this._physics();
    this._render();
    requestAnimationFrame(() => this._loop());
  }

  _physics() {
    // Particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy -= 0.03;
      p.life -= 0.012;
      if (p.life <= 0) this.particles.splice(i, 1);
    }
    // Floating effects
    this.fx = this.fx.filter(f => (f.life -= 0.048) > 0);

    // State-based physics
    const s = this.runtime.state;
    const t = this.t;

    if (s === 'idle') {
      this.breathe = Math.sin(t * 1.5) * 2;
      this.jump = 0;
      if (this.runtime.idleSec % 5 === 0 && Math.random() < 0.1) {
        // occasional blink handled by sprite frame
      }
    } else if (s === 'walk' || s === 'patrol' || s === 'approach') {
      const speed = this.emotion ? this.emotion.moveSpeed : 1;
      this.breathe = Math.sin(t * 3 * speed) * 3;
      this.jump = Math.abs(Math.sin(t * 4 * speed)) * 4;
    } else if (s === 'observe') {
      this.breathe = Math.sin(t * 1.8) * 1.5;
      this.jump = 0;
    } else if (s === 'think') {
      this.breathe = Math.sin(t * 2) * 1;
      this.jump = 0;
    } else if (s === 'speak') {
      this.breathe = Math.sin(t * 4) * 1.5;
      this.jump = Math.sin(t * 5) * 1.5;
    } else if (s === 'sleep') {
      this.breathe = Math.sin(t * 0.7) * 3.5;
      this.jump = 0;
      if (this.runtime.idleSec % 5 === 0 && Math.random() < 0.3) {
        this._addFx('💤', 50 + Math.random() * 10, -15);
      }
    } else if (s === 'happy') {
      this.jump = Math.abs(Math.sin(t * 7)) * 16;
      this.breathe = 0;
      if (Math.random() < 0.15) this._spawnParticle('💖', -20, -50);
      if (Math.random() < 0.1) this._spawnParticle('✨', 20, -40);
    } else if (s === 'sad') {
      this.breathe = Math.min(this.breathe + 0.05, 8);
      this.jump = 0;
    } else if (s === 'angry') {
      this.breathe = Math.sin(t * 5) * 2;
      this.jump = Math.sin(t * 4) * 1.5;
    } else if (s === 'curious') {
      this.breathe = Math.sin(t * 1.8) * 1.5;
      this.jump = 0;
    } else if (s === 'alert') {
      this.breathe = Math.sin(t * 3) * 1;
      this.jump = 0;
    }
  }

  _render() {
    const x = this.x;
    x.clearRect(0, 0, this.w, this.h);

    const state = this.runtime.state;
    const elapsedMs = Date.now() - this.stateStartTime;

    // Get current sprite frame
    const frame = this.sprites.getFrame(state, elapsedMs);

    if (frame && frame.complete && frame.naturalWidth > 0) {
      // Apply breathing/jump vertical offset
      const drawY = -this.breathe - this.jump;

      x.save();

      // Apply facing direction (horizontal flip from center)
      if (this.facing === -1) {
        x.translate(this.w / 2, 0);
        x.scale(-1, 1);
        x.translate(-this.w / 2, 0);
      }

      // Draw the sprite frame (1:1 with canvas)
      x.drawImage(frame, 0, drawY, this.w, this.h);
      x.restore();
    } else {
      // Fallback: draw a placeholder circle while sprites load
      x.save();
      x.fillStyle = 'rgba(200,200,200,0.3)';
      x.beginPath();
      x.arc(this.w / 2, this.h / 2, 30, 0, Math.PI * 2);
      x.fill();
      x.fillStyle = 'rgba(150,150,150,0.5)';
      x.font = '11px sans-serif';
      x.textAlign = 'center';
      x.fillText('Loading...', this.w / 2, this.h / 2 + 4);
      x.restore();
    }

    // Draw floating effects
    x.font = '13px sans-serif';
    x.textAlign = 'center';
    const cx = this.w / 2;
    const headY = this.h * 0.35;
    for (const ef of this.fx) {
      x.globalAlpha = ef.life;
      x.fillText(ef.emoji, cx + ef.dx, headY + ef.dy);
    }
    x.globalAlpha = 1;

    // Draw particles
    x.font = '10px sans-serif';
    for (const pt of this.particles) {
      x.globalAlpha = pt.life;
      x.fillText(pt.emoji, cx + pt.dx + pt.x, headY + pt.dy + pt.y);
    }
    x.globalAlpha = 1;
  }

  // ── State Change Handler ────────────────────────────────────────────────

  onStateChange() {
    this.stateStartTime = Date.now();
  }

  // ── Effect Helpers ──────────────────────────────────────────────────────

  _addFx(emoji, dx, dy) {
    if (this.fx.length < 5) {
      this.fx.push({ emoji, dx, dy, life: 1 });
    }
  }

  _spawnParticle(emoji, dx, dy) {
    this.particles.push({
      emoji, dx, dy,
      x: 0, y: 0,
      vx: (Math.random() - 0.5) * 1.5,
      vy: -Math.random() * 2 - 0.5,
      life: 1,
    });
  }
}

window.SpriteRenderer = SpriteRenderer;
