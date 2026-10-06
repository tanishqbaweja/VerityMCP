/**
 * VerityMCP - Activity Monitor UI
 * Standalone & Host-Native MCP App, live-updating progress and operational intent monitor.
 */

export function getMonitorHtml(options?: {
  runId?: string;
  projectKey?: string;
  taskKey?: string;
}): string {
  const initialRunId = options?.runId ? JSON.stringify(options.runId) : '""';
  const initialProjectKey = options?.projectKey ? JSON.stringify(options.projectKey) : '""';
  const initialTaskKey = options?.taskKey ? JSON.stringify(options.taskKey) : '""';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VerityMCP Activity Monitor</title>
  <style>
    :root {
      --bg: #0f141c;
      --card-bg: #18202d;
      --card-border: #273447;
      --card-hover: #202b3d;
      --text-main: #e2e8f0;
      --text-muted: #8899ac;
      --primary: #38bdf8;
      --primary-dim: rgba(56, 189, 248, 0.12);
      --success: #34d399;
      --success-dim: rgba(52, 211, 153, 0.15);
      --warning: #fbbf24;
      --warning-dim: rgba(251, 191, 36, 0.15);
      --danger: #f87171;
      --danger-dim: rgba(248, 113, 113, 0.15);
      --info: #94a3b8;
      --accent: #818cf8;
      --mono-font: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
      --sans-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background-color: var(--bg);
      color: var(--text-main);
      font-family: var(--sans-font);
      font-size: 13px;
      line-height: 1.45;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
      user-select: text;
    }

    /* Header Bar */
    header {
      background: #141b26;
      border-bottom: 1px solid var(--card-border);
      padding: 10px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-shrink: 0;
    }

    .brand-group {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .brand-title {
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.05em;
      color: #f1f5f9;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .pulse-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 8px var(--success);
      display: inline-block;
    }
    .pulse-dot.working {
      background: var(--primary);
      box-shadow: 0 0 10px var(--primary);
      animation: pulseAnim 1.4s infinite ease-in-out;
    }
    .pulse-dot.idle {
      background: #64748b;
      box-shadow: none;
    }

    @keyframes pulseAnim {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(1.2); }
    }

    .status-badge {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      padding: 2px 7px;
      border-radius: 4px;
      letter-spacing: 0.04em;
    }
    .status-badge.working { background: var(--primary-dim); color: var(--primary); }
    .status-badge.idle { background: rgba(148, 163, 184, 0.15); color: #94a3b8; }
    .status-badge.needs_cleanup { background: var(--warning-dim); color: var(--warning); }

    .meta-group {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 12px;
      color: var(--text-muted);
    }

    .meta-item {
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .meta-item strong {
      color: #e2e8f0;
      font-weight: 500;
    }

    .pills {
      display: flex;
      gap: 6px;
    }
    .pill {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 10px;
      background: #1e293b;
      color: #cbd5e1;
      font-family: var(--mono-font);
      border: 1px solid #334155;
    }
    .pill.transport { color: var(--primary); border-color: rgba(56, 189, 248, 0.35); font-weight: 600; }
    .pill.warn { color: var(--warning); border-color: rgba(251, 191, 36, 0.3); }
    .pill.fail { color: var(--danger); border-color: rgba(248, 113, 113, 0.3); }

    .header-actions {
      display: flex;
      gap: 6px;
    }
    .btn-pip {
      background: #1e293b;
      border: 1px solid #334155;
      color: #94a3b8;
      border-radius: 4px;
      padding: 3px 8px;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn-pip:hover {
      background: #334155;
      color: #fff;
    }

    /* Current Action Panel */
    .current-action-panel {
      background: linear-gradient(180deg, #182232 0%, #131b27 100%);
      border-bottom: 2px solid var(--card-border);
      padding: 14px 16px;
      flex-shrink: 0;
    }
    .current-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .current-label {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--primary);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .current-elapsed {
      font-family: var(--mono-font);
      font-size: 11px;
      color: var(--text-muted);
    }
    .current-title {
      font-size: 15px;
      font-weight: 600;
      color: #f8fafc;
      margin-bottom: 8px;
    }

    .why-box {
      background: rgba(56, 189, 248, 0.08);
      border-left: 3px solid var(--primary);
      padding: 7px 10px;
      border-radius: 0 4px 4px 0;
      margin-bottom: 8px;
      font-size: 12.5px;
      line-height: 1.4;
    }
    .why-box strong {
      color: var(--primary);
      font-weight: 600;
      margin-right: 4px;
      text-transform: uppercase;
      font-size: 10.5px;
      letter-spacing: 0.04em;
    }

    .current-details {
      display: flex;
      gap: 16px;
      font-size: 11.5px;
      color: var(--text-muted);
    }
    .current-details span strong {
      color: #cbd5e1;
      font-weight: 500;
    }

    /* Filter & Toolbar */
    .toolbar {
      background: #111722;
      border-bottom: 1px solid var(--card-border);
      padding: 8px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }
    .filter-tabs {
      display: flex;
      gap: 4px;
    }
    .filter-btn {
      background: transparent;
      border: 1px solid transparent;
      color: #94a3b8;
      border-radius: 4px;
      padding: 3px 8px;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .filter-btn:hover {
      background: #1e293b;
      color: #e2e8f0;
    }
    .filter-btn.active {
      background: #1e293b;
      border-color: #38bdf8;
      color: #38bdf8;
      font-weight: 600;
    }

    .search-input {
      background: #182232;
      border: 1px solid #273447;
      color: #e2e8f0;
      border-radius: 4px;
      padding: 3px 8px;
      font-size: 11px;
      outline: none;
      width: 140px;
    }
    .search-input:focus {
      border-color: var(--primary);
    }

    /* Event Feed */
    .events-container {
      flex: 1;
      overflow-y: auto;
      padding: 12px 16px;
      position: relative;
    }

    .new-events-toast {
      position: absolute;
      top: 12px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--primary);
      color: #0f172a;
      font-size: 11px;
      font-weight: 600;
      padding: 4px 12px;
      border-radius: 12px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      cursor: pointer;
      display: none;
      z-index: 10;
    }

    .event-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      margin-bottom: 6px;
      padding: 7px 10px;
      transition: background 0.15s, border-color 0.15s;
      cursor: pointer;
    }
    .event-card:hover {
      background: var(--card-hover);
      border-color: #3b4c63;
    }

    .event-header {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .event-icon {
      font-size: 13px;
      font-weight: bold;
      width: 16px;
      text-align: center;
      flex-shrink: 0;
    }
    .icon-started { color: #38bdf8; }
    .icon-verified { color: #34d399; }
    .icon-completed { color: #34d399; }
    .icon-warning { color: #fbbf24; }
    .icon-blocked { color: #38bdf8; }
    .icon-failure { color: #f87171; }
    .icon-info { color: #94a3b8; }

    .event-time {
      font-family: var(--mono-font);
      font-size: 11px;
      color: #64748b;
      flex-shrink: 0;
    }

    .event-title {
      font-size: 12.5px;
      font-weight: 500;
      color: #f1f5f9;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .event-duration {
      font-family: var(--mono-font);
      font-size: 11px;
      color: #64748b;
      margin-left: 6px;
      flex-shrink: 0;
    }

    .event-badge {
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 3px;
      font-weight: 600;
      text-transform: uppercase;
      flex-shrink: 0;
    }
    .badge-blocked {
      background: rgba(56, 189, 248, 0.15);
      color: #38bdf8;
      border: 1px solid rgba(56, 189, 248, 0.3);
    }
    .badge-verified {
      background: rgba(52, 211, 153, 0.12);
      color: #34d399;
    }

    .event-body {
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      display: none;
      font-size: 12px;
      color: #cbd5e1;
    }
    .event-card.expanded .event-body {
      display: block;
    }

    .event-prop {
      margin-bottom: 4px;
      line-height: 1.4;
    }
    .event-prop strong {
      color: #94a3b8;
      font-weight: 600;
      margin-right: 4px;
      font-size: 11px;
      text-transform: uppercase;
    }
    .evidence-block {
      background: #111722;
      border: 1px solid #1e293b;
      border-radius: 4px;
      padding: 6px 8px;
      font-family: var(--mono-font);
      font-size: 11px;
      color: #38bdf8;
      margin-top: 4px;
      overflow-x: auto;
    }

    /* Empty state */
    .empty-state {
      text-align: center;
      padding: 40px 20px;
      color: #64748b;
      font-size: 13px;
    }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #273447; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #3b4c63; }
  </style>
</head>
<body>

  <!-- Header -->
  <header>
    <div class="brand-group">
      <div class="brand-title">
        <span class="pulse-dot working" id="statusDot"></span>
        VERITYMCP
      </div>
      <span class="status-badge working" id="statusBadge">Working</span>
    </div>

    <div class="meta-group">
      <div class="meta-item">
        <span>Project:</span>
        <strong id="projectKey">${options?.projectKey || "—"}</strong>
      </div>
      <div class="meta-item">
        <span>Task:</span>
        <strong id="taskKey">${options?.taskKey || "active"}</strong>
      </div>
      <div class="meta-item">
        <span>Run:</span>
        <strong id="runId">${options?.runId || "—"}</strong>
      </div>
      <div class="meta-item">
        <span>Elapsed:</span>
        <strong id="sessionElapsed">00:00</strong>
      </div>
      <div class="pills">
        <span class="pill transport" id="transportBadge">Local SSE</span>
        <span class="pill" id="eventsCount">0 events</span>
        <span class="pill warn" id="warnCount">0 warn</span>
        <span class="pill fail" id="failCount">0 fail</span>
      </div>
    </div>

    <div class="header-actions">
      <button class="btn-pip" id="btnPip" title="Open in persistent popup window">Pop-out</button>
    </div>
  </header>

  <!-- Current Action Panel -->
  <div class="current-action-panel" id="currentPanel">
    <div class="current-header">
      <div class="current-label">
        <span style="display:inline-block; animation: spin 1.5s linear infinite;">●</span>
        CURRENT ACTION
      </div>
      <div class="current-elapsed" id="currentElapsed">0.0s</div>
    </div>
    <div class="current-title" id="currentTitle">Waiting for activity...</div>
    <div class="why-box" id="currentWhyBox" style="display: none;">
      <strong>WHY:</strong> <span id="currentWhyText"></span>
    </div>
    <div class="current-details" id="currentDetails">
      <span><strong>Target:</strong> <span id="currentTarget">—</span></span>
      <span><strong>Status:</strong> <span id="currentStatus">Idle</span></span>
    </div>
  </div>

  <!-- Toolbar & Filters -->
  <div class="toolbar">
    <div class="filter-tabs">
      <button class="filter-btn active" data-filter="all">All</button>
      <button class="filter-btn" data-filter="browser">Browser</button>
      <button class="filter-btn" data-filter="files">Files</button>
      <button class="filter-btn" data-filter="shell">Shell</button>
      <button class="filter-btn" data-filter="git">Git</button>
      <button class="filter-btn" data-filter="desktop">Desktop</button>
      <button class="filter-btn" data-filter="warnings">Warnings</button>
    </div>
    <div style="display:flex; gap:6px; align-items:center;">
      <input type="text" class="search-input" id="searchInput" placeholder="Filter events...">
      <button class="filter-btn" id="btnAutoScroll" title="Toggle auto follow">Auto-scroll: ON</button>
    </div>
  </div>

  <!-- Events Container -->
  <div class="events-container" id="eventsContainer">
    <div class="new-events-toast" id="newEventsToast">↓ New events below</div>
    <div id="eventsList">
      <div class="empty-state">No activity events recorded yet. Ready for operations.</div>
    </div>
  </div>

  <script>
    (function() {
      let events = [];
      let lastCursor = 0;
      let activeFilter = 'all';
      let searchQuery = '';
      let autoScroll = true;
      let startTime = Date.now();
      let currentActionStartTime = 0;
      let lastActivityTime = Date.now();

      window.__VERITY_RUN_ID__ = ${initialRunId};
      const boundRunId = window.__VERITY_RUN_ID__ || (function() {
        try {
          const params = new URLSearchParams(window.location.search);
          return params.get('run_id') || '';
        } catch {
          return '';
        }
      })();
      let currentRunId = boundRunId;
      let currentProjectKey = ${initialProjectKey};
      let currentTaskKey = ${initialTaskKey};

      const eventsContainer = document.getElementById('eventsContainer');
      const eventsList = document.getElementById('eventsList');
      const newEventsToast = document.getElementById('newEventsToast');
      const statusDot = document.getElementById('statusDot');
      const statusBadge = document.getElementById('statusBadge');
      const sessionElapsed = document.getElementById('sessionElapsed');
      const transportBadge = document.getElementById('transportBadge');
      const eventsCount = document.getElementById('eventsCount');
      const warnCount = document.getElementById('warnCount');
      const failCount = document.getElementById('failCount');
      const projectKey = document.getElementById('projectKey');
      const taskKey = document.getElementById('taskKey');
      const runId = document.getElementById('runId');
      const currentTitle = document.getElementById('currentTitle');
      const currentWhyBox = document.getElementById('currentWhyBox');
      const currentWhyText = document.getElementById('currentWhyText');
      const currentTarget = document.getElementById('currentTarget');
      const currentStatus = document.getElementById('currentStatus');
      const currentElapsed = document.getElementById('currentElapsed');
      const btnAutoScroll = document.getElementById('btnAutoScroll');
      const btnPip = document.getElementById('btnPip');

      // Robust Event Delegation for Event Cards - ZERO inline onclick handlers
      eventsList.addEventListener('click', (event) => {
        const card = event.target.closest('.event-card');
        if (card) {
          card.classList.toggle('expanded');
        }
      });

      // Detect Host Environment: Embedded iframe (ChatGPT / MCP App) vs Standalone localhost
      const isEmbedded = (function() {
        try {
          return window.parent && window.parent !== window;
        } catch (e) {
          return true; // Cross-origin access restriction proves iframe containment
        }
      })();

      if (transportBadge) {
        transportBadge.textContent = isEmbedded ? 'MCP Host Bridge' : 'Local SSE';
      }

      if (isEmbedded && statusBadge) {
        statusBadge.textContent = 'Connected';
      }

      // MCP Host Bridge via JSON-RPC 2.0 postMessage
      let rpcSeq = 1;
      const pendingRpcCalls = new Map();

      function callMcpToolViaBridge(toolName, toolArgs) {
        return new Promise((resolve, reject) => {
          const id = 'rpc_' + (rpcSeq++);
          const timer = setTimeout(() => {
            if (pendingRpcCalls.has(id)) {
              pendingRpcCalls.delete(id);
              reject(new Error('RPC call timeout: ' + toolName));
            }
          }, 4500);

          pendingRpcCalls.set(id, { resolve, reject, timer });

          window.parent.postMessage({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: {
              name: toolName,
              arguments: toolArgs
            }
          }, '*');
        });
      }

      window.addEventListener('message', (event) => {
        try {
          if (isEmbedded && window.parent && event.source && event.source !== window.parent) {
            return;
          }
        } catch {}

        const data = event.data;
        if (!data || typeof data !== 'object') return;
        if (data.id && pendingRpcCalls.has(data.id)) {
          const entry = pendingRpcCalls.get(data.id);
          pendingRpcCalls.delete(data.id);
          clearTimeout(entry.timer);
          if (data.error) {
            entry.reject(new Error(typeof data.error === 'object' ? data.error.message || JSON.stringify(data.error) : String(data.error)));
          } else {
            entry.resolve(data.result);
          }
        }

        // Host bridge notification and direct message support
        const payload = data.result || data;
        const resData = parseStructuredMcpData(payload);
        if (resData && (resData.events || resData.current_action !== undefined || resData.project_key)) {
          // If this monitor is bound to a specific run, strictly ignore messages from other runs!
          if (boundRunId && resData.run_id && resData.run_id !== boundRunId) {
            return;
          }
          const runMeta = {
            project_key: resData.project_key,
            task_key: resData.task_key,
            run_id: boundRunId || resData.run_id,
          };
          if (resData.events) {
            handleNewEventsBatch(resData.events, resData.next_cursor, resData.current_action, runMeta);
          } else if (resData.current_action !== undefined) {
            updateCurrentAction(resData.current_action);
          }
          if (statusBadge && (statusBadge.textContent.startsWith('Bridge Err') || statusBadge.textContent === 'Waiting' || statusBadge.textContent === 'Unbound')) {
            statusBadge.className = 'status-badge working';
            statusBadge.textContent = 'Connected';
          }
        }
      });

      function parseStructuredMcpData(res) {
        if (!res) return null;
        if (res.data) return res.data;
        if (Array.isArray(res.content)) {
          for (const item of res.content) {
            if (item.type === 'text' && item.text) {
              const marker = '--- STRUCTURED_PAYLOAD_JSON ---';
              const idx = item.text.indexOf(marker);
              if (idx !== -1) {
                try {
                  const jsonStr = item.text.slice(idx + marker.length).trim();
                  const parsed = JSON.parse(jsonStr);
                  if (parsed.data) return parsed.data;
                  return parsed;
                } catch {}
              }
            }
          }
        }
        return res;
      }

      // Pop-out window (Mode-aware)
      if (btnPip) {
        if (isEmbedded) {
          btnPip.style.display = 'none';
        } else {
          btnPip.addEventListener('click', () => {
            window.open('/monitor', 'VerityMonitor', 'width=580,height=760,menubar=no,toolbar=no,location=no');
          });
        }
      }

      // Auto-scroll toggle
      btnAutoScroll.addEventListener('click', () => {
        autoScroll = !autoScroll;
        btnAutoScroll.textContent = 'Auto-scroll: ' + (autoScroll ? 'ON' : 'OFF');
        if (autoScroll) {
          scrollToBottom();
          newEventsToast.style.display = 'none';
        }
      });

      // User scrolling detection
      eventsContainer.addEventListener('scroll', () => {
        const threshold = 40;
        const isAtBottom = (eventsContainer.scrollHeight - eventsContainer.scrollTop - eventsContainer.clientHeight) <= threshold;
        if (!isAtBottom && autoScroll) {
          autoScroll = false;
          btnAutoScroll.textContent = 'Auto-scroll: OFF';
        }
      });

      newEventsToast.addEventListener('click', () => {
        autoScroll = true;
        btnAutoScroll.textContent = 'Auto-scroll: ON';
        scrollToBottom();
        newEventsToast.style.display = 'none';
      });

      function scrollToBottom() {
        eventsContainer.scrollTop = eventsContainer.scrollHeight;
      }

      // Filter tabs
      document.querySelectorAll('.filter-btn[data-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.filter-btn[data-filter]').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          activeFilter = btn.dataset.filter;
          renderEvents();
        });
      });

      // Search
      document.getElementById('searchInput').addEventListener('input', (e) => {
        searchQuery = e.target.value.toLowerCase().trim();
        renderEvents();
      });

      // Timer update
      setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
        const m = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
        const s = String(elapsedSec % 60).padStart(2, '0');
        sessionElapsed.textContent = m + ':' + s;

        if (currentActionStartTime > 0) {
          const actionSec = ((Date.now() - currentActionStartTime) / 1000).toFixed(1);
          currentElapsed.textContent = actionSec + 's';
        }

        // Check idle status if no activity for 3.5s
        if (Date.now() - lastActivityTime > 3500) {
          statusDot.className = 'pulse-dot idle';
          statusBadge.className = 'status-badge idle';
          statusBadge.textContent = 'Idle';
        } else {
          statusDot.className = 'pulse-dot working';
          statusBadge.className = 'status-badge working';
          statusBadge.textContent = 'Working';
        }
      }, 500);

      function updateCurrentAction(action) {
        if (!action) {
          currentTitle.textContent = 'Ready for operations';
          currentWhyBox.style.display = 'none';
          currentTarget.textContent = '—';
          currentStatus.textContent = 'Idle';
          currentElapsed.textContent = '0.0s';
          currentActionStartTime = 0;
          return;
        }

        lastActivityTime = Date.now();
        currentActionStartTime = new Date(action.timestamp).getTime() || Date.now();
        currentTitle.textContent = action.display_title || action.title;
        
        const why = action.purpose || action.why;
        if (why) {
          currentWhyText.textContent = why;
          currentWhyBox.style.display = 'block';
        } else {
          currentWhyBox.style.display = 'none';
        }

        if (action.target) {
          currentTarget.textContent = typeof action.target === 'object' ? JSON.stringify(action.target) : String(action.target);
        } else {
          currentTarget.textContent = '—';
        }

        currentStatus.textContent = action.status || 'Running...';
      }

      function getIcon(event) {
        switch (event.type) {
          case 'action_started': return '<span class="event-icon icon-started">○</span>';
          case 'verification': return '<span class="event-icon icon-verified">✓</span>';
          case 'action_completed': return '<span class="event-icon icon-completed">✓</span>';
          case 'warning': return event.status === 'blocked' ? '<span class="event-icon icon-blocked">!</span>' : '<span class="event-icon icon-warning">!</span>';
          case 'failure': return '<span class="event-icon icon-failure">×</span>';
          default: return '<span class="event-icon icon-info">•</span>';
        }
      }

      function formatTime(iso) {
        if (!iso) return '';
        try {
          const d = new Date(iso);
          if (isNaN(d.getTime())) return '';
          return d.toTimeString().split(' ')[0];
        } catch {
          return '';
        }
      }

      function matchesFilter(e) {
        if (activeFilter === 'browser') {
          if (!e.tool?.includes('browser') && !e.title?.toLowerCase().includes('browser') && !e.browser_session_id) return false;
        } else if (activeFilter === 'files') {
          if (!e.tool?.includes('file') && !e.tool?.includes('patch') && !e.title?.toLowerCase().includes('file') && !e.title?.toLowerCase().includes('patch')) return false;
        } else if (activeFilter === 'shell') {
          if (!e.tool?.includes('command') && !e.tool?.includes('process') && !e.process_session_id) return false;
        } else if (activeFilter === 'git') {
          if (!e.tool?.includes('git') && !e.tool?.includes('worktree')) return false;
        } else if (activeFilter === 'desktop') {
          if (!e.tool?.includes('desktop') && !e.title?.toLowerCase().includes('desktop')) return false;
        } else if (activeFilter === 'warnings') {
          if (e.type !== 'warning' && e.type !== 'failure' && e.status !== 'blocked') return false;
        }

        if (searchQuery) {
          const hay = (e.title + ' ' + (e.purpose || '') + ' ' + (e.tool || '') + ' ' + JSON.stringify(e.target || '')).toLowerCase();
          if (!hay.includes(searchQuery)) return false;
        }

        return true;
      }

      function renderEvents() {
        const filtered = events.filter(matchesFilter);
        if (filtered.length === 0) {
          eventsList.innerHTML = '<div class="empty-state">No events match current filter.</div>';
          return;
        }

        let html = '';
        filtered.forEach(e => {
          const icon = getIcon(e);
          const time = formatTime(e.timestamp);
          const title = e.display_title || e.title;
          const isBlocked = e.status === 'blocked';
          const isVerified = e.type === 'verification' || e.status === 'verified';
          
          let badgeHtml = '';
          if (isBlocked) {
            badgeHtml = '<span class="event-badge badge-blocked">Guarded</span>';
          } else if (isVerified) {
            badgeHtml = '<span class="event-badge badge-verified">Verified</span>';
          }

          let bodyHtml = '';
          const whyText = e.purpose || e.why;
          if (whyText) {
            bodyHtml += '<div class="event-prop"><strong>Why:</strong> ' + escapeHtml(whyText) + '</div>';
          }
          if (e.target) {
            const tgtStr = typeof e.target === 'object' ? JSON.stringify(e.target) : String(e.target);
            bodyHtml += '<div class="event-prop"><strong>Target:</strong> ' + escapeHtml(tgtStr) + '</div>';
          }
          if (e.evidence) {
            const evStr = typeof e.evidence === 'object' ? JSON.stringify(e.evidence, null, 2) : String(e.evidence);
            bodyHtml += '<div class="event-prop"><strong>Evidence:</strong><div class="evidence-block">' + escapeHtml(evStr) + '</div></div>';
          }
          if (e.reason) {
            bodyHtml += '<div class="event-prop"><strong>Reason:</strong> ' + escapeHtml(e.reason) + '</div>';
          }

          html += '<div class="event-card" data-event-seq="' + escapeHtml(e.seq) + '">' +
            '<div class="event-header">' +
              icon +
              '<span class="event-time">' + time + '</span>' +
              '<span class="event-title" title="' + escapeHtml(title) + '">' + escapeHtml(title) + '</span>' +
              badgeHtml +
            '</div>' +
            (bodyHtml ? '<div class="event-body">' + bodyHtml + '</div>' : '') +
          '</div>';
        });

        eventsList.innerHTML = html;

        if (autoScroll) {
          scrollToBottom();
        } else {
          newEventsToast.style.display = 'block';
        }
      }

      function escapeHtml(str) {
        if (!str) return '';
        return String(str)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
      }

      function handleNewEventsBatch(batch, nextCursor, currentAction, runMeta) {
        if (runMeta) {
          if (runMeta.project_key && projectKey) projectKey.textContent = runMeta.project_key;
          if (runMeta.task_key && taskKey) taskKey.textContent = runMeta.task_key;
          if (runMeta.run_id && runId) {
            runId.textContent = runMeta.run_id;
            currentRunId = runMeta.run_id;
          }
        }
        if (batch && batch.length > 0) {
          lastActivityTime = Date.now();
          events.push(...batch);
          if (nextCursor) lastCursor = nextCursor;

          eventsCount.textContent = events.length + ' events';
          warnCount.textContent = events.filter(e => e.type === 'warning').length + ' warn';
          failCount.textContent = events.filter(e => e.type === 'failure').length + ' fail';

          for (const ev of batch) {
            if (ev.details && typeof ev.details === 'object') {
              if (ev.details.project_key && projectKey && projectKey.textContent === '—') projectKey.textContent = ev.details.project_key;
              if (ev.details.task_key && taskKey && (taskKey.textContent === '—' || taskKey.textContent === 'active')) taskKey.textContent = ev.details.task_key;
              if (ev.details.run_id && runId && runId.textContent === '—') {
                runId.textContent = ev.details.run_id;
                currentRunId = ev.details.run_id;
              }
            }
          }

          renderEvents();
        }

        if (currentAction !== undefined) {
          updateCurrentAction(currentAction);
        }
      }

      // Live Polling Engine
      async function pollActivity() {
        if (isEmbedded) {
          // Use MCP Host PostMessage Tool Bridge
          if (!boundRunId) {
            currentTitle.textContent = 'No run bound to this monitor';
            if (statusBadge) {
              statusBadge.className = 'status-badge idle';
              statusBadge.textContent = 'Unbound';
            }
            return;
          }
          try {
            const raw = await callMcpToolViaBridge('run_activity_read', { run_id: boundRunId, cursor: lastCursor, limit: 50 });
            const data = parseStructuredMcpData(raw);
            if (data) {
              if (data.run_id && data.run_id !== boundRunId) return;
              const runMeta = {
                project_key: data.project_key,
                task_key: data.task_key,
                run_id: boundRunId,
              };
              if (data.events) {
                handleNewEventsBatch(data.events, data.next_cursor, data.current_action, runMeta);
              } else if (data.current_action !== undefined) {
                updateCurrentAction(data.current_action);
              }
              if (statusBadge && (statusBadge.textContent.startsWith('Bridge Err') || statusBadge.textContent === 'Unbound')) {
                statusBadge.className = 'status-badge working';
                statusBadge.textContent = 'Connected';
              }
            }
          } catch (err) {
            if (statusBadge) {
              statusBadge.className = 'status-badge needs_cleanup';
              statusBadge.textContent = 'Bridge Err';
              statusBadge.title = err.message || String(err);
            }
          }
          return;
        }

        // Standalone Local HTTP Engine
        try {
          const res = await fetch('/activity/events?cursor=' + lastCursor + '&limit=100');
          if (res.ok) {
            const data = await res.json();
            const runMeta = {
              project_key: data.project_key,
              task_key: data.task_key,
              run_id: data.run_id,
            };
            handleNewEventsBatch(data.events, data.next_cursor, data.current_action, runMeta);
          }
        } catch (err) {}
      }

      if (!isEmbedded) {
        // Initial health fetch for workspace / task name in standalone mode
        fetch('/healthz')
          .then(r => r.json())
          .then(h => {
            if (h.workspace) {
              const parts = h.workspace.split(/[\\\\/]/);
              taskKey.textContent = parts[parts.length - 1] || 'Trebell';
            }
          })
          .catch(() => {});

        // Setup SSE in standalone mode
        try {
          const sse = new EventSource('/activity/stream');
          sse.onmessage = (msg) => {
            try {
              const evt = JSON.parse(msg.data);
              lastActivityTime = Date.now();
              events.push(evt);
              if (evt.seq > lastCursor) lastCursor = evt.seq;
              eventsCount.textContent = events.length + ' events';
              if (evt.type === 'warning') warnCount.textContent = (parseInt(warnCount.textContent) + 1) + ' warn';
              if (evt.type === 'failure') failCount.textContent = (parseInt(failCount.textContent) + 1) + ' fail';
              if (evt.type === 'action_started') updateCurrentAction(evt);
              else if (evt.type === 'action_completed' || evt.type === 'verification' || evt.type === 'failure') {
                updateCurrentAction(null);
              }
              renderEvents();
            } catch {}
          };
        } catch {}
      }

      setInterval(pollActivity, 750);
      pollActivity();
    })();
  </script>
</body>
</html>`;
}
