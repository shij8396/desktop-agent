// ===== Character Sprites — SVG definitions for chibi anime girl =====
// Character: white short hair + ahoge, green eyes, white dress, red bow
// Canvas size: 180×300, character centered around (90, 240)

const SW = 180, SH = 300; // sprite width/height
const CX = 90; // center X
const CHAR_Y = 230; // character base Y (feet position)

// ── Color Palette (from reference image) ────────────────────────────────────
const C = {
  hair:      '#F2F2F2', hairDark: '#E6E8EC', hairShadow: '#D0D0D4',
  eye:       '#7ECBC0', eyeDark: '#55776D', eyeLight: '#B5E4E2', eyeYellow: '#DCE8A5',
  skin:      '#FBE9E2', skinShadow: '#FED7BD',
  dress:     '#FFFFFF', dressShadow: '#F0F0F0',
  collar:    '#8DB3A3', collarDark: '#6B9A8A',
  bow:       '#CE463C', bowDark: '#A83530',
  shorts:    '#F5D0A6', shortsShadow: '#E8C090',
  blush:     'rgba(255,150,150,0.35)',
  mouth:     '#E88090', mouthOpen: '#D4607A',
  shoe:      '#8B7355', shoeDark: '#6B5535',
};

// ── SVG Builder Helpers ─────────────────────────────────────────────────────

function svgBegin(w = SW, h = SH) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
}
const svgEnd = '</svg>';

// Body part generators
function hairBack(y, sway = 0) {
  return `
    <ellipse cx="${CX + sway}" cy="${y - 55}" rx="32" ry="28" fill="${C.hairShadow}" />
    <ellipse cx="${CX + sway}" cy="${y - 58}" rx="30" ry="26" fill="${C.hair}" />
  `;
}

function body(y, breathe = 0) {
  const by = y + breathe;
  return `
    <!-- dress body -->
    <ellipse cx="${CX}" cy="${by - 15}" rx="22" ry="26" fill="${C.dressShadow}" />
    <ellipse cx="${CX}" cy="${by - 16}" rx="20" ry="24" fill="${C.dress}" />
    <!-- skirt -->
    <ellipse cx="${CX}" cy="${by + 5}" rx="24" ry="12" fill="${C.dressShadow}" />
    <ellipse cx="${CX}" cy="${by + 4}" rx="22" ry="10" fill="${C.dress}" />
  `;
}

function collar(y) {
  return `
    <path d="M${CX - 12},${y - 36} Q${CX},${y - 28} ${CX + 12},${y - 36}" fill="${C.collar}" stroke="${C.collarDark}" stroke-width="0.5"/>
    <polygon points="${CX - 3},${y - 34} ${CX},${y - 26} ${CX + 3},${y - 34}" fill="${C.bow}" />
    <circle cx="${CX}" cy="${y - 33}" r="2" fill="${C.bowDark}" />
    <!-- bow tails -->
    <path d="M${CX - 2},${y - 31} Q${CX - 8},${y - 24} ${CX - 5},${y - 20}" fill="${C.bow}" stroke="${C.bowDark}" stroke-width="0.3"/>
    <path d="M${CX + 2},${y - 31} Q${CX + 8},${y - 24} ${CX + 5},${y - 20}" fill="${C.bow}" stroke="${C.bowDark}" stroke-width="0.3"/>
  `;
}

function arm(x, y, angle, mirror = false) {
  const m = mirror ? -1 : 1;
  return `
    <g transform="translate(${x},${y}) rotate(${angle * m})">
      <rect x="-3" y="0" width="7" height="16" rx="3" fill="${C.skin}" />
      <circle cx="0.5" cy="18" r="4" fill="${C.skinShadow}" />
    </g>
  `;
}

function leg(x, y, angle = 0) {
  return `
    <g transform="translate(${x},${y}) rotate(${angle})">
      <rect x="-4" y="0" width="9" height="18" rx="3" fill="${C.skin}" />
      <rect x="-5" y="16" width="11" height="6" rx="3" fill="${C.shoe}" />
      <rect x="-4" y="18" width="9" height="4" rx="2" fill="${C.shoeDark}" />
    </g>
  `;
}

