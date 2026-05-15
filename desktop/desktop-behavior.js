// ===== Desktop Behavior Engine =====
// Manages the pet's position on the desktop and autonomous movement decisions.
// Supports both in-window movement (legacy) and real desktop window movement (Tauri).

class DesktopBehavior {
  constructor(runtime) {
    this.runtime = runtime;

    // Desktop bounds
    this.desktop = { x: 0, y: 0, width: 1920, height: 1040 };

    // Character position (world coords, top-left origin)
    this.pos = { x: 400, y: 600 };
    this.target = null;
    this.speed = 1.5;             // base pixels per frame at 60fps
    this.facing = 1;
    this.petRenderer = null;

    // Movement quality
    this._moveProgress = 0;       // 0-1 progress toward target
    this._startPos = null;        // position when current move started
    this._curveAmplitude = 0;     // sine wave amplitude for walk curves
    this._curveFrequency = 0;     // sine wave frequency
    this._curvePhase = 0;         // current phase

    // Behavior config
    this._patrolCooldown = 0;
    this._idleBeforePatrol = 8;
    this._idleBeforeSleep = 120;
    this._chatArea = null;
    this._approachingChat = false;
    this._running = false;
    this._userTyping = false;

    // Pause timing
    this._pauseTimer = 0;

    // Boundaries
    this.margin = { top: 30, bottom: 80, left: 20, right: 20 };
  }

  start() {
    this._running = true;
    this._unsubTick = this.runtime.on('tick', (data) => this._onTick(data));
    this._unsubState = this.runtime.on('stateChange', (data) => this._onStateChange(data));
  }

  destroy() {
    this._running = false;
    this._unsubTick?.();
    this._unsubState?.();
  }

  setDesktopBounds(width, height, x = 0, y = 0) {
    this.desktop.x = x;
    this.desktop.y = y;
    this.desktop.width = width;
    this.desktop.height = height;
  }

  setChatArea(x, y, w, h) {
    this._chatArea = { x, y, w, h };
  }

  // ---- Movement Tick (called from requestAnimationFrame with dt in seconds) ----

  updateMovement(dt) {
    if (!this._running) return;

    // Handle pause
    if (this._pauseTimer > 0) {
      this._pauseTimer -= dt;
      return;
    }

    if (!this.target) return;

    const dx = this.target.x - this.pos.x;
    const dy = this.target.y - this.pos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 4) {
      this.pos.x = this.target.x;
      this.pos.y = this.target.y;
      this.target = null;
      this._startPos = null;
      this._moveProgress = 0;
      this._onArrived();
      return;
    }

    // Track movement start
    if (!this._startPos) {
      this._startPos = { x: this.pos.x, y: this.pos.y };
      this._moveProgress = 0;
      this._curveAmplitude = 8 + Math.random() * 12;
      this._curveFrequency = 2 + Math.random() * 3;
      this._curvePhase = 0;
    }

    // Total distance for progress calculation
    const totalDist = Math.sqrt(
      (this.target.x - this._startPos.x) ** 2 +
      (this.target.y - this._startPos.y) ** 2
    );
    this._moveProgress = totalDist > 0 ? 1 - (dist / totalDist) : 1;

    // Speed with easing: slow start, fast middle, slow end
    const baseSpeed = this.speed * 60;
    const easeMul = this._easeSpeed(this._moveProgress);
    const emotionMul = this._emotionSpeedMul();
    const step = Math.min(baseSpeed * easeMul * emotionMul * dt, dist);

    // Direction vector
    const dirX = dx / dist;
    const dirY = dy / dist;

    // Walk curve: sinusoidal perpendicular offset
    this._curvePhase += dt * this._curveFrequency;
    const curveOffset = Math.sin(this._curvePhase * Math.PI * 2) * this._curveAmplitude;
    // Perpendicular to movement direction
    const perpX = -dirY * curveOffset * dt;
    const perpY = dirX * curveOffset * dt;

    this.pos.x += dirX * step + perpX;
    this.pos.y += dirY * step + perpY;

