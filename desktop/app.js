const API = 'http://localhost:3000';

function getTauri() { return window.__TAURI__ || {}; }
function getEmit() { return getTauri().event?.emit; }
function getListen() { return getTauri().event?.listen; }
function getCurrentWindow() {
  return getTauri().window?.getCurrentWindow?.()
    || getTauri().window?.getCurrent?.()
    || null;
}

function emitPetEvent(event, payload) {
  const emit = getEmit();
  if (emit) emit(event, payload || {});
}

const appEl = document.getElementById('app');
const chatEl = document.getElementById('chat');
const msgEl = document.getElementById('messages');
const inpEl = document.getElementById('input');
const sndEl = document.getElementById('send-btn');
const hideBtn = document.getElementById('hide-btn');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

let busy = false;
let reader = null;
let ctrl = null;
let chatOpen = true;

function setStatus(text, type = 'ok') {
  if (!statusText || !statusDot) return;
  statusText.textContent = text;
  statusDot.className = 'dot';
  if (type === 'connecting') statusDot.classList.add('connecting');
  if (type === 'error') statusDot.classList.add('error');
}

function initDrag() {
  const header = document.getElementById('header');
  if (!header) return;
  header.addEventListener('mousedown', (event) => {
    if (event.target === hideBtn) return;
    const win = getCurrentWindow();
    try { win?.startDragging?.(); } catch {}
  });
}

function toggleChat() {
  chatOpen = !chatOpen;
  appEl.classList.toggle('collapsed', !chatOpen);
  updateChatAreaForPet();
  if (chatOpen) setTimeout(() => inpEl.focus(), 250);
}

hideBtn.addEventListener('click', toggleChat);

inpEl.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    busy ? cancel() : send();
  }
});

sndEl.addEventListener('click', () => {
  if (!busy) send();
});

inpEl.addEventListener('input', () => {
  if (inpEl.value.length > 0) emitPetEvent('chat-user-typing');
});

async function initListeners() {
  const listen = getListen();
  if (!listen) return;
  await listen('toggle-chat-window', () => toggleChat());
}

async function updateChatAreaForPet() {
  const rect = chatEl.getBoundingClientRect();
  const win = getCurrentWindow();
  let offset = { x: 0, y: 0 };
  try {
    const pos = await (win?.outerPosition?.() || win?.getPosition?.());
    if (pos) offset = { x: pos.x, y: pos.y };
  } catch {}

  emitPetEvent('chat-area-update', {
    x: offset.x + rect.left,
    y: offset.y + rect.top,
    w: rect.width,
    h: rect.height,
    open: chatOpen,
  });
}

function cancel() {
  if (ctrl) {
    ctrl.abort();
    ctrl = null;
    reader = null;
  }
  busy = false;
  sndEl.disabled = false;
  inpEl.disabled = false;
  addMessage('已取消', 's');
  setStatus('就绪');
  emitPetEvent('chat-query-end', { success: false, cancelled: true });
  inpEl.focus();
}

async function send() {
  const question = inpEl.value.trim();
  if (!question || busy) return;
  if (ctrl) {
    ctrl.abort();
    ctrl = null;
    reader = null;
  }

  inpEl.value = '';
  addMessage(question, 'u');
  emitPetEvent('chat-query-start');
  setStatus('思考中...', 'connecting');
  busy = true;
  sndEl.disabled = true;
  inpEl.disabled = true;
  ctrl = new AbortController();

  try {
    const res = await fetch(API + '/api/ask/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, sessionId: 'desktop-pet' }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let bot = null;
    let buffer = '';
    setStatus('回答中...', 'connecting');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6).trim());
          if (event.token) {
            if (!bot) bot = addMessage('', 'b');
            bot.textContent += event.token;
            emitPetEvent('chat-query-token');
            scroll();
          }
          if (event.tool) {
            setStatus(`正在使用工具：${event.tool}`, 'connecting');
          }
          if (event.error) {
            addMessage(event.error, 'e');
          }
        } catch {
          // Ignore malformed SSE fragments.
        }
      }
    }

    const success = !!(bot && bot.textContent);
    emitPetEvent('chat-query-end', { success });
    setStatus(success ? '就绪' : '未收到回答', success ? 'ok' : 'error');
  } catch (error) {
    if (error.name !== 'AbortError') {
      addMessage('请求失败：' + error.message, 'e');
      emitPetEvent('chat-query-end', { success: false });
      setStatus('请求失败', 'error');
    }
  } finally {
    reader = null;
    ctrl = null;
    busy = false;
    sndEl.disabled = false;
    inpEl.disabled = false;
    inpEl.focus();
  }
}

function addMessage(text, cls) {
  const el = document.createElement('div');
  el.className = 'm ' + cls;
  el.textContent = text;
  msgEl.appendChild(el);
  scroll();
  return el;
}

function scroll() {
  requestAnimationFrame(() => {
    msgEl.scrollTop = msgEl.scrollHeight;
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function init() {
  initDrag();
  initListeners();
  setStatus('连接中...', 'connecting');
  setTimeout(updateChatAreaForPet, 500);
  setInterval(updateChatAreaForPet, 3000);

  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(API + '/api/status');
      if (res.ok) {
        const data = await res.json();
        setStatus(`已连接 - ${data.chunkCount} 条知识片段`);
        inpEl.focus();
        return;
      }
    } catch {}
    await sleep(500);
  }
  setStatus('连接超时', 'error');
}

init();