function face(y, eyeType = 'normal', mouthType = 'smile', blushOpacity = 0.35) {
  const ey = y - 52;
  let eyes = '';
  let mouth = '';
  let extras = '';

  // Eyes
  switch (eyeType) {
    case 'normal':
      eyes = `
        <ellipse cx="${CX - 10}" cy="${ey}" rx="7" ry="8" fill="#fff" />
        <ellipse cx="${CX - 9}" cy="${ey + 1}" rx="4.5" ry="5.5" fill="${C.eye}" />
        <ellipse cx="${CX - 9}" cy="${ey + 2}" rx="3" ry="3.5" fill="${C.eyeDark}" />
        <circle cx="${CX - 7}" cy="${ey - 2}" r="2" fill="#fff" />
        <circle cx="${CX - 10}" cy="${ey + 3}" r="1" fill="#fff" opacity="0.6" />
        <ellipse cx="${CX + 10}" cy="${ey}" rx="7" ry="8" fill="#fff" />
        <ellipse cx="${CX + 11}" cy="${ey + 1}" rx="4.5" ry="5.5" fill="${C.eye}" />
        <ellipse cx="${CX + 11}" cy="${ey + 2}" rx="3" ry="3.5" fill="${C.eyeDark}" />
        <circle cx="${CX + 13}" cy="${ey - 2}" r="2" fill="#fff" />
        <circle cx="${CX + 10}" cy="${ey + 3}" r="1" fill="#fff" opacity="0.6" />
      `;
      break;
    case 'blink':
      eyes = `
        <line x1="${CX - 14}" y1="${ey}" x2="${CX - 5}" y2="${ey}" stroke="${C.eyeDark}" stroke-width="2.5" stroke-linecap="round"/>
        <line x1="${CX + 5}" y1="${ey}" x2="${CX + 14}" y2="${ey}" stroke="${C.eyeDark}" stroke-width="2.5" stroke-linecap="round"/>
      `;
      break;
    case 'closed':
      eyes = `
        <path d="M${CX - 14},${ey + 1} Q${CX - 9},${ey + 5} ${CX - 5},${ey + 1}" stroke="${C.eyeDark}" stroke-width="2" fill="none" stroke-linecap="round"/>
        <path d="M${CX + 5},${ey + 1} Q${CX + 10},${ey + 5} ${CX + 14},${ey + 1}" stroke="${C.eyeDark}" stroke-width="2" fill="none" stroke-linecap="round"/>
      `;
      break;
    case 'happy':
      eyes = `
        <path d="M${CX - 14},${ey + 2} Q${CX - 9},${ey - 4} ${CX - 5},${ey + 2}" stroke="${C.eyeDark}" stroke-width="2.5" fill="none" stroke-linecap="round"/>
        <path d="M${CX + 5},${ey + 2} Q${CX + 10},${ey - 4} ${CX + 14},${ey + 2}" stroke="${C.eyeDark}" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      `;
      break;
    case 'sad':
      eyes = `
        <ellipse cx="${CX - 10}" cy="${ey + 2}" rx="6" ry="6" fill="#fff" />
        <ellipse cx="${CX - 10}" cy="${ey + 3}" rx="4" ry="4.5" fill="${C.eye}" />
        <ellipse cx="${CX - 10}" cy="${ey + 4}" rx="2.5" ry="3" fill="${C.eyeDark}" />
        <circle cx="${CX - 8}" cy="${ey + 1}" r="1.5" fill="#fff" />
        <ellipse cx="${CX + 10}" cy="${ey + 2}" rx="6" ry="6" fill="#fff" />
        <ellipse cx="${CX + 10}" cy="${ey + 3}" rx="4" ry="4.5" fill="${C.eye}" />
        <ellipse cx="${CX + 10}" cy="${ey + 4}" rx="2.5" ry="3" fill="${C.eyeDark}" />
        <circle cx="${CX + 12}" cy="${ey + 1}" r="1.5" fill="#fff" />
        <!-- sad eyebrows -->
        <line x1="${CX - 15}" y1="${ey - 8}" x2="${CX - 6}" y2="${ey - 6}" stroke="${C.hairDark}" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="${CX + 6}" y1="${ey - 6}" x2="${CX + 15}" y2="${ey - 8}" stroke="${C.hairDark}" stroke-width="1.5" stroke-linecap="round"/>
      `;
      break;
    case 'angry':
      eyes = `
        <ellipse cx="${CX - 10}" cy="${ey}" rx="6" ry="7" fill="#fff" />
        <ellipse cx="${CX - 9}" cy="${ey + 1}" rx="4" ry="5" fill="#C03020" />
        <circle cx="${CX - 7}" cy="${ey - 2}" r="1.5" fill="#fff" />
        <ellipse cx="${CX + 10}" cy="${ey}" rx="6" ry="7" fill="#fff" />
        <ellipse cx="${CX + 11}" cy="${ey + 1}" rx="4" ry="5" fill="#C03020" />
        <circle cx="${CX + 13}" cy="${ey - 2}" r="1.5" fill="#fff" />
        <!-- angry eyebrows -->
        <line x1="${CX - 16}" y1="${ey - 7}" x2="${CX - 5}" y2="${ey - 10}" stroke="${C.hairDark}" stroke-width="2" stroke-linecap="round"/>
        <line x1="${CX + 5}" y1="${ey - 10}" x2="${CX + 16}" y2="${ey - 7}" stroke="${C.hairDark}" stroke-width="2" stroke-linecap="round"/>
      `;
      break;
    case 'curious':
      eyes = `
        <ellipse cx="${CX - 10}" cy="${ey}" rx="8" ry="9" fill="#fff" />
        <ellipse cx="${CX - 9}" cy="${ey + 1}" rx="5.5" ry="6.5" fill="${C.eye}" />
        <ellipse cx="${CX - 9}" cy="${ey + 2}" rx="3.5" ry="4" fill="${C.eyeDark}" />
        <circle cx="${CX - 6}" cy="${ey - 3}" r="2.5" fill="#fff" />
        <circle cx="${CX - 10}" cy="${ey + 3}" r="1.2" fill="#fff" opacity="0.6" />
        <ellipse cx="${CX + 10}" cy="${ey}" rx="6" ry="7" fill="#fff" />
        <ellipse cx="${CX + 11}" cy="${ey + 1}" rx="4" ry="5" fill="${C.eye}" />
        <ellipse cx="${CX + 11}" cy="${ey + 2}" rx="2.5" ry="3.5" fill="${C.eyeDark}" />
        <circle cx="${CX + 13}" cy="${ey - 2}" r="2" fill="#fff" />
        <!-- question mark -->
        <text x="${CX + 26}" y="${ey - 12}" font-size="12" fill="${C.eye}" font-weight="bold">?</text>
      `;
      break;
    case 'think':
      eyes = `
        <ellipse cx="${CX - 10}" cy="${ey - 2}" rx="7" ry="8" fill="#fff" />
        <ellipse cx="${CX - 9}" cy="${ey - 3}" rx="4.5" ry="5.5" fill="${C.eye}" />
        <ellipse cx="${CX - 9}" cy="${ey - 2}" rx="3" ry="3.5" fill="${C.eyeDark}" />
        <circle cx="${CX - 7}" cy="${ey - 5}" r="2" fill="#fff" />
        <ellipse cx="${CX + 10}" cy="${ey - 2}" rx="7" ry="8" fill="#fff" />
        <ellipse cx="${CX + 11}" cy="${ey - 3}" rx="4.5" ry="5.5" fill="${C.eye}" />
        <ellipse cx="${CX + 11}" cy="${ey - 2}" rx="3" ry="3.5" fill="${C.eyeDark}" />
        <circle cx="${CX + 13}" cy="${ey - 5}" r="2" fill="#fff" />
      `;
      break;
  }

  // Mouth
  switch (mouthType) {
    case 'smile':
      mouth = `<path d="M${CX - 4},${ey + 14} Q${CX},${ey + 19} ${CX + 4},${ey + 14}" stroke="${C.mouth}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`;
      break;
    case 'open':
      mouth = `<ellipse cx="${CX}" cy="${ey + 16}" rx="4" ry="3.5" fill="${C.mouthOpen}" /><ellipse cx="${CX}" cy="${ey + 17}" rx="3" ry="2" fill="${C.mouth}" />`;
      break;
    case 'wide':
      mouth = `<ellipse cx="${CX}" cy="${ey + 15}" rx="5" ry="4.5" fill="${C.mouthOpen}" /><ellipse cx="${CX}" cy="${ey + 16}" rx="4" ry="3" fill="${C.mouth}" />`;
      break;
    case 'small':
      mouth = `<ellipse cx="${CX}" cy="${ey + 15}" rx="2" ry="2" fill="${C.mouth}" />`;
      break;
    case 'frown':
      mouth = `<path d="M${CX - 4},${ey + 18} Q${CX},${ey + 13} ${CX + 4},${ey + 18}" stroke="${C.mouth}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`;
      break;
    case 'wavy':
      mouth = `<path d="M${CX - 5},${ey + 15} L${CX - 2},${ey + 17} L${CX},${ey + 15} L${CX + 2},${ey + 17} L${CX + 5},${ey + 15}" stroke="${C.mouthOpen}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`;
      break;
    case 'none':
      break;
  }

  // Blush
  const blush = `
    <ellipse cx="${CX - 18}" cy="${ey + 7}" rx="6" ry="3.5" fill="${C.blush}" opacity="${blushOpacity}"/>
    <ellipse cx="${CX + 18}" cy="${ey + 7}" rx="6" ry="3.5" fill="${C.blush}" opacity="${blushOpacity}"/>
  `;

  // Nose
  const nose = `<path d="M${CX},${ey + 8} L${CX - 1.5},${ey + 10.5} L${CX + 1.5},${ey + 10.5}" fill="${C.skinShadow}" opacity="0.5"/>`;

  return eyes + nose + mouth + blush + extras;
}

