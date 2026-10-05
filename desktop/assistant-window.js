(function () {
  'use strict';

  const Shared = window.AssistantShared || {};
  const Voice = window.VoiceModule || {};
  const VoicePreference = window.AssistantVoicePreference;
  const transcript = window.AssistantTranscript?.createTranscriptAssembler();
  const {
    getInvoke, getListen, initApi, apiHeaders, getApiBase, executeAgent, waitForServer,
  } = Shared;

  const PREFS_KEY = 'desktop-assistant-preferences';
  const SESSION_ID = 'desktop-assistant';
  const MAX_MESSAGES = 100;
  const MAX_ACTIVITY = 10;
  const $ = id => document.getElementById(id);

  const messages = $('messages');
  const input = $('chat-input');
  const form = $('chat-form');
  const sendButton = $('send-button');
  const micButton = $('mic-button');
  const status = $('assistant-status');
  const connectionBadge = $('connection-badge');
  const welcomeState = $('welcome-state');
  const flow = $('agent-flow');
  const flowItems = $('agent-flow-items');
  const modeIndicator = $('mode-indicator');
  const inputCount = $('input-count');
  const workspace = document.querySelector('.workspace');
  const taskPanel = $('task-panel');
  const taskPanelButton = $('task-panel-button');
  const taskPanelButtonLabel = $('task-panel-button-label');
  const taskPanelClose = $('task-panel-close');
  const compactTask = $('compact-task');
  const compactTaskTitle = $('compact-task-title');
  const compactTaskDetail = $('compact-task-detail');
  const compactTaskProgress = $('compact-task-progress');
  const compactTaskProgressFill = $('compact-task-progress-fill');
  const compactTaskOpen = $('compact-task-open');
  const taskSummary = $('task-summary');
  const taskStatusLabel = $('task-status-label');
  const taskStepCount = $('task-step-count');
  const taskRequest = $('task-request');
  const taskProgressText = $('task-progress-text');
  const taskSteps = $('task-steps');
  const approvalList = $('approval-list');
  const desktopApprovalList = $('desktop-approval-list');
  const approvalCount = $('approval-count');
  const activityList = $('activity-list');
  const drawer = $('settings-drawer');
  const drawerBackdrop = $('drawer-backdrop');
  const settingsButton = $('settings-button');
  const settingsClose = $('settings-close');
  const providerButtons = [...document.querySelectorAll('[data-provider]')];
  const apiKeyInput = $('settings-api-key');
  const baseUrlInput = $('settings-base-url');
  const modelInput = $('settings-model');
  const desktopAccess = $('settings-desktop-access');
  const screenCapture = $('settings-screen-capture');
  const inputControl = $('settings-input-control');
  const trustedFolders = $('settings-trusted-folders');
  const voiceEnabled = $('settings-voice-enabled');
  const voiceTone = $('settings-voice-tone');
  const proactiveCare = $('settings-proactive-care');
  const proactiveVision = $('settings-proactive-vision');
  const dndMode = $('settings-dnd-mode');
  const settingsSave = $('settings-save');
  const settingsClear = $('settings-clear');
  const settingsHint = $('settings-hint');
  const memoryList = $('memory-list');
  const memoryRefresh = $('memory-refresh');
  const knowledgeStatus = $('knowledge-status');
  const knowledgeRefresh = $('knowledge-refresh');
  const toastRegion = $('toast-region');

  let provider = 'deepseek';
  let settingsState = null;
  let busy = false;
  let latestPlan = null;
  let controller = null;
  let activeRequestId = null;
  let stopRequested = false;
  const pendingDesktopApprovals = new Map();
  let serverApprovalCount = 0;

  const statusLabels = {
    planning: '正在规划', executing: '执行中', paused: '等待确认', completed: '已完成',
    failed: '执行失败', cancelled: '已取消', idle: '等待任务',
  };
  const stepLabels = {
    pending: '待执行', awaiting_confirm: '待确认', executing: '执行中', completed: '完成',
    failed: '失败', skipped: '已跳过',
  };

  function setStatus(text, state = 'online') {
    if (status) status.textContent = text;
    if (connectionBadge) connectionBadge.className = `connection-badge ${state}`;
  }

  function stripMarkdown(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, '代码块')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/(^|\n)\s*#{1,6}\s*/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/(^|\n)\s*>\s?/g, '$1')
      .trim();
  }

  function hideWelcome() {
    if (welcomeState) welcomeState.hidden = true;
  }

  function addMessage(text, kind = 'assistant') {
    if (kind !== 'system') hideWelcome();
    const node = document.createElement('div');
    node.className = `message ${kind}`;
    let content = node;
    if (kind === 'assistant' || kind === 'user') {
      const bubble = document.createElement('div');
      bubble.className = 'message-bubble';
      content = document.createElement('div');
      content.className = 'message-content';
      content.textContent = kind === 'assistant' ? stripMarkdown(text) : String(text || '');
      const time = document.createElement('time');
      time.className = 'message-time';
      const now = new Date();
      time.dateTime = now.toISOString();
      time.textContent = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      bubble.append(content, time);
      if (kind === 'assistant') {
        const avatar = document.createElement('span');
        avatar.className = 'assistant-avatar';
        avatar.setAttribute('aria-hidden', 'true');
        const icon = document.createElement('i');
        icon.className = 'ph ph-sparkle';
        avatar.appendChild(icon);
        node.append(avatar, bubble);
      } else node.appendChild(bubble);
    } else node.textContent = String(text || '');
    messages.appendChild(node);
    while (messages.querySelectorAll('.message').length > MAX_MESSAGES) {
      messages.querySelector('.message')?.remove();
    }
    requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; });
    return content;
  }

  function addFlow(text, kind = 'thought') {
    if (!text) return;
    flow.classList.remove('hidden');
    const node = document.createElement('div');
    node.className = `flow-item ${kind}`;
    node.textContent = text;
    flowItems.appendChild(node);
    if (busy && compactTaskDetail) compactTaskDetail.textContent = stripMarkdown(text).replace(/\s+/g, ' ').slice(0, 72);
    while (flowItems.children.length > 6) flowItems.firstElementChild?.remove();
    flowItems.scrollTop = flowItems.scrollHeight;
  }

  function addActivity(text, kind = 'info') {
    if (!text) return;
    activityList.querySelector('.empty-panel-state')?.remove();
    const node = document.createElement('div');
    node.className = `activity-item ${kind}`;
    const dot = document.createElement('span');
    dot.className = 'activity-dot';
    const copy = document.createElement('span');
    const normalized = stripMarkdown(text).replace(/\s+/g, ' ').trim();
    copy.textContent = normalized.length > 180 ? `${normalized.slice(0, 180)}…` : normalized;
    copy.title = normalized.length > 180 ? '完整结果已用于生成回答' : '';
    node.append(dot, copy);
    activityList.prepend(node);
    while (activityList.children.length > MAX_ACTIVITY) activityList.lastElementChild?.remove();
  }

  function renderPlan(plan) {
    if (!plan) return;
    latestPlan = plan;
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    const completed = steps.filter(step => step.status === 'completed').length;
    const currentStatus = plan.status || 'planning';
    taskSummary.className = `task-summary ${currentStatus}`;
    taskStatusLabel.textContent = statusLabels[currentStatus] || currentStatus;
    taskStepCount.textContent = `${steps.length} 步`;
    taskRequest.textContent = plan.user_request || '正在处理当前任务';
    taskProgressText.textContent = steps.length ? `${completed} / ${steps.length} 已完成` : '等待实际工具调用';
    updateCompactTask();
    const complexRequest = /(深度研究|深度调研|全面调研|多来源|批量分析|拆分子任务|子智能体|长时间任务|复杂任务|deep\s*agent)/i.test(plan.user_request || '');
    modeIndicator.textContent = complexRequest ? '深度任务' : '智能执行';
    taskSteps.innerHTML = '';
    if (!steps.length) {
      const empty = document.createElement('li');
      empty.className = 'empty-panel-state';
      empty.textContent = currentStatus === 'completed' ? '本次对话无需调用工具' : '本次任务尚未调用工具';
      taskSteps.appendChild(empty);
      return;
    }
    for (const [index, step] of steps.entries()) {
      const item = document.createElement('li');
      item.className = `task-step ${step.status || 'pending'}`;
      const marker = document.createElement('span');
      marker.className = 'step-marker';
      marker.textContent = step.status === 'completed' ? '✓' : step.status === 'skipped' ? '—' : String(index + 1);
      const body = document.createElement('div');
      body.className = 'step-body';
      const title = document.createElement('strong');
      title.textContent = step.description || step.tool || '执行任务';
      const meta = document.createElement('div');
      meta.className = 'step-meta';
      const state = document.createElement('span');
      state.textContent = stepLabels[step.status] || step.status || '待执行';
      meta.appendChild(state);
      if (step.tool) {
        const tool = document.createElement('span');
        tool.textContent = step.tool;
        meta.appendChild(tool);
      }
      if (step.risk_level && step.risk_level !== 'L0') {
        const risk = document.createElement('span');
        risk.className = `risk-badge ${step.risk_level.toLowerCase()}`;
        risk.textContent = step.risk_level;
        meta.appendChild(risk);
      }
      body.append(title, meta);
      item.append(marker, body);
      taskSteps.appendChild(item);
    }
  }

  function updateCompactTask() {
    const steps = Array.isArray(latestPlan?.steps) ? latestPlan.steps : [];
    const completed = steps.filter(step => step.status === 'completed').length;
    const pending = serverApprovalCount + pendingDesktopApprovals.size;
    const state = latestPlan?.status;
    const active = busy || pending > 0 || state === 'planning' || state === 'executing' || state === 'paused';
    compactTask.hidden = !active;
    if (!active) return;
    compactTask.classList.toggle('awaiting-confirmation', pending > 0 || state === 'paused');
    compactTaskTitle.textContent = pending > 0 || state === 'paused'
      ? '有操作等待确认'
      : state === 'executing' ? '正在执行任务…' : '正在处理任务…';
    compactTaskDetail.textContent = steps.length
      ? `已完成 ${completed} / ${steps.length} 步${pending ? ` · ${pending} 项待确认` : ''}`
      : '执行过程会显示在任务中心';
    const percent = steps.length ? Math.round(completed / steps.length * 100) : 0;
    compactTaskProgress.setAttribute('aria-valuenow', String(percent));
    compactTaskProgressFill.style.width = `${percent}%`;
  }

  function setBusy(next) {
    busy = next;
    input.disabled = next;
    sendButton.querySelector('.button-label').textContent = next ? '停止' : '发送';
    sendButton.querySelector('i').className = next ? 'ph ph-stop' : 'ph ph-paper-plane-right';
    sendButton.classList.toggle('danger', next);
    sendButton.setAttribute('aria-label', next ? '停止当前任务' : '发送消息');
    sendButton.title = next ? '停止当前任务' : '发送消息';
    updateCompactTask();
    $('typing-indicator')?.remove();
    if (next) {
      const indicator = document.createElement('div');
      indicator.id = 'typing-indicator';
      indicator.className = 'typing-indicator';
      indicator.innerHTML = '<i></i><i></i><i></i>';
      messages.appendChild(indicator);
    }
  }

  function isNarrow() { return window.matchMedia('(max-width: 780px)').matches; }

  function openTaskPanel(show = true) {
    if (isNarrow()) taskPanel.classList.toggle('open', show);
    else workspace.classList.toggle('task-panel-hidden', !show);
    taskPanelButton.setAttribute('aria-expanded', String(show));
    taskPanel.setAttribute('aria-hidden', String(!show));
    taskPanel.inert = !show;
  }

  function updateApprovalCount() {
    const total = serverApprovalCount + pendingDesktopApprovals.size;
    approvalCount.textContent = String(total);
    taskPanelButtonLabel.textContent = total ? `任务中心 (${total} 待确认)` : '任务中心';
    approvalList.querySelector('.empty-panel-state')?.toggleAttribute('hidden', serverApprovalCount > 0 || pendingDesktopApprovals.size > 0);
    updateCompactTask();
  }

  function openSettings(show = true) {
    drawer.classList.toggle('open', show);
    drawer.setAttribute('aria-hidden', String(!show));
    drawer.inert = !show;
    drawerBackdrop.hidden = !show;
    if (show) { apiKeyInput.focus(); loadMemories(); loadKnowledgeStatus(); }
    else input.focus();
  }

  async function mutateMemory(scope, type, key, value) {
    const endpoint = value === undefined ? 'delete' : 'update';
    const response = await fetch(`${getApiBase()}/api/memories/${endpoint}`, {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ scope, type, key, ...(value === undefined ? {} : { value }) }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
    await loadMemories();
  }

  async function loadMemories() {
    if (!memoryList) return;
    memoryList.textContent = '正在加载…';
    try {
      const response = await fetch(`${getApiBase()}/api/memories`, { headers: apiHeaders() });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const entries = [
        ...(data.profile || []).map(item => ({ ...item, scope: 'profile', type: item.category })),
        ...(data.memories || []).map(item => ({ ...item, scope: 'memory' })),
      ];
      memoryList.replaceChildren();
      if (!entries.length) { memoryList.textContent = '暂无已保存的偏好或画像。'; return; }
      for (const entry of entries) {
        const card = document.createElement('div');
        card.className = 'memory-entry';
        const label = document.createElement('strong');
        label.textContent = entry.key;
        const category = document.createElement('small');
        category.textContent = `${entry.scope === 'profile' ? '用户画像' : '长期记忆'} · ${entry.type}`;
        const value = document.createElement('input');
        value.type = 'text';
        value.value = entry.value;
        value.maxLength = entry.scope === 'profile' ? 300 : 500;
        value.setAttribute('aria-label', `修改 ${entry.key}`);
        const actions = document.createElement('div');
        actions.className = 'memory-actions';
        const save = document.createElement('button');
        save.type = 'button';
        save.textContent = '保存修改';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'delete';
        remove.textContent = '删除';
        save.addEventListener('click', async () => {
          try { await mutateMemory(entry.scope, entry.type, entry.key, value.value); showToast(`已更新：${entry.key}`); }
          catch (error) { showToast(`更新失败：${error.message}`); }
        });
        remove.addEventListener('click', async () => {
          if (!window.confirm(`确定删除“${entry.key}”吗？`)) return;
          try { await mutateMemory(entry.scope, entry.type, entry.key); showToast(`已删除：${entry.key}`); }
          catch (error) { showToast(`删除失败：${error.message}`); }
        });
        actions.append(save, remove);
        card.append(label, category, value, actions);
        memoryList.appendChild(card);
      }
    } catch (error) { memoryList.textContent = `无法加载记忆：${error.message}`; }
  }

  async function loadKnowledgeStatus() {
    if (!knowledgeStatus) return;
    knowledgeStatus.textContent = '正在加载…';
    try {
      const response = await fetch(`${getApiBase()}/api/status`, { headers: apiHeaders() });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const sources = Array.isArray(data.sources) ? data.sources : [];
      const chunks = Number.isFinite(data.chunkCount) ? data.chunkCount : 0;
      knowledgeStatus.replaceChildren();
      const summary = document.createElement('p');
      summary.className = 'memory-note';
      summary.textContent = sources.length
        ? `已索引 ${sources.length} 个来源、${chunks} 个片段。回答知识库问题时会检索这些资料。`
        : '知识库目前没有已索引文档；知识库问题不会有本地引用。';
      knowledgeStatus.appendChild(summary);
      for (const source of sources.slice(0, 50)) {
        const item = document.createElement('div');
        item.className = 'memory-entry';
        item.textContent = String(source);
        knowledgeStatus.appendChild(item);
      }
      if (sources.length > 50) {
        const more = document.createElement('p');
        more.className = 'memory-note';
        more.textContent = `另有 ${sources.length - 50} 个来源未显示。`;
        knowledgeStatus.appendChild(more);
      }
    } catch (error) { knowledgeStatus.textContent = `无法加载知识库状态：${error.message}`; }
  }

  function readPrefs() {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); }
    catch { return {}; }
  }

  function applyVoicePreference() {
    const enabled = voiceEnabled.checked;
    micButton.hidden = !enabled;
    micButton.disabled = !enabled;
    if (!enabled) {
      if (Voice.isCapturing?.()) Voice.stop?.(false);
      Voice.stopSpeaking?.();
      Voice.stopWakeWordDetection?.();
      setMicButtonLabel('语音');
    }
  }

  function setMicButtonLabel(text) {
    micButton.querySelector('.button-label').textContent = text;
  }

  function saveVoicePreference() {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      ...VoicePreference.update(readPrefs(), voiceEnabled.checked),
      voiceTone: voiceTone.value,
    }));
  }

  function loadPrefs() {
    const prefs = readPrefs();
    desktopAccess.checked = !!prefs.desktopAccess;
    screenCapture.checked = !!prefs.screenCapture;
    inputControl.checked = !!prefs.inputControl;
    trustedFolders.value = (prefs.trustedFolders || []).join('\n');
    // 旧版曾默认开启；升级时必须重新由用户明确选择开启。
    voiceEnabled.checked = VoicePreference.isEnabled(prefs);
    voiceTone.value = ['male-warm', 'female-calm', 'male-low'].includes(prefs.voiceTone)
      ? prefs.voiceTone : 'male-warm';
    Voice.tone = voiceTone.value;
    applyVoicePreference();
    proactiveCare.checked = prefs.proactiveCare !== false;
    proactiveVision.checked = !!prefs.proactiveVision;
    dndMode.checked = !!prefs.dndMode;
  }

  function savePrefs() {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      desktopAccess: desktopAccess.checked,
      screenCapture: screenCapture.checked,
      inputControl: inputControl.checked,
      trustedFolders: trustedFolders.value.split('\n').map(value => value.trim()).filter(Boolean),
      voiceEnabled: voiceEnabled.checked,
      voiceTone: voiceTone.value,
      voicePreferenceVersion: 2,
      proactiveCare: proactiveCare.checked,
      proactiveVision: proactiveVision.checked,
      dndMode: dndMode.checked,
    }));
  }

  function selectProvider(next) {
    provider = next === 'openai' ? 'openai' : 'deepseek';
    providerButtons.forEach(button => button.classList.toggle('active', button.dataset.provider === provider));
    const defaults = settingsState?.defaults?.[provider] || {};
    baseUrlInput.value = defaults.baseUrl || (provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com/v1');
    modelInput.value = defaults.model || (provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini');
    apiKeyInput.value = '';
  }

  async function loadSettings() {
    try {
      const response = await fetch(getApiBase() + '/api/settings', { headers: apiHeaders() });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      settingsState = await response.json();
      selectProvider(settingsState.status?.provider || 'deepseek');
      const configured = !!settingsState.status?.configured;
      setStatus(configured ? '本地服务已连接' : '需要配置模型', configured ? 'online' : 'warning');
      if (!configured) openSettings(true);
    } catch (error) {
      setStatus('本地服务未连接', 'offline');
      addMessage(`无法读取模型设置：${error.message}`, 'error');
    }
  }

  async function saveSettings() {
    if (!apiKeyInput.value.trim()) {
      savePrefs();
      settingsHint.textContent = settingsState?.status?.configured
        ? '本机偏好已保存；模型配置未更改。'
        : '本机偏好已保存；使用模型前仍需配置 API Key。';
      return;
    }
    try {
      const response = await fetch(getApiBase() + '/api/settings', {
        method: 'POST',
        headers: apiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ provider, apiKey: apiKeyInput.value.trim(), baseUrl: baseUrlInput.value.trim(), model: modelInput.value.trim() }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      savePrefs();
      settingsState = { ...settingsState, status: result.status };
      settingsHint.textContent = '设置已保存。';
      setStatus('本地服务已连接', 'online');
      openSettings(false);
    } catch (error) { settingsHint.textContent = error.message; }
  }

  async function clearSettings() {
    await fetch(getApiBase() + '/api/settings', { method: 'DELETE', headers: apiHeaders() }).catch(() => {});
    apiKeyInput.value = '';
    settingsHint.textContent = '模型配置已清除。';
    setStatus('需要配置模型', 'warning');
  }

  function permissionError(tool, approvedLaunch = false) {
    const fileTools = new Set(['list_files', 'list_all_disks', 'disk_usage']);
    const controlTools = new Set([
      'mouse_click', 'mouse_double_click', 'mouse_drag', 'mouse_scroll', 'type_text', 'press_keys',
      'list_windows', 'control_window', 'move_window', 'get_window_rect', 'read_clipboard',
      'write_clipboard', 'set_system_volume', 'set_wallpaper', 'launch_app', 'launch_program',
    ]);
    if (fileTools.has(tool) && !desktopAccess.checked) return '请先在设置中允许读取文件和磁盘信息。';
    if (controlTools.has(tool) && !inputControl.checked && !(approvedLaunch && ['launch_app', 'launch_program'].includes(tool))) return '请先在设置中允许窗口、键鼠和剪贴板操作。';
    return '';
  }

  async function invokeDesktopTool(tool, data, approvedLaunch = false) {
    const invoke = getInvoke();
    if (!invoke) throw new Error('当前不在 Tauri 桌面环境中');
    const denied = permissionError(tool, approvedLaunch);
    if (denied) return { ok: false, error: 'POLICY_DENIED', message: denied };
    switch (tool) {
      case 'list_files': return { ok: true, items: await invoke('list_directory', { path: String(data.path || '') }), source: 'tauri' };
      case 'list_all_disks': return { ok: true, disks: await invoke('list_all_disks'), source: 'tauri' };
      case 'list_windows': return { ok: true, windows: await invoke('list_windows'), source: 'tauri' };
      case 'mouse_click': return { ok: true, result: await invoke('mouse_click', { x: data.x, y: data.y, button: data.button || 'left' }) };
      case 'mouse_double_click': return { ok: true, result: await invoke('mouse_double_click', { x: data.x, y: data.y, button: data.button || 'left' }) };
      case 'mouse_drag': return { ok: true, result: await invoke('mouse_drag', { fromX: data.from_x, fromY: data.from_y, toX: data.to_x, toY: data.to_y, button: data.button || 'left', steps: data.steps }) };
      case 'mouse_scroll': return { ok: true, result: await invoke('mouse_scroll', { axis: data.axis || 'vertical', amount: Number(data.amount || 0) }) };
      case 'type_text': return { ok: true, result: await invoke('type_text', { text: String(data.text || '') }) };
      case 'press_keys': return { ok: true, result: await invoke('press_keys', { key: String(data.key || '') }) };
      case 'control_window': return { ok: true, result: await invoke('control_window', { title: data.title, hwnd: data.hwnd, action: data.action }) };
      case 'move_window': return { ok: true, result: await invoke('move_window', { title: data.title, hwnd: data.hwnd, x: data.x, y: data.y, width: data.width, height: data.height }) };
      case 'get_window_rect': return { ok: true, rect: await invoke('get_window_rect', { title: data.title, hwnd: data.hwnd }) };
      case 'get_network_stats': return { ok: true, stats: await invoke('get_network_stats') };
      case 'get_temperature_stats': return { ok: true, stats: await invoke('get_temperature_stats') };
      case 'get_gpu_stats': return { ok: true, stats: await invoke('get_gpu_stats') };
      case 'read_clipboard': return { ok: true, text: await invoke('read_clipboard') };
      case 'write_clipboard': return { ok: true, result: await invoke('write_clipboard', { text: String(data.text || '') }) };
      case 'set_system_volume': return { ok: true, result: await invoke('set_system_volume', { action: data.action || 'set', level: data.level }) };
      case 'set_wallpaper': return { ok: true, result: await invoke('set_wallpaper', { path: data.path }) };
      case 'launch_app':
      case 'launch_program': {
        const result = await invoke('launch_program', { program: String(data.program || data.app_name || ''), args: Array.isArray(data.args) ? data.args.map(String) : [] });
        return result?.ok === false
          ? { ok: false, error: 'LAUNCH_FAILED', message: result.message || '桌面端未能启动程序。', result }
          : { ok: true, result };
      }
      default: return { ok: false, error: 'UNSUPPORTED_TOOL', message: `桌面端暂不支持：${tool}` };
    }
  }

  async function postDesktopResult(toolId, result) {
    const response = await fetch(getApiBase() + '/api/agent/desktop-result', {
      method: 'POST', headers: apiHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ toolId, result }),
    });
    if (!response.ok) throw new Error(`回传桌面工具结果失败：HTTP ${response.status}`);
  }

  function requestDesktopApproval(event) {
    if (!getInvoke()) {
      postDesktopResult(event.toolId, { ok: false, error: 'DESKTOP_REQUIRED', message: '请在 Tauri 桌面助手中启动软件。' }).catch(error => showToast(error.message));
      addActivity('启动软件需要桌面应用，请在桌面助手中重试。', 'warning');
      return;
    }
    if (pendingDesktopApprovals.has(event.toolId)) return;
    const data = event.toolInput || {};
    const program = String(data.program || data.app_name || '').trim();
    const card = document.createElement('article');
    card.className = 'approval-card';
    const heading = document.createElement('div');
    heading.className = 'approval-heading';
    const title = document.createElement('strong');
    title.textContent = '启动软件';
    const risk = document.createElement('span');
    risk.className = 'risk-badge l2';
    risk.textContent = '桌面确认';
    heading.append(title, risk);
    const target = document.createElement('p');
    const args = Array.isArray(data.args) ? data.args.map(String) : [];
    target.textContent = [program, ...args].join(' ') || '未提供程序路径';
    const controls = document.createElement('div');
    controls.className = 'approval-actions';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'primary';
    confirm.textContent = '确认启动';
    const reject = document.createElement('button');
    reject.type = 'button';
    reject.textContent = '拒绝';
    controls.append(confirm, reject);
    card.append(heading, target, controls);
    desktopApprovalList.appendChild(card);
    let finishing = false;
    const finish = async approved => {
      if (finishing) return;
      finishing = true;
      confirm.disabled = true;
      reject.disabled = true;
      clearTimeout(pendingDesktopApprovals.get(event.toolId)?.timer);
      pendingDesktopApprovals.delete(event.toolId);
      updateApprovalCount();
      let result = { ok: false, error: 'ACTION_REJECTED', message: '用户拒绝启动软件。' };
      if (approved) {
        try { result = await invokeDesktopTool(event.tool, data, true); }
        catch (error) { result = { ok: false, error: 'TAURI_ERROR', message: error.message }; }
      }
      try { await postDesktopResult(event.toolId, result); }
      catch (error) { showToast(`桌面操作结果回传失败：${error.message}`); }
      addActivity(approved ? (result.ok ? `已发起启动：${program}` : `启动失败：${result.message || result.error}`) : `已拒绝启动：${program}`, result.ok ? 'success' : 'warning');
      card.remove();
      updateApprovalCount();
    };
    confirm.addEventListener('click', () => finish(true), { once: true });
    reject.addEventListener('click', () => finish(false), { once: true });
    const timer = setTimeout(() => finish(false), 110000);
    pendingDesktopApprovals.set(event.toolId, { timer, finish, card });
    updateApprovalCount();
    setStatus('等待桌面确认', 'warning');
    showToast(`启动 ${program} 需要确认，请打开任务中心。`);
  }

  async function loadTaskSnapshot() {
    try {
      const response = await fetch(`${getApiBase()}/api/agent/tasks/${encodeURIComponent(SESSION_ID)}`, { headers: apiHeaders() });
      if (!response.ok) return null;
      const data = await response.json();
      if (data.task?.plan) renderPlan(data.task.plan);
      return data.task?.plan || null;
    } catch { /* Service may still be starting. */ }
    return null;
  }

  function actionTitle(action) {
    const labels = { launch_program: '启动程序', write_file: '写入文件', create_docx: '创建 Word 文档', edit_docx: '覆盖 Word 文档', delete_file: '删除文件', move_file: '移动文件', mouse_click: '点击桌面', type_text: '输入文本', set_wallpaper: '更换壁纸' };
    return labels[action.name] || action.name || '桌面操作';
  }

  async function resolveAction(action, decision, buttons) {
    buttons.forEach(button => { button.disabled = true; });
    try {
      const response = await fetch(`${getApiBase()}/api/actions/${encodeURIComponent(action.id)}/${decision}`, { method: 'POST', headers: apiHeaders() });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
      addActivity(decision === 'confirm' ? `已确认：${actionTitle(action)}` : `已拒绝：${actionTitle(action)}`, decision === 'confirm' ? 'success' : 'warning');
      if (result.resumed?.answer) addMessage(result.resumed.answer, 'assistant');
      await Promise.all([loadTaskSnapshot(), loadPendingActions()]);
    } catch (error) {
      buttons.forEach(button => { button.disabled = false; });
      showToast(`操作失败：${error.message}`);
    }
  }

  async function loadPendingActions() {
    try {
      const response = await fetch(getApiBase() + '/api/actions', { headers: apiHeaders() });
      if (!response.ok) return;
      const data = await response.json();
      const actions = (data.actions || []).filter(action => action.status === 'pending');
      serverApprovalCount = actions.length;
      approvalList.innerHTML = '';
      if (!actions.length) {
        const empty = document.createElement('p');
        empty.className = 'empty-panel-state';
        empty.textContent = '高风险操作会在这里请求确认。';
        approvalList.appendChild(empty);
        updateApprovalCount();
        return;
      }
      for (const action of actions) {
        const card = document.createElement('article');
        card.className = 'approval-card';
        card.dataset.actionId = action.id;
        const heading = document.createElement('div');
        heading.className = 'approval-heading';
        const title = document.createElement('strong');
        title.textContent = actionTitle(action);
        const risk = document.createElement('span');
        risk.className = `risk-badge ${String(action.risk || 'L2').toLowerCase()}`;
        risk.textContent = action.risk || 'L2';
        heading.append(title, risk);
        const target = document.createElement('p');
        target.textContent = action.target || '请检查操作参数后决定是否继续。';
        if (action.warning) {
          target.textContent += `\n${action.warning}`;
          target.style.whiteSpace = 'pre-line';
        }
        const controls = document.createElement('div');
        controls.className = 'approval-actions';
        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.className = 'primary';
        confirm.textContent = '确认执行';
        const reject = document.createElement('button');
        reject.type = 'button';
        reject.textContent = '拒绝';
        const buttons = [confirm, reject];
        confirm.addEventListener('click', () => resolveAction(action, 'confirm', buttons));
        reject.addEventListener('click', () => resolveAction(action, 'reject', buttons));
        controls.append(confirm, reject);
        card.append(heading, target, controls);
        approvalList.appendChild(card);
      }
      updateApprovalCount();
    } catch { /* No pending actions while offline. */ }
  }

  async function sendMessage() {
    const question = input.value.trim();
    if (!question || busy) return;
    if (settingsState && !settingsState.status?.configured) { openSettings(true); return; }
    input.value = '';
    input.style.height = '';
    updateInputCount();
    addMessage(question, 'user');
    latestPlan = null;
    setBusy(true);
    setStatus('正在处理…', 'working');
    modeIndicator.textContent = '智能执行';
    controller = new AbortController();
    activeRequestId = crypto.randomUUID();
    stopRequested = false;
    let answerNode = null;
    let answer = '';
    let receivedError = false;
    try {
      let screenshot = null;
      if (screenCapture.checked && /屏幕|截图|画面|窗口|screen|capture|看见|看到/i.test(question)) {
        screenshot = await getInvoke()?.('capture_screen').catch(() => null);
      }
      controller.signal.throwIfAborted();
      await executeAgent(question, SESSION_ID, {
        onThought: text => addFlow(text),
        onAction: text => { addFlow(text, 'action'); addActivity(text, 'working'); },
        onObservation: text => addActivity(text || '工具执行完成', 'success'),
        onPlan: plan => { if (!stopRequested) renderPlan(plan); },
        onStepUpdate: (_id, text, event) => { if (event.plan) renderPlan(event.plan); addFlow(text, 'action'); },
        onConfirmationRequired: event => {
          if (event.plan) renderPlan(event.plan);
          setStatus('等待操作确认', 'warning');
          addActivity(event.content || '有操作等待你的确认', 'warning');
          showToast('有操作等待确认，请打开任务中心。');
          loadPendingActions();
        },
        onDesktopRequest: async event => {
          if (stopRequested) {
            await postDesktopResult(event.toolId, { ok: false, error: 'ACTION_REJECTED', message: '任务已取消。' }).catch(() => {});
            return;
          }
          addActivity(`桌面工具：${event.tool || '执行操作'}`, 'working');
          if (['launch_app', 'launch_program'].includes(event.tool)) {
            requestDesktopApproval(event);
            return;
          }
          try { await postDesktopResult(event.toolId, await invokeDesktopTool(event.tool, event.toolInput || {})); }
          catch (error) { await postDesktopResult(event.toolId, { ok: false, error: 'TAURI_ERROR', message: error.message }); }
        },
        onAnswer: text => {
          if (stopRequested) return;
          if (!answerNode) answerNode = addMessage('', 'assistant');
          answer += text;
          answerNode.textContent = stripMarkdown(answer);
          messages.scrollTop = messages.scrollHeight;
        },
        onError: text => { if (!stopRequested) { receivedError = true; addMessage(text, 'error'); addActivity(text, 'error'); } },
        onDone: finalAnswer => { if (!stopRequested && !receivedError && !answerNode && finalAnswer) { answer = finalAnswer; answerNode = addMessage(finalAnswer, 'assistant'); } },
      }, controller.signal, { ...(screenshot ? { screenshot } : {}), requestId: activeRequestId });
      if (stopRequested) throw new DOMException('任务已取消', 'AbortError');
      if (answer.trim() && voiceEnabled.checked) Voice.speak?.(stripMarkdown(answer), { rate: 1, volume: 0.9 });
      const [plan] = await Promise.all([loadTaskSnapshot(), loadPendingActions()]);
      if (pendingDesktopApprovals.size || serverApprovalCount) setStatus('等待操作确认', 'warning');
      else if (plan?.status === 'cancelled') setStatus('已取消', 'warning');
      else if (plan?.status === 'failed') setStatus('执行失败', 'offline');
      else setStatus(answer.trim() ? '已完成' : '任务已暂停', answer.trim() ? 'online' : 'warning');
    } catch (error) {
      if (error.name !== 'AbortError') addMessage(`请求失败：${error.message}`, 'error');
      if (error.name === 'AbortError') {
        addMessage('任务已取消。已完成的操作不会自动回滚。', 'assistant');
        if (latestPlan) renderPlan({
          ...latestPlan,
          status: 'cancelled',
          steps: (latestPlan.steps || []).map(step =>
            ['pending', 'executing', 'awaiting_confirm'].includes(step.status)
              ? { ...step, status: 'skipped', error: '用户已取消任务' }
              : step),
        });
      }
      setStatus(error.name === 'AbortError' ? '已取消' : '执行失败', error.name === 'AbortError' ? 'warning' : 'offline');
      if (!latestPlan) modeIndicator.textContent = '智能执行';
      addActivity(error.name === 'AbortError' ? '任务已由你停止' : `执行失败：${error.message}`, 'error');
    } finally {
      controller = null;
      activeRequestId = null;
      stopRequested = false;
      setBusy(false);
      input.focus();
      setTimeout(() => { flowItems.innerHTML = ''; flow.classList.add('hidden'); }, 5000);
    }
  }

  async function stopCurrentTask() {
    if (!busy || !activeRequestId || stopRequested) return;
    const requestId = activeRequestId;
    const clientController = controller;
    stopRequested = true;
    setStatus('正在停止…', 'warning');
    sendButton.disabled = true;
    try {
      const response = await fetch(getApiBase() + '/api/agent/cancel', {
        method: 'POST',
        headers: apiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ sessionId: SESSION_ID, requestId }),
        signal: AbortSignal.timeout(7000),
      });
      if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
      if (response.ok) {
        for (const item of pendingDesktopApprovals.values()) {
          clearTimeout(item.timer);
          item.card.remove();
        }
        pendingDesktopApprovals.clear();
        updateApprovalCount();
      } else {
        await Promise.allSettled([...pendingDesktopApprovals.values()].map(item => item.finish(false)));
      }
    } catch (error) {
      showToast(`后台取消未确认：${error.message}。请检查任务中心。`);
    } finally {
      clientController?.abort();
      sendButton.disabled = false;
    }
  }

  function toggleMic() {
    if (!voiceEnabled.checked) return;
    if (!Voice.isSupported?.()) { showToast('当前环境不支持语音识别。'); return; }
    if (Voice.isCapturing?.()) {
      Voice.stop?.();
      return;
    }
    if (busy) { showToast('请等待当前任务完成后再说话。'); return; }
    transcript?.begin(input.value.trim());
    if (Voice.start?.()) setMicButtonLabel('结束并发送');
  }

  function showToast(text) {
    const node = document.createElement('div');
    node.className = 'toast';
    node.textContent = text;
    toastRegion.appendChild(node);
    setTimeout(() => node.remove(), 5000);
  }

  function updateInputCount() { inputCount.textContent = `${input.value.length} / 4000`; }

  async function registerDesktopEvents() {
    const listen = getListen?.();
    if (!listen) return;
    await listen('global-mic-toggle', toggleMic);
    await listen('global-open-settings', () => openSettings(true));
    await listen('desktop-file-changed', event => {
      const change = event.payload || {};
      if (change.path) fetch(getApiBase() + '/api/desktop-file-changed', {
        method: 'POST', headers: apiHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ kind: change.kind, path: change.path }),
      }).catch(() => {});
      showToast(`桌面文件${change.kind === 'removed' ? '删除' : change.kind === 'created' ? '新增' : '变更'}：${change.file_name || change.path || ''}`);
    });
  }

  form.addEventListener('submit', event => { event.preventDefault(); if (busy) stopCurrentTask(); else sendMessage(); });
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); } });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 130)}px`;
    updateInputCount();
  });
  document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => {
    input.value = button.dataset.prompt || '';
    updateInputCount();
    sendMessage();
  }));
  taskPanelButton.addEventListener('click', () => {
    const visible = isNarrow() ? taskPanel.classList.contains('open') : !workspace.classList.contains('task-panel-hidden');
    openTaskPanel(!visible);
  });
  taskPanelClose.addEventListener('click', () => openTaskPanel(false));
  compactTaskOpen.addEventListener('click', () => openTaskPanel(true));
  settingsButton.addEventListener('click', () => openSettings(true));
  settingsClose.addEventListener('click', () => openSettings(false));
  drawerBackdrop.addEventListener('click', () => openSettings(false));
  providerButtons.forEach(button => button.addEventListener('click', () => selectProvider(button.dataset.provider)));
  settingsSave.addEventListener('click', saveSettings);
  settingsClear.addEventListener('click', clearSettings);
  memoryRefresh?.addEventListener('click', loadMemories);
  knowledgeRefresh?.addEventListener('click', loadKnowledgeStatus);
  voiceEnabled.addEventListener('change', () => { applyVoicePreference(); saveVoicePreference(); });
  voiceTone.addEventListener('change', () => { Voice.tone = voiceTone.value; saveVoicePreference(); });
  Voice.onTtsFallback = () => showToast('自然语音暂不可用，已切换为系统朗读。');
  micButton.addEventListener('click', toggleMic);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (drawer.classList.contains('open')) openSettings(false);
    else if (isNarrow() && taskPanel.classList.contains('open')) openTaskPanel(false);
  });
  window.addEventListener('resize', () => {
    if (!isNarrow()) taskPanel.classList.remove('open');
    taskPanelButton.setAttribute('aria-expanded', String(isNarrow() ? taskPanel.classList.contains('open') : !workspace.classList.contains('task-panel-hidden')));
  });

  Voice.onResult = text => {
    input.value = transcript?.final(text) || text;
    updateInputCount();
  };
  Voice.onInterimResult = text => {
    input.value = transcript?.provisional(text) || text;
    updateInputCount();
  };
  Voice.onSegmentEnd = () => {
    input.value = transcript?.segmentEnd() || input.value;
    updateInputCount();
  };
  Voice.onSpeechEnd = stoppedByUser => {
    setMicButtonLabel('语音');
    input.value = transcript?.finish() || input.value;
    updateInputCount();
    if (stoppedByUser && voiceEnabled.checked && input.value.trim() && !busy) sendMessage();
  };
  Voice.onError = code => {
    if (code === 'no-speech' || code === 'aborted') return;
    const hint = code === 'mic-blocked' ? '麦克风未授权，请检查 Windows 麦克风权限。'
      : code === 'audio-capture' ? '未检测到可用麦克风，请检查设备连接。'
        : code === 'network' ? Voice._networkErrorCount >= 3
          ? '语音识别网络连续失败；已识别文字保留在输入框，可手动发送。'
          : '语音识别网络中断，正在自动重连。'
          : code === 'start-failed' ? '语音识别启动失败，请稍后重试。'
            : `语音识别暂时不可用：${code}`;
    showToast(hint);
  };
  Voice.onStateChange = state => {
    setMicButtonLabel(Voice.isCapturing?.() ? state === 'idle' ? '重连中…' : '结束并发送' : '语音');
  };

  async function init() {
    await initApi();
    loadPrefs();
    updateInputCount();
    if (isNarrow()) openTaskPanel(false);
    const server = await waitForServer(30, 500);
    if (!server) {
      setStatus('本地服务未启动', 'offline');
      addMessage('本地服务暂时不可用，请稍后重试。', 'error');
      return;
    }
    await Promise.all([loadSettings(), loadTaskSnapshot(), loadPendingActions()]);
    await registerDesktopEvents();
    setInterval(() => {
      if (!document.hidden && !busy) Promise.all([loadTaskSnapshot(), loadPendingActions()]);
    }, 10000);
    input.focus();
  }

  init();
})();
