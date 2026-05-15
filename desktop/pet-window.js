function getTauri() { return window.__TAURI__ || {}; }
function getInvoke() { return getTauri().core?.invoke; }
function getListen() { return getTauri().event?.listen; }
function getCurrentWindow() {
  return getTauri().window?.getCurrentWindow?.()
    || getTauri().window?.getCurrent?.()
    || null;
}

let petRuntime;
let petEmotion;
let petBehavior;
let petRenderer;
let petSpriteManager;
let isDragging = false;
const POS_KEY = 'rag-pet-position';

async function initPet() {
  const canvas = document.getElementById('pet-canvas');
  if (!canvas) return;

  petRuntime = new CharacterRuntime();
  petEmotion = new EmotionState();
  petBehavior = new DesktopBehavior(petRuntime);

  petSpriteManager = new SpriteManager();
  buildCharacterSprites(petSpriteManager);
  await petSpriteManager.preloadAll();

  petRenderer = createRenderer(detectBestRenderer(), canvas, petRuntime, petEmotion, petSpriteManager);
  petBehavior.petRenderer = petRenderer;
  petRuntime.on('stateChange', () => petRenderer?.onStateChange?.());

  await loadMonitorInfo();
  restorePosition();
  await syncWindowPosition();
  initCanvasInteraction(canvas);

  petRuntime.start();
  petBehavior.start();
  requestAnimationFrame(movementLoop);
  await listenForChatEvents();
  setInterval(savePosition, 5000);
}

function initCanvasInteraction(canvas) {
  let startX = 0;
  let startY = 0;
  let startWinX = 0;
  let startWinY = 0;
  let moved = false;

  canvas.addEventListener('mousedown', async (event) => {
    if (event.button !== 0) return;
    startX = event.screenX;
    startY = event.screenY;
    moved = false;

    const win = getCurrentWindow();
    try {
      const pos = await (win?.outerPosition?.() || win?.getPosition?.());
      if (pos) {
        startWinX = pos.x;
        startWinY = pos.y;
      }
    } catch {}

    const onMove = (moveEvent) => {
      const dx = moveEvent.screenX - startX;
      const dy = moveEvent.screenY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        moved = true;
        isDragging = true;
        setPetWindowPosition(startWinX + dx, startWinY + dy);
      }
    };

    const onUp = async () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);

      if (moved) {
        const pos = await getCurrentWindowPosition();
        if (pos) {
          petBehavior.pos.x = pos.x + 90;
          petBehavior.pos.y = pos.y + 300;
          petBehavior.target = null;
          petBehavior._pauseTimer = 2;
          savePosition();
        }
        setTimeout(() => { isDragging = false; }, 200);
      } else {
        petBehavior.onUserClick();
        showBubble('我在这里。', 2000);
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function savePosition() {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify({ x: petBehavior.pos.x, y: petBehavior.pos.y }));
  } catch {}
}

function restorePosition() {
  try {
    const saved = localStorage.getItem(POS_KEY);
    if (!saved) return;
    const pos = JSON.parse(saved);
    if (typeof pos.x === 'number' && typeof pos.y === 'number') {
      petBehavior.pos.x = pos.x;
      petBehavior.pos.y = pos.y;
    }
  } catch {}
}

async function loadMonitorInfo() {
  try {
    const invoke = getInvoke();
    if (invoke) {
      const area = await invoke('get_work_area');
      petBehavior.setDesktopBounds(area.width, area.height, area.x, area.y);
      if (!localStorage.getItem(POS_KEY)) {
        petBehavior.pos.x = area.x + area.width - 220;
        petBehavior.pos.y = area.y + area.height - 340;
      }
      return;
    }
  } catch {}
  petBehavior.setDesktopBounds(window.screen.width || 1920, (window.screen.height || 1080) - 48, 0, 0);
}

let lastFrameTime = 0;
let posSyncCounter = 0;

function movementLoop(timestamp) {
  const dt = Math.min(lastFrameTime ? (timestamp - lastFrameTime) / 1000 : 0.016, 0.05);
  lastFrameTime = timestamp;
  if (!isDragging) petBehavior.updateMovement(dt);
  if (++posSyncCounter % 2 === 0 && !isDragging) syncWindowPosition();
  requestAnimationFrame(movementLoop);
}

async function getCurrentWindowPosition() {
  const win = getCurrentWindow();
  try {
    return await (win?.outerPosition?.() || win?.getPosition?.());
  } catch {
    return null;
  }
}

function setPetWindowPosition(x, y) {
  const invoke = getInvoke();
  if (invoke) {
    invoke('set_pet_position', { x: Math.round(x), y: Math.round(y) }).catch(() => {});
    return;
  }
  const win = getCurrentWindow();
  try {
    win?.setPosition?.({ x: Math.round(x), y: Math.round(y), type: 'Physical' });
  } catch {}
}

async function syncWindowPosition() {
  setPetWindowPosition(petBehavior.pos.x - 90, petBehavior.pos.y - 300);
}

async function listenForChatEvents() {
  const listen = getListen();
  if (!listen) return;

  await listen('chat-query-start', () => {
    petBehavior?.onQueryStart();
    petEmotion?.handleEvent('query_start');
  });
  await listen('chat-query-end', (event) => {
    const ok = event.payload?.success ?? true;
    petBehavior?.onQueryEnd(ok);
    petEmotion?.handleEvent(ok ? 'query_success' : 'query_error');
    if (!ok && !event.payload?.cancelled) showBubble('出错了，请重试。', 3000);
  });
  await listen('chat-query-token', () => {
    if (petRuntime?.state !== 'speak') petRuntime?.onSpeaking();
  });
  await listen('chat-area-update', (event) => {
    const { x, y, w, h, open } = event.payload || {};
    if (x != null && open !== false) petBehavior?.setChatArea(x, y, w, h);
  });
  await listen('chat-user-typing', () => {
    if (petBehavior && !isDragging) petBehavior.onUserTyping();
  });
}

const bubbleEl = document.getElementById('speech-bubble');
const bubbleText = document.getElementById('bubble-text');
let bubbleTimer = null;

function showBubble(text, ms = 4000) {
  if (!bubbleEl || !bubbleText) return;
  bubbleText.textContent = text;
  bubbleEl.classList.remove('hidden');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubbleEl.classList.add('hidden'), ms);
}

function startProactiveBehavior() {
  setTimeout(() => showBubble('你好，我是你的桌面助手。', 5000), 2000);
  setInterval(() => {
    if (petRuntime?.state === 'idle' && petRuntime.idleSec > 30) {
      const messages = ['有什么可以帮你的吗？', '需要我搜索点什么吗？', '我在。', '随时为你服务。', '右键可以打开菜单。'];
      showBubble(messages[Math.floor(Math.random() * messages.length)], 4000);
      petRuntime.onCurious();
    }
  }, 45000);
}

initPet().then(() => startProactiveBehavior());