function hairFront(y, sway = 0) {
  const sx = CX + sway;
  return `
    <!-- hair top (above forehead, does NOT cover eyes) -->
    <ellipse cx="${sx}" cy="${y - 78}" rx="30" ry="16" fill="${C.hair}" />
    <ellipse cx="${sx}" cy="${y - 76}" rx="28" ry="14" fill="${C.hair}" />
    <!-- bangs (above eyebrows, leaves eyes visible) -->
    <path d="M${sx - 26},${y - 65} Q${sx - 20},${y - 80} ${sx - 8},${y - 72} Q${sx - 4},${y - 64} ${sx - 14},${y - 58} Z" fill="${C.hair}" />
    <path d="M${sx - 14},${y - 72} Q${sx - 2},${y - 82} ${sx + 8},${y - 72} Q${sx + 4},${y - 64} ${sx - 4},${y - 58} Z" fill="${C.hairDark}" />
    <path d="M${sx + 8},${y - 72} Q${sx + 18},${y - 82} ${sx + 26},${y - 65} Q${sx + 18},${y - 60} ${sx + 14},${y - 58} Z" fill="${C.hair}" />
    <!-- ahoge (cowlick) -->
    <path d="M${sx + 2},${y - 92} Q${sx - 6},${y - 108} ${sx + 8},${y - 100}" stroke="${C.hair}" stroke-width="3" fill="none" stroke-linecap="round"/>
    <!-- side hair -->
    <path d="M${sx - 26},${y - 62} Q${sx - 30},${y - 45} ${sx - 24},${y - 30}" stroke="${C.hair}" stroke-width="6" fill="none" stroke-linecap="round"/>
    <path d="M${sx + 26},${y - 62} Q${sx + 30},${y - 45} ${sx + 24},${y - 30}" stroke="${C.hair}" stroke-width="6" fill="none" stroke-linecap="round"/>
    <!-- hair clip -->
    <circle cx="${sx + 22}" cy="${y - 66}" r="3" fill="${C.bow}" />
    <circle cx="${sx + 22}" cy="${y - 66}" r="1.5" fill="${C.bowDark}" />
  `;
}

