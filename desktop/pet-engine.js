// Pet Engine - Pure Renderer driven by CharacterRuntime
class PetEngine {
  constructor(canvas, runtime, emotion) {
    this.c = canvas; this.x = canvas.getContext("2d");
    this.w = canvas.width; this.h = canvas.height;
    this.runtime = runtime; this.emotion = emotion;
    this.t = 0; this.blink = {on:false,timer:0}; this.mouth = 0; this.walk = 0;
    this.armL = 0; this.armR = 0; this.legL = 0; this.legR = 0;
    this.bob = 0; this.breathe = 0; this.jump = 0; this.droop = 0;
    this.tailWag = 0; this.earL = 0; this.earR = 0;
    this.fx = []; this.particles = []; this.facing = 1;
    this._running = true; this._loop();
    this._emotionInterval = setInterval(() => { if (this.emotion) this.emotion.decay(); }, 2000);
  }
  destroy() { this._running = false; clearInterval(this._emotionInterval); this.particles = []; this.fx = []; }
  setFacing(dir) { this.facing = dir; }
  _loop() { if (!this._running) return; this.t += 0.016; this._physics(); this._render(); requestAnimationFrame(() => this._loop()); }
  _physics() {
    this.blink.timer += 0.016;
    if (!this.blink.on && this.blink.timer > 2.5 + Math.random() * 3) { this.blink.on = true; this.blink.timer = 0; }
    if (this.blink.on && this.blink.timer > 0.13) { this.blink.on = false; this.blink.timer = 0; }
    for (let i = this.particles.length - 1; i >= 0; i--) { const p = this.particles[i]; p.x += p.vx; p.y += p.vy; p.vy -= 0.03; p.life -= 0.012; if (p.life <= 0) this.particles.splice(i, 1); }
    this.fx = this.fx.filter(f => (f.life -= 0.048) > 0);
    const s = this.runtime.state, t = this.t;
    if (s === "idle") {
      this.breathe = Math.sin(t*1.5)*2; this.bob = Math.sin(t*1.2)*1.5;
      this.armL = Math.sin(t*0.8)*0.06; this.armR = -this.armL;
      this.legL = this.legR = 0; this.jump = 0; this.droop *= 0.93; this.mouth *= 0.88;
      this.tailWag = Math.sin(t*2.5)*0.3;
      this.earL = Math.sin(t*0.9)*0.05; this.earR = Math.sin(t*0.9+0.5)*0.05;
    } else if (s === "walk" || s === "patrol" || s === "approach") {
      this.walk += 0.09 * (this.emotion ? this.emotion.moveSpeed : 1);
      this.breathe = Math.sin(this.walk*2)*3; this.bob = Math.sin(this.walk*2)*2;
      this.armL = Math.sin(this.walk)*0.55; this.armR = -this.armL;
      this.legL = -Math.sin(this.walk)*0.45; this.legR = -this.legL;
      this.jump = Math.abs(Math.sin(this.walk*2))*5; this.mouth *= 0.9;
      this.tailWag = Math.sin(this.walk*1.5)*0.5;
      this.earL = Math.sin(this.walk*0.7)*0.1; this.earR = -this.earL;
    } else if (s === "observe") {
      this.breathe = Math.sin(t*1.8)*1.5; this.bob = Math.sin(t*2)*3;
      this.armL = -0.4; this.armR = 0.1; this.mouth = 0.15;
      this.tailWag = Math.sin(t*3)*0.35; this.earL = -0.3; this.earR = 0.05;
    } else if (s === "think") {
      this.breathe = Math.sin(t*2)*1; this.bob = Math.sin(t*3)*2.5;
      this.armL = -0.85+Math.sin(t*1.5)*0.08; this.armR = Math.sin(t)*0.04;
      this.mouth *= 0.9; this.tailWag = Math.sin(t*1.2)*0.15;
      this.earL = -0.15; this.earR = 0.1;
    } else if (s === "speak") {
      this.breathe = Math.sin(t*4)*1.5; this.bob = Math.sin(t*5)*1.8;
      this.armL = Math.sin(t*2.5)*0.15; this.armR = -this.armL;
      this.mouth = 0.35+Math.sin(t*14)*0.3; this.tailWag = Math.sin(t*4)*0.4;
      this.earL = 0.08; this.earR = -0.08;
    } else if (s === "sleep") {
      this.breathe = Math.sin(t*0.7)*3.5; this.bob = 6+Math.sin(t*0.4)*2;
      this.armL = 0.2; this.armR = -0.2; this.blink.on = true;
      this.mouth = 0.12+Math.sin(t*0.7)*0.08; this.tailWag = Math.sin(t*0.5)*0.1;
      this.earL = 0.1; this.earR = -0.1;
      if (this.runtime.idleSec % 5 === 0 && Math.random() < 0.3) this._addFx("💤", 50+Math.random()*10, -15);
    } else if (s === "alert") {
      this.breathe = Math.sin(t*3)*1; this.bob = Math.sin(t*2)*1.5;
      this.armL = -0.6; this.armR = -0.6; this.mouth = 0.1;
      this.tailWag = Math.sin(t*6)*0.2; this.earL = -0.25; this.earR = -0.25;
    } else if (s === "happy") {
      this.jump = Math.abs(Math.sin(t*7))*22;
      this.armL = -1.3+Math.sin(t*7)*0.35; this.armR = 1.3-Math.sin(t*7)*0.35;
      this.breathe = 0; this.bob = 0; this.mouth = 0.45; this.tailWag = Math.sin(t*10)*0.6;
      this.earL = -0.2; this.earR = 0.2;
      if (Math.random() < 0.15) this._spawnParticle("❤️", -20, -50);
    } else if (s === "sad") {
      this.droop = Math.min(this.droop + 0.06, 10); this.bob = this.droop;
      this.armL = 0.3; this.armR = -0.3; this.mouth = 0; this.tailWag = 0;
      this.earL = 0.25; this.earR = -0.25;
    } else if (s === "angry") {
      this.breathe = Math.sin(t*5)*2; this.bob = Math.sin(t*4)*1.5;
      this.armL = -0.5; this.armR = 0.5; this.mouth = 0.2;
      this.tailWag = Math.sin(t*8)*0.5; this.earL = 0.2; this.earR = -0.2;
    } else if (s === "curious") {
      this.breathe = Math.sin(t*1.8)*1.5; this.bob = Math.sin(t*2)*3;
      this.armL = -0.4; this.armR = 0.1; this.mouth = 0.15;
      this.tailWag = Math.sin(t*3)*0.35; this.earL = -0.3; this.earR = 0.05;
    }
  }
  _render() {
    const x = this.x, w = this.w, h = this.h; x.clearRect(0,0,w,h);
    const cx = w/2, groundY = h-8;
    const bodyY = groundY - 52 + this.breathe - this.jump + this.droop;
    const headY = bodyY - 32 + this.bob, state = this.runtime.state;
    // Background circle so pet is visible on transparent window
    x.fillStyle = "rgba(26,22,37,0.75)";
    x.beginPath(); x.ellipse(cx, bodyY + 10, 50, 60, 0, 0, Math.PI*2); x.fill();
    x.fillStyle = "rgba(0,0,0,0.12)"; x.beginPath(); x.ellipse(cx, groundY+2, 28-this.jump*0.5, 5, 0, 0, Math.PI*2); x.fill();
    x.save(); x.translate(cx+18*this.facing, bodyY+15); x.rotate(this.tailWag+0.5*this.facing);
    const tg = x.createLinearGradient(0,0,12*this.facing,-40); tg.addColorStop(0,"#e85a4f"); tg.addColorStop(0.7,"#d14d42"); tg.addColorStop(1,"#fff");
    x.fillStyle = tg; x.beginPath(); x.moveTo(0,0); x.quadraticCurveTo(22*this.facing,-20,14*this.facing,-45); x.quadraticCurveTo(4*this.facing,-38,-3*this.facing,-8); x.fill();
    x.fillStyle = "#fff"; x.beginPath(); x.ellipse(14*this.facing,-42,6,8,0.3*this.facing,0,Math.PI*2); x.fill(); x.restore();
    this._leg(cx-10,bodyY+22,groundY,this.legL,"#e85a4f","#fff");
    this._leg(cx+10,bodyY+22,groundY,this.legR,"#d14d42","#f5e6d3");
    const bg = x.createRadialGradient(cx-5,bodyY-5,5,cx,bodyY,28); bg.addColorStop(0,"#f07060"); bg.addColorStop(1,"#d14d42");
    x.fillStyle = bg; x.beginPath(); x.ellipse(cx,bodyY,20,24,0,0,Math.PI*2); x.fill();
    const blg = x.createRadialGradient(cx,bodyY+4,2,cx,bodyY+4,18); blg.addColorStop(0,"#fff"); blg.addColorStop(1,"#f5e6d3");
    x.fillStyle = blg; x.beginPath(); x.ellipse(cx+1,bodyY+4,13,16,0,0,Math.PI*2); x.fill();
    this._arm(cx-20,bodyY-4,this.armL,"#e85a4f","#fff");
    this._arm(cx+20,bodyY-4,this.armR,"#d14d42","#f5e6d3");
    const hg = x.createRadialGradient(cx-4,headY-6,4,cx,headY,26); hg.addColorStop(0,"#f57060"); hg.addColorStop(1,"#d14d42");
    x.fillStyle = hg; x.beginPath(); x.arc(cx,headY,23,0,Math.PI*2); x.fill();
    const fg = x.createRadialGradient(cx,headY+5,3,cx,headY+3,18); fg.addColorStop(0,"#fce4d6"); fg.addColorStop(1,"#f0a090");
    x.fillStyle = fg; x.beginPath(); x.ellipse(cx,headY+3,17,15,0,0,Math.PI*2); x.fill();
    this._ear(cx-18,headY-10,this.earL,"#e85a4f","#f5c6c0",-1); this._ear(cx+18,headY-10,this.earR,"#d14d42","#f5c6c0",1);
    const eyeY = headY - 1;
    if (this.blink.on) {
      x.strokeStyle = "#2d1b2e"; x.lineWidth = 2; x.lineCap = "round";
      x.beginPath(); x.moveTo(cx-11,eyeY); x.lineTo(cx-5,eyeY); x.stroke();
      x.beginPath(); x.moveTo(cx+5,eyeY); x.lineTo(cx+11,eyeY); x.stroke();
    } else if (state === "happy") {
      x.strokeStyle = "#2d1b2e"; x.lineWidth = 2.5; x.lineCap = "round";
      x.beginPath(); x.arc(cx-8,eyeY+1,5,Math.PI*0.15,Math.PI*0.85); x.stroke();
      x.beginPath(); x.arc(cx+8,eyeY+1,5,Math.PI*0.15,Math.PI*0.85); x.stroke();
    } else if (state === "sad") { this._droopyEye(cx-8,eyeY); this._droopyEye(cx+8,eyeY);
    } else if (state === "angry") {
      this._angryEye(cx-8,eyeY); this._angryEye(cx+8,eyeY);
      x.strokeStyle = "#2d1b2e"; x.lineWidth = 2.5; x.lineCap = "round";
      x.beginPath(); x.moveTo(cx-13,eyeY-9); x.lineTo(cx-4,eyeY-7); x.stroke();
      x.beginPath(); x.moveTo(cx+4,eyeY-7); x.lineTo(cx+13,eyeY-9); x.stroke();
    } else if (state === "curious" || state === "observe") {
      this._bigEye(cx-8,eyeY); this._normalEye(cx+8,eyeY);
      x.strokeStyle = "#2d1b2e"; x.lineWidth = 1.8; x.lineCap = "round";
      x.beginPath(); x.arc(cx-8,eyeY-10,7,Math.PI*1.15,Math.PI*1.85); x.stroke();
    } else { this._normalEye(cx-8,eyeY); this._normalEye(cx+8,eyeY); }
    x.fillStyle = "#d4607a"; x.beginPath(); x.moveTo(cx,eyeY+8); x.lineTo(cx-3,eyeY+11); x.lineTo(cx+3,eyeY+11); x.fill();
    const my = eyeY + 13;
    if (state === "angry") {
      x.strokeStyle = "#c03050"; x.lineWidth = 1.8; x.lineCap = "round"; x.beginPath();
      x.moveTo(cx-5,my); x.lineTo(cx-2,my+2); x.lineTo(cx,my); x.lineTo(cx+2,my+2); x.lineTo(cx+5,my); x.stroke();
    } else if (this.mouth > 0.1) {
      x.fillStyle = "#c03050"; x.beginPath(); x.ellipse(cx,my,4,3.5*this.mouth,0,0,Math.PI*2); x.fill();
      if (this.mouth > 0.2) { x.fillStyle = "#e88090"; x.beginPath(); x.ellipse(cx,my+1,3,2.2*this.mouth,0,0,Math.PI); x.fill(); }
    } else {
      x.strokeStyle = "#c03050"; x.lineWidth = 1.5; x.lineCap = "round";
      if (state === "sad") { x.beginPath(); x.arc(cx,my+6,3.5,Math.PI*0.2,Math.PI*0.8,true); x.stroke(); }
      else if (state === "curious" || state === "observe") { x.fillStyle = "#c03050"; x.beginPath(); x.ellipse(cx,my+1,2,2.5,0,0,Math.PI*2); x.fill(); }
      else { x.beginPath(); x.arc(cx,my,4,Math.PI*0.1,Math.PI*0.9); x.stroke(); }
    }
    const ba = state === "happy" ? 0.4 : state === "angry" ? 0.15 : 0.25;
    x.fillStyle = "rgba(255,140,140,"+ba+")";
    x.beginPath(); x.ellipse(cx-17,eyeY+6,5,3,0,0,Math.PI*2); x.fill();
    x.beginPath(); x.ellipse(cx+17,eyeY+6,5,3,0,0,Math.PI*2); x.fill();
    x.strokeStyle = "rgba(80,50,50,0.2)"; x.lineWidth = 0.8; x.lineCap = "round";
    for (const sd of [-1, 1]) {
      x.beginPath(); x.moveTo(cx+sd*14,eyeY+8); x.lineTo(cx+sd*28,eyeY+5); x.stroke();
      x.beginPath(); x.moveTo(cx+sd*14,eyeY+10); x.lineTo(cx+sd*28,eyeY+10); x.stroke();
      x.beginPath(); x.moveTo(cx+sd*14,eyeY+12); x.lineTo(cx+sd*27,eyeY+15); x.stroke();
    }
    x.font = "13px sans-serif"; x.textAlign = "center";
    for (const ef of this.fx) { x.globalAlpha = ef.life; x.fillText(ef.emoji, cx+ef.dx, headY+ef.dy); }
    x.globalAlpha = 1; x.font = "10px sans-serif";
    for (const pt of this.particles) { x.globalAlpha = pt.life; x.fillText(pt.emoji, cx+pt.dx+pt.x, headY+pt.dy+pt.y); }
    x.globalAlpha = 1;
  }
  _normalEye(ex,ey) { const x=this.x; x.fillStyle="#fff"; x.beginPath(); x.ellipse(ex,ey,6,7,0,0,Math.PI*2); x.fill(); x.fillStyle="#2d1b2e"; x.beginPath(); x.ellipse(ex+1,ey+1,3.5,4,0,0,Math.PI*2); x.fill(); x.fillStyle="#fff"; x.beginPath(); x.arc(ex+2.5,ey-1.5,1.5,0,Math.PI*2); x.fill(); x.beginPath(); x.arc(ex,ey+2,0.8,0,Math.PI*2); x.fill(); }
  _droopyEye(ex,ey) { const x=this.x; x.fillStyle="#fff"; x.beginPath(); x.ellipse(ex,ey+2,5,5,0,0,Math.PI*2); x.fill(); x.fillStyle="#2d1b2e"; x.beginPath(); x.ellipse(ex,ey+3,3,3.5,0,0,Math.PI*2); x.fill(); x.fillStyle="#fff"; x.beginPath(); x.arc(ex+1.5,ey+1.5,1.2,0,Math.PI*2); x.fill(); }
  _angryEye(ex,ey) { const x=this.x; x.fillStyle="#fff"; x.beginPath(); x.ellipse(ex,ey,5,6,0,0,Math.PI*2); x.fill(); x.fillStyle="#c03020"; x.beginPath(); x.ellipse(ex+1,ey+1,3.5,4,0,0,Math.PI*2); x.fill(); x.fillStyle="#fff"; x.beginPath(); x.arc(ex+2.5,ey-1.5,1.2,0,Math.PI*2); x.fill(); }
  _bigEye(ex,ey) { const x=this.x; x.fillStyle="#fff"; x.beginPath(); x.ellipse(ex,ey,6,8,0,0,Math.PI*2); x.fill(); x.fillStyle="#2d1b2e"; x.beginPath(); x.ellipse(ex+1,ey+1,4,5,0,0,Math.PI*2); x.fill(); x.fillStyle="#fff"; x.beginPath(); x.arc(ex+3,ey-2,2,0,Math.PI*2); x.fill(); x.beginPath(); x.arc(ex,ey+3,1,0,Math.PI*2); x.fill(); }
  _ear(x0,y0,angle,main,inner,side) { const c=this.x; c.save(); c.translate(x0,y0); c.rotate(angle); c.fillStyle=main; c.beginPath(); c.moveTo(0,0); c.lineTo(side*-8,-22); c.lineTo(side*10,-6); c.fill(); c.fillStyle=inner; c.beginPath(); c.moveTo(side*-1,-3); c.lineTo(side*-6,-18); c.lineTo(side*7,-7); c.fill(); c.restore(); }
  _leg(x,kneeY,footY,angle,main,pad) { const c=this.x; c.save(); c.translate(x,kneeY); c.rotate(angle); c.fillStyle=main; c.beginPath(); c.roundRect(-4,0,9,18,3); c.fill(); c.fillStyle=pad; c.beginPath(); c.ellipse(0.5,footY-kneeY+3,7,4,0,0,Math.PI*2); c.fill(); c.restore(); }
  _arm(x,shoulderY,angle,main,pad) { const c=this.x; c.save(); c.translate(x,shoulderY); c.rotate(angle); c.fillStyle=main; c.beginPath(); c.roundRect(-3,0,7,14,3); c.fill(); c.beginPath(); c.roundRect(-3,12,7,11,3); c.fill(); c.fillStyle=pad; c.beginPath(); c.arc(0.5,25,4,0,Math.PI*2); c.fill(); c.restore(); }
  _addFx(emoji,dx,dy) { if (this.fx.length < 5) this.fx.push({emoji,dx,dy,life:1}); }
  _spawnParticle(emoji,dx,dy) { this.particles.push({emoji,dx,dy,x:0,y:0,vx:(Math.random()-0.5)*1.5,vy:-Math.random()*2-0.5,life:1}); }
}
window.PetEngine = PetEngine;
