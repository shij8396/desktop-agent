(function () {
  const menu = document.getElementById('context-menu');
  if (!menu) return;

  function getInvoke() { return window.__TAURI__?.core?.invoke; }
  function getEmit() { return window.__TAURI__?.event?.emit; }

  function showMenu(x, y) {
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.classList.remove('hidden');
  }

  function hideMenu() {
    menu.classList.add('hidden');
  }

  document.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    showMenu(event.clientX, event.clientY);
  });

  menu.addEventListener('click', (event) => {
    const item = event.target.closest('.context-menu-item');
    if (!item) return;
    const action = item.dataset.action;
    hideMenu();

    if (action === 'close') {
      const invoke = getInvoke();
      if (invoke) invoke('quit_app');
      else window.close();
    }

    if (action === 'toggle-chat') {
      const emit = getEmit();
      if (emit) emit('toggle-chat-window', {});
    }
  });

  document.addEventListener('mousedown', (event) => {
    if (!menu.classList.contains('hidden') && !menu.contains(event.target)) {
      hideMenu();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideMenu();
  });
})();