// ── Full Character Compositions ─────────────────────────────────────────────

function characterIdle(breathe, blinkState, armWave) {
  const y = CHAR_Y;
  const aL = Math.sin(armWave) * 3;
  const aR = -aL;
  return svgBegin() + `
    ${hairBack(y)}
    ${leg(CX - 10, y + 4)}
    ${leg(CX + 10, y + 4)}
    ${body(y, breathe)}
    ${collar(y)}
    ${arm(CX - 22, y - 20, aL)}
    ${arm(CX + 22, y - 20, aR, true)}
    ${face(y, blinkState, 'smile')}
    ${hairFront(y)}
  ` + svgEnd;
}

function characterWalk(frame) {
  const y = CHAR_Y;
  const legAngles = [12, 6, -6, -12, -6, 6];
  const armAngles = [-15, -8, 8, 15, 8, -8];
  const breathe = [0, -1, -2, -1, 0, 1];
  const sway = [0, 1, 0, -1, 0, 1];
  const i = frame % 6;
  return svgBegin() + `
    ${hairBack(y, sway[i])}
    ${leg(CX - 10, y + 4, legAngles[i])}
    ${leg(CX + 10, y + 4, -legAngles[i])}
    ${body(y, breathe[i])}
    ${collar(y)}
    ${arm(CX - 22, y - 20, armAngles[i])}
    ${arm(CX + 22, y - 20, -armAngles[i], true)}
    ${face(y, 'normal', 'smile', 0.25)}
    ${hairFront(y, sway[i] * 0.5)}
  ` + svgEnd;
}

