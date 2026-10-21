import { DEFAULT_APP_VERSION, THIRD_PARTY_DISCLOSURE } from '../sdk/fileOps';

export function getDashboardHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Ubuntu Cloud Drive Sync (Unofficial Client for Proton Drive)</title>
<style>
  :root {
    --bg: #1e1e24;
    --surface: #282830;
    --surface-2: #32323c;
    --border: #3f3f4c;
    --text: #f4f4f7;
    --muted: #a3a3b5;
    --accent: #3584e4;
    --accent-hover: #4a96f3;
    --success: #2ec27e;
    --warning: #e5a50a;
    --danger: #e01b24;
    --radius: 12px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Ubuntu', 'Cantarell', system-ui, -apple-system, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .disclosure-banner {
    background: #2b2412;
    border-bottom: 1px solid #634d12;
    color: #f8e45c;
    padding: 8px 20px;
    font-size: 13px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .disclosure-banner code {
    color: #cbd5e1;
    background: rgba(255,255,255,0.08);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 11px;
  }
  header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .brand-icon {
    width: 38px;
    height: 38px;
    border-radius: 10px;
    background: linear-gradient(135deg, #3584e4, #1c71d8);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .brand h1 {
    font-size: 17px;
    font-weight: 600;
  }
  .brand p {
    font-size: 12px;
    color: var(--muted);
  }
  .header-actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 500;
    background: var(--surface-2);
    border: 1px solid var(--border);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
  }
  .dot.idle { background: var(--success); }
  .dot.syncing { background: var(--accent); box-shadow: 0 0 8px var(--accent); }
  .dot.paused { background: var(--warning); }
  .dot.error, .dot.unauthenticated { background: var(--danger); }

  button {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    padding: 8px 14px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  button:hover { background: #3c3c48; }
  button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  button.primary:hover { background: var(--accent-hover); }
  button.danger {
    background: rgba(224, 27, 36, 0.16);
    border-color: var(--danger);
    color: #ff7b82;
  }

  .layout {
    display: grid;
    grid-template-columns: 230px 1fr;
    flex: 1;
  }
  nav {
    background: var(--surface);
    border-right: 1px solid var(--border);
    padding: 16px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .nav-btn {
    width: 100%;
    text-align: left;
    padding: 10px 14px;
    border: none;
    background: transparent;
    color: var(--muted);
    border-radius: 8px;
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .nav-btn:hover { background: var(--surface-2); color: var(--text); }
  .nav-btn.active {
    background: rgba(53, 132, 228, 0.18);
    color: #78aeed;
    font-weight: 600;
  }
  .badge {
    background: var(--danger);
    color: #fff;
    border-radius: 999px;
    padding: 1px 7px;
    font-size: 11px;
  }

  main {
    padding: 24px;
    overflow-y: auto;
    max-width: 1100px;
  }
  .tab-panel { display: none; flex-direction: column; gap: 20px; }
  .tab-panel.active { display: flex; }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 14px;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 18px;
  }
  .card h3 {
    font-size: 13px;
    color: var(--muted);
    font-weight: 500;
    margin-bottom: 8px;
  }
  .card .metric {
    font-size: 24px;
    font-weight: 700;
  }
  .card h2 {
    font-size: 16px;
    margin-bottom: 12px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  th, td {
    text-align: left;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
  }
  th { color: var(--muted); font-weight: 500; }
  tr:hover td { background: rgba(255,255,255,0.02); }

  .input-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 14px;
  }
  .input-row label {
    font-size: 13px;
    color: var(--muted);
  }
  input[type="text"], input[type="number"], select, textarea {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 9px 12px;
    border-radius: 8px;
    font-size: 13px;
    width: 100%;
  }
  .folder-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .folder-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .progress-bar {
    height: 6px;
    background: var(--bg);
    border-radius: 999px;
    overflow: hidden;
    margin-top: 6px;
  }
  .progress-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s ease;
  }
</style>
</head>
<body>
  <div class="disclosure-banner">
    <span><strong>Notice:</strong> ${THIRD_PARTY_DISCLOSURE}</span>
    <code>x-pm-appversion: ${DEFAULT_APP_VERSION}</code>
  </div>

  <header>
    <div class="brand">
      <div class="brand-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2">
          <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>
        </svg>
      </div>
      <div>
        <h1>Ubuntu Cloud Sync</h1>
        <p id="syncDirSubtitle">~/ProtonDrive</p>
      </div>
    </div>

    <div class="header-actions">
      <div class="status-pill">
        <span class="dot" id="stateDot"></span>
        <span id="stateLabel">Connecting...</span>
      </div>
      <button id="pauseResumeBtn" onclick="togglePause()">Pause</button>
      <button class="primary" onclick="triggerSyncNow()">Sync Now</button>
    </div>
  </header>

  <div class="layout">
    <nav>
      <button class="nav-btn active" onclick="switchTab('overview', this)">Overview & Activity</button>
      <button class="nav-btn" onclick="switchTab('browser', this)">Cloud File Browser</button>
      <button class="nav-btn" onclick="switchTab('selective', this)">Selective Sync</button>
      <button class="nav-btn" onclick="switchTab('conflicts', this)">
        <span>Conflicts</span>
        <span class="badge" id="conflictBadge" style="display:none">0</span>
      </button>
      <button class="nav-btn" onclick="switchTab('settings', this)">Settings & Linux</button>
    </nav>

    <main>
      <!-- Overview Tab -->
      <section id="tab-overview" class="tab-panel active">
        <div class="card" id="authCard">
          <h2>Proton Account Session</h2>
          <p style="font-size: 13px; color: var(--muted); margin-bottom: 12px;">
            ${THIRD_PARTY_DISCLOSURE} Sign-in uses official Proton web authentication and stores session tokens in your Ubuntu OS Keyring (libsecret).
          </p>
          <div style="display:flex; align-items:center; gap: 12px; flex-wrap: wrap;">
            <span id="authStatusText" style="font-weight: 600;">Checking session...</span>
            <button class="primary" id="loginBtn" onclick="startWebLogin()">Sign In via Browser</button>
            <button class="danger" id="logoutBtn" onclick="logoutAccount()" style="display:none">Sign Out</button>
          </div>
          <div id="loginUrlBox" style="display:none; margin-top: 12px; padding: 10px; background: var(--bg); border-radius: 8px; font-size: 12px;">
            Browser opened. If it did not open automatically, visit:<br/>
            <a id="loginUrlLink" href="#" target="_blank" style="color: #78aeed; word-break: break-all;"></a>
          </div>
        </div>

        <div class="stats-grid">
          <div class="card">
            <h3>Synced Files</h3>
            <div class="metric" id="statFiles">0</div>
          </div>
          <div class="card">
            <h3>Synced Folders</h3>
            <div class="metric" id="statFolders">0</div>
          </div>
          <div class="card">
            <h3>Local Synced Size</h3>
            <div class="metric" id="statBytes">0 B</div>
          </div>
          <div class="card">
            <h3>Unresolved Conflicts</h3>
            <div class="metric" id="statConflicts">0</div>
          </div>
        </div>

        <div class="card" id="activeTransfersCard" style="display:none;">
          <h2>Active Transfers</h2>
          <div id="activeTransfersList" class="folder-list"></div>
        </div>

        <div class="card">
          <h2>Recent Sync Activity</h2>
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Action</th>
                <th>Path</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody id="activityTableBody">
              <tr><td colspan="4" style="color:var(--muted)">No activity yet.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Cloud Browser Tab -->
      <section id="tab-browser" class="tab-panel">
        <div class="card">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; gap:10px;">
            <div style="display:flex; align-items:center; gap:8px;">
              <button onclick="navigateUpRemote()">Up</button>
              <code id="remotePathInput" style="padding:6px 10px; background:var(--bg); border-radius:6px;">/my-files</code>
            </div>
            <div style="display:flex; gap:8px;">
              <button onclick="promptCreateRemoteFolder()">+ New Folder</button>
              <button class="primary" onclick="loadRemoteBrowser()">Refresh</button>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Size</th>
                <th>Modified</th>
              </tr>
            </thead>
            <tbody id="remoteBrowserBody">
              <tr><td colspan="4" style="color:var(--muted)">Sign in to browse remote Proton Drive files.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Selective Sync Tab -->
      <section id="tab-selective" class="tab-panel">
        <div class="card">
          <h2>Selective Folder Sync (/my-files)</h2>
          <p style="font-size:13px; color:var(--muted); margin-bottom:14px;">
            Uncheck remote top-level folders you want to exclude from syncing to your local Ubuntu drive.
          </p>
          <div id="selectiveFoldersList" class="folder-list">
            <div style="color:var(--muted); font-size:13px;">Loading remote folders...</div>
          </div>
        </div>

        <div class="card">
          <h2>Ignore Patterns (Glob)</h2>
          <div class="input-row">
            <label>One glob pattern per line (e.g. <code>node_modules</code>, <code>.git</code>, <code>*.tmp</code>)</label>
            <textarea id="ignorePatternsInput" rows="6"></textarea>
          </div>
          <button class="primary" onclick="saveIgnorePatterns()">Save Ignore Patterns</button>
        </div>
      </section>

      <!-- Conflicts Tab -->
      <section id="tab-conflicts" class="tab-panel">
        <div class="card">
          <h2>Conflict Resolution Center</h2>
          <p style="font-size:13px; color:var(--muted); margin-bottom:14px;">
            Resolve files modified simultaneously on Ubuntu and Proton Drive.
          </p>
          <table>
            <thead>
              <tr>
                <th>File Path</th>
                <th>Detected</th>
                <th>Status / Resolution</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="conflictsTableBody">
              <tr><td colspan="4" style="color:var(--muted)">No conflicts detected.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Settings Tab -->
      <section id="tab-settings" class="tab-panel">
        <div class="card">
          <h2>Synchronization Preferences</h2>
          <div class="input-row">
            <label>Local Sync Folder on Ubuntu</label>
            <input type="text" id="settingSyncDir" />
          </div>
          <div class="input-row">
            <label>Conflict Resolution Strategy</label>
            <select id="settingConflictStrategy">
              <option value="keep-both">Keep Both (create conflict copy with timestamp & hostname)</option>
              <option value="keep-local">Keep Local (overwrite remote revision)</option>
              <option value="keep-remote">Keep Remote (overwrite local file)</option>
              <option value="prompt">Ask / Queue in Conflict Center</option>
            </select>
          </div>
          <div class="input-row">
            <label>
              <input type="checkbox" id="settingNotifications" /> Enable Ubuntu Desktop Notifications (notify-send)
            </label>
          </div>
          <button class="primary" onclick="saveSettings()">Save Settings</button>
        </div>

        <div class="card">
          <h2>Ubuntu Desktop Integration</h2>
          <div class="folder-list">
            <div class="folder-item">
              <div>
                <strong>Systemd User Service</strong>
                <div style="font-size:12px; color:var(--muted)"><code>systemctl --user enable --now proton-drive-ubuntu.service</code></div>
              </div>
              <span id="systemdStatusBadge" class="status-pill">Checking...</span>
            </div>
            <div class="folder-item">
              <div>
                <strong>Nautilus (GNOME Files) Extension</strong>
                <div style="font-size:12px; color:var(--muted)">Provides sync emblems & right-click menu in Ubuntu Files</div>
              </div>
              <span class="status-pill">Installed in <code>linux/nautilus/</code></span>
            </div>
          </div>
        </div>
      </section>
    </main>
  </div>

<script>
  let currentStatus = null;
  let currentRemotePath = '/my-files';

  function switchTab(name, btn) {
    document.querySelectorAll('.tab-panel').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
    document.getElementById('tab-' + name).classList.add('active');
    btn.classList.add('active');
    if (name === 'browser') loadRemoteBrowser();
    if (name === 'selective') loadSelectiveSync();
    if (name === 'conflicts') loadConflicts();
  }

  function formatBytes(bytes) {
    if (!bytes || bytes < 1024) return (bytes || 0) + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let val = bytes / 1024;
    let i = 0;
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    return val.toFixed(1) + ' ' + units[i];
  }

  async function refreshStatus() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      currentStatus = data;

      document.getElementById('syncDirSubtitle').textContent = data.syncDir;
      const dot = document.getElementById('stateDot');
      dot.className = 'dot ' + data.state;
      const labels = {
        idle: 'Up to date (Event Stream Active)',
        syncing: data.currentAction ? ('Syncing: ' + data.currentAction) : 'Syncing...',
        paused: 'Paused',
        unauthenticated: 'Sign in required',
        error: 'Sync Error'
      };
      document.getElementById('stateLabel').textContent = labels[data.state] || data.state;
      document.getElementById('pauseResumeBtn').textContent = data.settings.paused ? 'Resume' : 'Pause';

      document.getElementById('statFiles').textContent = data.stats.totalFiles;
      document.getElementById('statFolders').textContent = data.stats.totalFolders;
      document.getElementById('statBytes').textContent = formatBytes(data.stats.totalBytes);
      document.getElementById('statConflicts').textContent = data.stats.unresolvedConflicts;

      const badge = document.getElementById('conflictBadge');
      if (data.stats.unresolvedConflicts > 0) {
        badge.style.display = 'inline-block';
        badge.textContent = data.stats.unresolvedConflicts;
      } else {
        badge.style.display = 'none';
      }

      const authText = document.getElementById('authStatusText');
      const loginBtn = document.getElementById('loginBtn');
      const logoutBtn = document.getElementById('logoutBtn');
      if (data.loggedIn) {
        authText.textContent = 'Connected to Proton Drive (OS Keyring Session Active)';
        authText.style.color = 'var(--success)';
        loginBtn.style.display = 'none';
        logoutBtn.style.display = 'inline-block';
        document.getElementById('loginUrlBox').style.display = 'none';
      } else {
        authText.textContent = 'Not signed in';
        authText.style.color = 'var(--warning)';
        loginBtn.style.display = 'inline-block';
        logoutBtn.style.display = 'none';
      }

      // Active transfers
      const transfersCard = document.getElementById('activeTransfersCard');
      const transfersList = document.getElementById('activeTransfersList');
      if (data.activeTransfers && data.activeTransfers.length > 0) {
        transfersCard.style.display = 'block';
        transfersList.innerHTML = data.activeTransfers.map(t => {
          const pct = t.totalBytes > 0 ? Math.min(100, Math.round((t.bytesTransferred / t.totalBytes) * 100)) : 50;
          return '<div class="folder-item" style="flex-direction:column; align-items:stretch;">' +
            '<div style="display:flex; justify-content:space-between; font-size:13px;">' +
              '<span><strong>' + (t.direction === 'upload' ? 'Uploading' : 'Downloading') + ':</strong> ' + t.relPath + '</span>' +
              '<span>' + formatBytes(t.bytesTransferred) + ' / ' + formatBytes(t.totalBytes) + ' (' + pct + '%)</span>' +
            '</div>' +
            '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
          '</div>';
        }).join('');
      } else {
        transfersCard.style.display = 'none';
      }

      if (data.systemd) {
        document.getElementById('systemdStatusBadge').textContent =
          data.systemd.active ? 'Active (Running)' : (data.systemd.enabled ? 'Enabled' : 'Inactive');
      }

      if (document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'SELECT') {
        document.getElementById('settingSyncDir').value = data.settings.syncDir;
        document.getElementById('settingConflictStrategy').value = data.settings.conflictStrategy;
        document.getElementById('settingNotifications').checked = data.settings.notificationsEnabled;
        document.getElementById('ignorePatternsInput').value = (data.settings.ignorePatterns || []).join('\\n');
      }

      // Activity table
      const actRes = await fetch('/api/activity');
      const activities = await actRes.json();
      const tbody = document.getElementById('activityTableBody');
      if (activities.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted)">No sync activity recorded yet.</td></tr>';
      } else {
        tbody.innerHTML = activities.slice(0, 25).map(a => {
          const time = new Date(a.timestamp).toLocaleTimeString();
          return '<tr>' +
            '<td style="color:var(--muted)">' + time + '</td>' +
            '<td><code>' + a.action + '</code></td>' +
            '<td>' + a.localRelPath + '</td>' +
            '<td>' + a.details + '</td>' +
          '</tr>';
        }).join('');
      }
    } catch (e) {
      document.getElementById('stateLabel').textContent = 'Daemon Offline';
    }
  }

  async function triggerSyncNow() {
    await fetch('/api/sync', { method: 'POST' });
    await refreshStatus();
  }

  async function togglePause() {
    if (!currentStatus) return;
    const nextPaused = !currentStatus.settings.paused;
    await fetch('/api/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: nextPaused })
    });
    await refreshStatus();
  }

  async function startWebLogin() {
    const res = await fetch('/api/auth/login', { method: 'POST' });
    const data = await res.json();
    if (data.signInUrl) {
      const box = document.getElementById('loginUrlBox');
      const link = document.getElementById('loginUrlLink');
      box.style.display = 'block';
      link.href = data.signInUrl;
      link.textContent = data.signInUrl;
    }
  }

  async function logoutAccount() {
    await fetch('/api/auth/logout', { method: 'POST' });
    await refreshStatus();
  }

  async function loadRemoteBrowser(targetPath) {
    if (targetPath) currentRemotePath = targetPath;
    document.getElementById('remotePathInput').textContent = currentRemotePath;
    const tbody = document.getElementById('remoteBrowserBody');
    tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted)">Loading ' + currentRemotePath + '...</td></tr>';
    const res = await fetch('/api/remote/list?path=' + encodeURIComponent(currentRemotePath));
    const data = await res.json();
    if (!res.ok) {
      tbody.innerHTML = '<tr><td colspan="4" style="color:var(--danger)">' + (data.error || 'Failed to load') + '</td></tr>';
      return;
    }
    if (!data.items || data.items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted)">Folder is empty.</td></tr>';
      return;
    }
    tbody.innerHTML = data.items.map(item => {
      const nextPath = currentRemotePath.replace(/\\/$/, '') + '/' + item.name;
      const nameCell = item.type === 'folder'
        ? '<a href="#" style="color:#78aeed; text-decoration:none; font-weight:600;" onclick="loadRemoteBrowser(\\'' + nextPath.replace(/'/g, "\\\\'") + '\\'); return false;">📁 ' + item.name + '</a>'
        : '📄 ' + item.name;
      return '<tr>' +
        '<td>' + nameCell + '</td>' +
        '<td>' + item.type + '</td>' +
        '<td>' + (item.type === 'file' ? formatBytes(item.size) : '—') + '</td>' +
        '<td>' + new Date(item.modificationTime).toLocaleString() + '</td>' +
      '</tr>';
    }).join('');
  }

  function navigateUpRemote() {
    const parts = currentRemotePath.split('/').filter(Boolean);
    if (parts.length > 1) {
      parts.pop();
      loadRemoteBrowser('/' + parts.join('/'));
    }
  }

  async function promptCreateRemoteFolder() {
    const name = prompt('New folder name in ' + currentRemotePath + ':');
    if (!name) return;
    await fetch('/api/remote/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentPath: currentRemotePath, name })
    });
    await loadRemoteBrowser();
  }

  async function loadSelectiveSync() {
    const container = document.getElementById('selectiveFoldersList');
    const res = await fetch('/api/selective-sync/folders');
    const data = await res.json();
    if (!data.folders || data.folders.length === 0) {
      container.innerHTML = '<div style="color:var(--muted); font-size:13px;">No top-level folders found (or not signed in).</div>';
      return;
    }
    container.innerHTML = data.folders.map(f => {
      const checked = !f.excluded ? 'checked' : '';
      return '<label class="folder-item">' +
        '<span>📁 <strong>' + f.name + '</strong></span>' +
        '<input type="checkbox" ' + checked + ' onchange="toggleSelectiveFolder(\\'' + f.name.replace(/'/g, "\\\\'") + '\\', this.checked)" />' +
      '</label>';
    }).join('');
  }

  async function toggleSelectiveFolder(folderName, included) {
    if (!currentStatus) return;
    const excluded = new Set(currentStatus.settings.excludedFolders || []);
    if (included) excluded.delete(folderName);
    else excluded.add(folderName);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ excludedFolders: Array.from(excluded) })
    });
    await refreshStatus();
  }

  async function saveIgnorePatterns() {
    const raw = document.getElementById('ignorePatternsInput').value;
    const ignorePatterns = raw.split('\\n').map(s => s.trim()).filter(Boolean);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ignorePatterns })
    });
    await refreshStatus();
  }

  async function loadConflicts() {
    const res = await fetch('/api/conflicts');
    const conflicts = await res.json();
    const tbody = document.getElementById('conflictsTableBody');
    if (!conflicts || conflicts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted)">No conflicts recorded.</td></tr>';
      return;
    }
    tbody.innerHTML = conflicts.map(c => {
      const actions = c.resolved
        ? '<span style="color:var(--success)">Resolved (' + c.resolution + ')</span>'
        : '<div style="display:flex; gap:6px;">' +
            '<button onclick="resolveConflict(' + c.id + ', \\'keep-both\\')">Keep Both</button>' +
            '<button onclick="resolveConflict(' + c.id + ', \\'keep-local\\')">Keep Local</button>' +
            '<button onclick="resolveConflict(' + c.id + ', \\'keep-remote\\')">Keep Remote</button>' +
          '</div>';
      return '<tr>' +
        '<td>' + c.localRelPath + '</td>' +
        '<td>' + new Date(c.detectedAt).toLocaleString() + '</td>' +
        '<td>' + (c.resolved ? 'Resolved: ' + c.resolution : 'Unresolved') + '</td>' +
        '<td>' + actions + '</td>' +
      '</tr>';
    }).join('');
  }

  async function resolveConflict(id, choice) {
    await fetch('/api/conflicts/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, choice })
    });
    await loadConflicts();
    await refreshStatus();
  }

  async function saveSettings() {
    const syncDir = document.getElementById('settingSyncDir').value.trim();
    const conflictStrategy = document.getElementById('settingConflictStrategy').value;
    const notificationsEnabled = document.getElementById('settingNotifications').checked;
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ syncDir, conflictStrategy, notificationsEnabled })
    });
    await refreshStatus();
  }

  refreshStatus();
  setInterval(refreshStatus, 2500);
</script>
</body>
</html>`;
}