    // Update facing
    if (Math.abs(dx) > 3) {
      const newFacing = dx > 0 ? 1 : -1;
      if (newFacing !== this.facing) {
        this.facing = newFacing;
        if (this.petRenderer) this.petRenderer.setFacing(newFacing);
      }
    }

    this._clampPosition();
  }

  /** Easing function for speed: slow start, fast middle, slow end */
  _easeSpeed(t) {
    if (t < 0.15) return 0.3 + (t / 0.15) * 0.7;   // accelerate
    if (t > 0.85) return 0.3 + ((1 - t) / 0.15) * 0.7; // decelerate
    return 1.0; // cruise
  }

  // ---- Behavior Decisions (1-second tick) ----

  _onTick({ state, idleSec }) {
    if (!this._running) return;

    // Auto-patrol after idle
    if (state === 'idle' && idleSec >= this._idleBeforePatrol && !this.target) {
      if (Math.random() < 0.1) {
        this._pickPatrolTarget();
      }
    }

    // Auto-sleep after long idle
    if (state === 'idle' && idleSec >= this._idleBeforeSleep) {
      this.runtime.setState('sleep');
    }

    // Random wake from sleep
    if (state === 'sleep' && idleSec > 15 && Math.random() < 0.03) {
      this.runtime.setState('idle');
    }

    // If user is typing and pet is idle, slowly approach chat
    if (this._userTyping && state === 'idle' && !this.target && this._chatArea) {
      if (Math.random() < 0.15) {
        this._approachChatSlowly();
      }
    }

    // Cooldown
    if (this._patrolCooldown > 0) this._patrolCooldown--;
  }

  _onStateChange({ from, to }) {
    if (to === 'walk' || to === 'patrol') {
      if (!this.target) this._pickPatrolTarget();
    }
    if (to === 'approach') {
      this._approachingChat = true;
      this._targetChatArea();
    }
    if (from === 'approach') {
      this._approachingChat = false;
    }
  }

  _onArrived() {
    const state = this.runtime.state;
    if (state === 'walk' || state === 'patrol') {
      const roll = Math.random();
      if (roll < 0.3) {
        this.runtime.setState('observe');
        this._pauseTimer = 1.5 + Math.random() * 3;
      } else if (roll < 0.5) {
        // Edge-dock: look outward from screen edge
        this.runtime.setState('observe');
        this._pauseTimer = 3 + Math.random() * 5;
      } else if (roll < 0.65) {
        this.runtime.setState('curious');
        this._pauseTimer = 2;
      } else {
        this.runtime.setState('idle');
        this._pauseTimer = 2 + Math.random() * 4;
      }
    }
    if (state === 'approach') {
      this.runtime.setState('idle');
      this._pauseTimer = 1.5;
    }
  }

  // ---- Movement Targets ----

  _pickPatrolTarget() {
    if (this._patrolCooldown > 0) return;

    const margin = this.margin;
    const minX = this.desktop.x + margin.left;
    const minY = this.desktop.y + margin.top;
    const maxX = this.desktop.x + this.desktop.width - margin.right;
    const maxY = this.desktop.y + this.desktop.height - margin.bottom;

    const strategy = Math.random();
    let tx, ty;

    if (strategy < 0.3) {
      // Short wander: nearby point
      const angle = Math.random() * Math.PI * 2;
      const dist = 100 + Math.random() * 200;
      tx = this.pos.x + Math.cos(angle) * dist;
      ty = this.pos.y + Math.sin(angle) * dist;
    } else if (strategy < 0.5) {
      // Edge-dock: go to a screen edge
      const edge = Math.floor(Math.random() * 4);
      switch (edge) {
        case 0: tx = minX + 10; ty = minY + Math.random() * (maxY - minY); break;
        case 1: tx = maxX - 10; ty = minY + Math.random() * (maxY - minY); break;
        case 2: tx = minX + Math.random() * (maxX - minX); ty = minY + 10; break;
        default: tx = minX + Math.random() * (maxX - minX); ty = maxY - 20; break;
      }
    } else if (strategy < 0.7 && this._chatArea) {
      // Wander near chat area
      const chat = this._chatArea;
      tx = chat.x + chat.w + 20 + Math.random() * 80;
      ty = chat.y - 20 + Math.random() * (chat.h + 40);
    } else {
      // Full desktop random
      tx = minX + Math.random() * (maxX - minX);
      ty = minY + Math.random() * (maxY - minY);
    }

    // Clamp
    tx = Math.max(minX, Math.min(tx, maxX));
    ty = Math.max(minY, Math.min(ty, maxY));

    // Skip if too close
    const dist = Math.sqrt((tx - this.pos.x) ** 2 + (ty - this.pos.y) ** 2);
    if (dist < 40) {
      this._patrolCooldown = 2;
      return;
    }

    this.target = { x: tx, y: ty };

    if (this.runtime.state === 'idle' || this.runtime.state === 'sleep') {
      this.runtime.requestWalk();
    }

    this._patrolCooldown = 3 + Math.floor(Math.random() * 5);
  }

  _approachChatSlowly() {
    if (!this._chatArea) return;
    const chat = this._chatArea;
    // Move slowly toward a point near the chat area
    const tx = chat.x + chat.w + 25 + Math.random() * 30;
    const ty = chat.y + chat.h * 0.3 + Math.random() * chat.h * 0.4;
    this.target = {
      x: Math.max(this.margin.left, Math.min(tx, this.desktop.width - this.margin.right)),
      y: Math.max(this.desktop.y + this.margin.top, Math.min(ty, this.desktop.y + this.desktop.height - this.margin.bottom))
    };
    this.target.x = Math.max(this.desktop.x + this.margin.left, Math.min(this.target.x, this.desktop.x + this.desktop.width - this.margin.right));
    this.speed = 0.8; // slower approach
    if (this.runtime.state === 'idle') {
      this.runtime.requestWalk();
    }
  }

  _targetChatArea() {
    if (!this._chatArea) return;
    const chat = this._chatArea;
    const tx = this.facing > 0 ? chat.x - 25 : chat.x + chat.w + 25;
    const ty = chat.y + chat.h * 0.4;
    this.target = {
      x: Math.max(this.margin.left, Math.min(tx, this.desktop.width - this.margin.right)),
      y: Math.max(this.desktop.y + this.margin.top, Math.min(ty, this.desktop.y + this.desktop.height - this.margin.bottom))
    };
    this.target.x = Math.max(this.desktop.x + this.margin.left, Math.min(this.target.x, this.desktop.x + this.desktop.width - this.margin.right));
  }

  // ---- Event Handlers ----

  onUserClick() {
    if (this._chatArea) {
      this.runtime.requestApproach();
    } else {
      this.runtime.onHappy();
    }
  }

  onUserTyping() {
    this._userTyping = true;
    // Reset after 5 seconds of no typing
    clearTimeout(this._typingTimeout);
    this._typingTimeout = setTimeout(() => { this._userTyping = false; }, 5000);
  }

  onQueryStart() {
    this.runtime.onThinking();
    this._userTyping = false;
    // Move closer to chat
    if (this._chatArea) {
      this.facing = this._chatArea.x > this.pos.x ? 1 : -1;
      this._approachChatSlowly();
    }
  }

  onQueryEnd(success) {
    if (success) {
      this.runtime.onSpeaking();
      // Return to normal speed after response
      setTimeout(() => { this.speed = 1.5; }, 3000);
    } else {
      this.runtime.onSad();
      this.speed = 1.5;
    }
  }

  // ---- Helpers ----

  _emotionSpeedMul() {
    if (!this.runtime.isMoving) return 0.3;
    return this.petRenderer?.emotion?.moveSpeed || 1.0;
  }

  _clampPosition() {
    this.pos.x = Math.max(this.desktop.x + this.margin.left, Math.min(this.pos.x, this.desktop.x + this.desktop.width - this.margin.right));
    this.pos.y = Math.max(this.desktop.y + this.margin.top, Math.min(this.pos.y, this.desktop.y + this.desktop.height - this.margin.bottom));
  }
}

window.DesktopBehavior = DesktopBehavior;