function characterObserve(frame) {
  const y = CHAR_Y;
  const bob = frame === 0 ? -4 : -2;
  return svgBegin() + `
    ${hairBack(y)}
    ${leg(CX - 10, y + 4)}
    ${leg(CX + 10, y + 4, 0)}
    ${body(y, bob)}
    ${collar(y)}
    <!-- hand shading eyes -->
    <g transform="translate(${CX + 20},${y - 28}) rotate(-30)">
      <rect x="-3" y="0" width="7" height="16" rx="3" fill="${C.skin}" />
      <circle cx="0.5" cy="18" r="4" fill="${C.skinShadow}" />
    </g>
    ${arm(CX - 22, y - 20, -10)}
    ${face(y, frame === 0 ? 'curious' : 'normal', 'small', 0.3)}
    ${hairFront(y)}
    <!-- hand above eyes -->
    <g transform="translate(${CX + 16},${y - 56}) rotate(-15)">
      <rect x="-3" y="0" width="6" height="5" rx="2" fill="${C.skin}" />
    </g>
  ` + svgEnd;
}

function characterThink(frame) {
  const y = CHAR_Y;
  const bob = Math.sin(frame * 1.2) * 1;
  return svgBegin() + `
    ${hairBack(y)}
    ${leg(CX - 10, y + 4)}
    ${leg(CX + 10, y + 4)}
    ${body(y, bob)}
    ${collar(y)}
    <!-- hand on chin -->
    <g transform="translate(${CX + 14},${y - 42}) rotate(-20)">
      <rect x="-3" y="0" width="6" height="12" rx="3" fill="${C.skin}" />
      <circle cx="0" cy="14" r="3.5" fill="${C.skinShadow}" />
    </g>
    ${arm(CX - 22, y - 20, -5)}
    ${face(y, 'think', 'none', 0.25)}
    ${hairFront(y)}
    <!-- thought bubble -->
    <circle cx="${CX + 30}" cy="${y - 80}" r="3" fill="rgba(255,255,255,0.7)" />
    <circle cx="${CX + 36}" cy="${y - 88}" r="5" fill="rgba(255,255,255,0.7)" />
    <ellipse cx="${CX + 44}" cy="${y - 98}" rx="12" ry="9" fill="rgba(255,255,255,0.8)" stroke="rgba(200,200,200,0.3)" stroke-width="0.5"/>
    <text x="${CX + 44}" y="${y - 95}" text-anchor="middle" font-size="9" fill="${C.eyeDark}">...</text>
  ` + svgEnd;
}

function characterSpeak(frame) {
  const y = CHAR_Y;
  const mouthTypes = ['open', 'wide', 'open', 'smile'];
  const armWave = Math.sin(frame * 2.5) * 15;
  const breathe = Math.sin(frame * 3) * 1;
  return svgBegin() + `
    ${hairBack(y)}
    ${leg(CX - 10, y + 4)}
    ${leg(CX + 10, y + 4)}
    ${body(y, breathe)}
    ${collar(y)}
    ${arm(CX - 22, y - 20, armWave)}
    ${arm(CX + 22, y - 20, -armWave * 0.5, true)}
    ${face(y, 'normal', mouthTypes[frame % 4], 0.4)}
    ${hairFront(y)}
  ` + svgEnd;
}

function characterSleep(frame) {
  const y = CHAR_Y;
  const lean = 3 + frame * 1;
  const breathe = Math.sin(frame * 0.8) * 2;
  return svgBegin() + `
    ${hairBack(y)}
    ${leg(CX - 10, y + 4)}
    ${leg(CX + 10, y + 4)}
    ${body(y, breathe)}
    ${collar(y)}
    ${arm(CX - 22, y - 20, 10)}
    ${arm(CX + 22, y - 20, -10, true)}
    ${face(y, 'closed', 'small', 0.2)}
    ${hairFront(y, lean * 0.3)}
    <!-- Zzz -->
    <text x="${CX + 25}" y="${y - 85}" font-size="11" fill="rgba(140,180,255,0.7)" font-weight="bold" font-style="italic">Z</text>
    <text x="${CX + 35}" y="${y - 95}" font-size="9" fill="rgba(140,180,255,0.5)" font-weight="bold" font-style="italic">z</text>
    <text x="${CX + 42}" y="${y - 102}" font-size="7" fill="rgba(140,180,255,0.3)" font-weight="bold" font-style="italic">z</text>
  ` + svgEnd;
}

function characterHappy(frame) {
  const y = CHAR_Y;
  const jump = [0, 8, 14, 6][frame % 4];
  const jy = y - jump;
  const armUp = [-50, -60, -55, -45][frame % 4];
  return svgBegin() + `
    ${hairBack(jy, Math.sin(frame * 2) * 2)}
    ${leg(CX - 10, jy + 4, jump > 5 ? -8 : 0)}
    ${leg(CX + 10, jy + 4, jump > 5 ? 8 : 0)}
    ${body(jy, -jump * 0.5)}
    ${collar(jy)}
    ${arm(CX - 22, jy - 20, armUp)}
    ${arm(CX + 22, jy - 20, -armUp, true)}
    ${face(jy, 'happy', 'wide', 0.5)}
    ${hairFront(jy, Math.sin(frame * 2) * 1.5)}
    <!-- sparkles -->
    <text x="${CX - 30}" y="${jy - 80 + frame * 2}" font-size="10" opacity="${0.8 - frame * 0.15}">✨</text>
    <text x="${CX + 28}" y="${jy - 75 + frame * 2}" font-size="8" opacity="${0.6 - frame * 0.1}">💖</text>
  ` + svgEnd;
}

function characterSad(frame) {
  const y = CHAR_Y;
  const droop = frame * 2;
  return svgBegin() + `
    ${hairBack(y)}
    ${leg(CX - 10, y + 4)}
    ${leg(CX + 10, y + 4)}
    ${body(y, droop)}
    ${collar(y)}
    ${arm(CX - 22, y - 16, 15)}
    ${arm(CX + 22, y - 16, -15, true)}
    ${face(y, 'sad', 'frown', 0.2)}
    ${hairFront(y)}
    <!-- tear -->
    <ellipse cx="${CX - 12}" cy="${y - 42 + frame * 3}" rx="1.5" ry="2.5" fill="rgba(100,180,255,0.6)" opacity="${Math.max(0, 1 - frame * 0.3)}"/>
  ` + svgEnd;
}

function characterCurious(frame) {
  const y = CHAR_Y;
  const tilt = [0, 3, 5][frame % 3];
  return svgBegin() + `
    <g transform="rotate(${tilt},${CX},${y - 40})">
      ${hairBack(y)}
      ${leg(CX - 10, y + 4)}
      ${leg(CX + 10, y + 4)}
      ${body(y, 0)}
      ${collar(y)}
      ${arm(CX - 22, y - 20, -10)}
      <!-- hand near mouth -->
      <g transform="translate(${CX + 18},${y - 40}) rotate(-10)">
        <rect x="-3" y="0" width="6" height="12" rx="3" fill="${C.skin}" />
        <circle cx="0" cy="14" r="3.5" fill="${C.skinShadow}" />
      </g>
      ${face(y, 'curious', 'small', 0.3)}
      ${hairFront(y, tilt * 0.3)}
    </g>
  ` + svgEnd;
}

function characterAngry(frame) {
  const y = CHAR_Y;
  const stomp = frame === 0 ? 0 : -3;
  return svgBegin() + `
    ${hairBack(y)}
    ${leg(CX - 10, y + 4, frame === 1 ? 5 : 0)}
    ${leg(CX + 10, y + 4, frame === 1 ? -5 : 0)}
    ${body(y, stomp)}
    ${collar(y)}
    <!-- arms akimbo -->
    <g transform="translate(${CX - 22},${y - 20}) rotate(-35)">
      <rect x="-3" y="0" width="7" height="16" rx="3" fill="${C.skin}" />
      <circle cx="0.5" cy="18" r="4" fill="${C.skinShadow}" />
    </g>
    <g transform="translate(${CX + 22},${y - 20}) rotate(35)">
      <rect x="-3" y="0" width="7" height="16" rx="3" fill="${C.skin}" />
      <circle cx="0.5" cy="18" r="4" fill="${C.skinShadow}" />
    </g>
    ${face(y, 'angry', 'wavy', 0.45)}
    ${hairFront(y)}
    <!-- anger mark -->
    <g transform="translate(${CX + 24},${y - 78})">
      <line x1="-3" y1="-3" x2="3" y2="3" stroke="${C.bow}" stroke-width="2" stroke-linecap="round"/>
      <line x1="3" y1="-3" x2="-3" y2="3" stroke="${C.bow}" stroke-width="2" stroke-linecap="round"/>
    </g>
  ` + svgEnd;
}

function characterAlert(frame) {
  const y = CHAR_Y;
  const tense = frame === 0 ? 0 : -2;
  return svgBegin() + `
    ${hairBack(y)}
    ${leg(CX - 10, y + 4)}
    ${leg(CX + 10, y + 4)}
    ${body(y, tense)}
    ${collar(y)}
    ${arm(CX - 22, y - 22, -20)}
    ${arm(CX + 22, y - 22, 20, true)}
    ${face(y, frame === 0 ? 'normal' : 'curious', 'small', 0.3)}
    ${hairFront(y)}
    <!-- alert lines -->
    <line x1="${CX - 30}" y1="${y - 80}" x2="${CX - 24}" y2="${y - 75}" stroke="${C.eye}" stroke-width="1.5" opacity="0.5"/>
    <line x1="${CX + 24}" y1="${y - 75}" x2="${CX + 30}" y2="${y - 80}" stroke="${C.eye}" stroke-width="1.5" opacity="0.5"/>
  ` + svgEnd;
}

// ── Export all sprite definitions ───────────────────────────────────────────

function buildCharacterSprites(spriteManager) {
  // Idle: 4 frames (breathing + blink cycle)
  spriteManager.registerState('idle', [
    characterIdle(0, 'normal', 0),
    characterIdle(-1.5, 'blink', 0.8),
    characterIdle(-2, 'closed', 1.2),
    characterIdle(-1, 'normal', 1.6),
  ], 4);

  // Walk: 6 frames
  spriteManager.registerState('walk', [
    characterWalk(0), characterWalk(1), characterWalk(2),
    characterWalk(3), characterWalk(4), characterWalk(5),
  ], 8);

  // Patrol: reuse walk
  spriteManager.registerState('patrol', [
    characterWalk(0), characterWalk(1), characterWalk(2),
    characterWalk(3), characterWalk(4), characterWalk(5),
  ], 8);

  // Approach: reuse walk but slightly faster
  spriteManager.registerState('approach', [
    characterWalk(0), characterWalk(1), characterWalk(2),
    characterWalk(3), characterWalk(4), characterWalk(5),
  ], 10);

  // Observe: 2 frames
  spriteManager.registerState('observe', [
    characterObserve(0),
    characterObserve(1),
  ], 2);

  // Think: 3 frames
  spriteManager.registerState('think', [
    characterThink(0),
    characterThink(1),
    characterThink(2),
  ], 2);

  // Speak: 4 frames
  spriteManager.registerState('speak', [
    characterSpeak(0), characterSpeak(1),
    characterSpeak(2), characterSpeak(3),
  ], 6);

  // Sleep: 3 frames
  spriteManager.registerState('sleep', [
    characterSleep(0),
    characterSleep(1),
    characterSleep(2),
  ], 1.5);

  // Happy: 4 frames
  spriteManager.registerState('happy', [
    characterHappy(0), characterHappy(1),
    characterHappy(2), characterHappy(3),
  ], 8);

  // Sad: 3 frames
  spriteManager.registerState('sad', [
    characterSad(0),
    characterSad(1),
    characterSad(2),
  ], 3);

  // Curious: 3 frames
  spriteManager.registerState('curious', [
    characterCurious(0),
    characterCurious(1),
    characterCurious(2),
  ], 3);

  // Angry: 2 frames
  spriteManager.registerState('angry', [
    characterAngry(0),
    characterAngry(1),
  ], 4);

  // Alert: 2 frames
  spriteManager.registerState('alert', [
    characterAlert(0),
    characterAlert(1),
  ], 3);
}

window.buildCharacterSprites = buildCharacterSprites;
