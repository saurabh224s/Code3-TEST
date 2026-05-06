/**
 * Daily Todo App — app.js
 * Implements all 22 FRs and 8 NFRs from spec.md (002-todo)
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════════════════════════════════ */
const STORAGE_KEY   = 'todo_v1_tasks';
const PREFS_KEY     = 'todo_v1_prefs';
const META_KEY      = 'todo_v1_meta';
const APP_VERSION   = '1.0.0';
const MAX_CHARS     = 500;
const CHANNEL_NAME  = 'daily_todo_tab_sync';

/* ═══════════════════════════════════════════════════════════════════════
   APPLICATION STATE
═══════════════════════════════════════════════════════════════════════ */
const state = {
  /** @type {Object.<string, Task[]>} date-string → Task[] */
  tasks       : {},
  currentDate : todayStr(),
  isReadOnly  : false,
  /** id of task awaiting delete confirmation */
  pendingDeleteId : null,
  /** id of task currently being edited inline */
  editingTaskId   : null,
  prefs: {
    lastViewedDate : todayStr(),
    sortOrder      : 'newest-first',
  },
};

/* ═══════════════════════════════════════════════════════════════════════
   UTILITY FUNCTIONS
═══════════════════════════════════════════════════════════════════════ */

/** @returns {string} today as YYYY-MM-DD in local time */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

/** RFC-4122 v4 UUID */
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/** Human-friendly date label */
function labelForDate(dateStr) {
  const today = todayStr();
  if (dateStr === today) return 'Today';

  const yest = new Date();
  yest.setDate(yest.getDate() - 1);
  const yesterdayStr = `${yest.getFullYear()}-${pad(yest.getMonth()+1)}-${pad(yest.getDate())}`;
  if (dateStr === yesterdayStr) return 'Yesterday';

  // Parse as local date (avoid UTC offset shifting day)
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m-1, d).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function escHtml(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(str));
  return d.innerHTML;
}

/* ═══════════════════════════════════════════════════════════════════════
   STORAGE LAYER  (NFR-3 non-blocking, NFR-7 atomic, NFR-8 ≤500 ms check)
═══════════════════════════════════════════════════════════════════════ */

/**
 * Initialise: test availability, parse existing data, detect corruption.
 * Must complete within 500 ms (NFR-8).
 */
function initStorage() {
  const t0 = performance.now();
  try {
    // Availability probe
    localStorage.setItem('_todo_probe', '1');
    localStorage.removeItem('_todo_probe');

    // Recover from a previously crashed atomic write
    const tmp = localStorage.getItem(STORAGE_KEY + '_tmp');
    if (tmp) {
      localStorage.setItem(STORAGE_KEY, tmp);
      localStorage.removeItem(STORAGE_KEY + '_tmp');
    }

    // Load tasks
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Task data is corrupted.');
      state.tasks = parsed;
    }

    // Load preferences
    const prefsRaw = localStorage.getItem(PREFS_KEY);
    if (prefsRaw) {
      const p = JSON.parse(prefsRaw);
      state.prefs = Object.assign(state.prefs, p);
    }

    const elapsed = performance.now() - t0;
    if (elapsed > 500) {
      enterReadOnly(`Storage took ${Math.round(elapsed)} ms to load (limit 500 ms).`);
    }

    return true;
  } catch (err) {
    enterReadOnly(`Storage unavailable or corrupted: ${err.message}`);
    return false;
  }
}

/**
 * Atomic write: write to _tmp first, then copy to main key, then remove _tmp.
 * If crash happens mid-write, initStorage() recovers from _tmp on next launch.
 * @returns {boolean} success
 */
function persist() {
  if (state.isReadOnly) return false;
  try {
    const data = JSON.stringify(state.tasks);
    localStorage.setItem(STORAGE_KEY + '_tmp', data);   // step 1
    localStorage.setItem(STORAGE_KEY, data);             // step 2
    localStorage.removeItem(STORAGE_KEY + '_tmp');       // step 3
    persistMeta();
    return true;
  } catch (err) {
    if (err.name === 'QuotaExceededError') {
      handleQuotaExceeded();
    } else {
      enterReadOnly(`Storage write failed: ${err.message}`);
    }
    return false;
  }
}

function persistPrefs() {
  if (state.isReadOnly) return;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)); } catch(_) {}
}

function persistMeta() {
  try {
    const allDates  = Object.keys(state.tasks);
    const allTasks  = Object.values(state.tasks).flat();
    const sorted    = [...allDates].sort();
    localStorage.setItem(META_KEY, JSON.stringify({
      version      : APP_VERSION,
      lastModified : new Date().toISOString(),
      totalTaskCount: allTasks.length,
      oldestTaskDate: sorted[0]              ?? null,
      newestTaskDate: sorted[sorted.length-1] ?? null,
    }));
  } catch(_) {}
}

function enterReadOnly(msg) {
  state.isReadOnly = true;
  showErrorBanner('⚠️ READ-ONLY MODE — ' + msg + '  All write operations are disabled.');
  // Disable add-task controls
  const inp = document.getElementById('new-task-input');
  const btn = document.getElementById('add-task-btn');
  if (inp) inp.disabled = true;
  if (btn) btn.disabled = true;
}

function handleQuotaExceeded() {
  enterReadOnly('Storage quota exceeded. Delete tasks to free space; new tasks cannot be saved.');
}

/* ═══════════════════════════════════════════════════════════════════════
   TASK CRUD  (FR-1 … FR-19)
═══════════════════════════════════════════════════════════════════════ */

/**
 * @typedef {{
 *   id: string,
 *   description: string,
 *   completed: boolean,
 *   createdAt: string,
 *   completedAt: string|null,
 *   date: string
 * }} Task
 */

function tasksForDate(dateStr) {
  return state.tasks[dateStr] ?? [];
}

/** FR-1, FR-2, FR-3 */
function createTask(description, dateStr) {
  if (state.isReadOnly) return null;
  const desc = description.trim();
  if (!desc) return null;                    // FR-2
  if (desc.length > MAX_CHARS) return null;  // FR-3

  const task = {
    id         : uuid(),           // FR-19
    description: desc,
    completed  : false,
    createdAt  : new Date().toISOString(),
    completedAt: null,
    date       : dateStr,
  };

  if (!state.tasks[dateStr]) state.tasks[dateStr] = [];
  state.tasks[dateStr].unshift(task);  // newest first (FR-17)

  if (!persist()) {
    // Rollback on storage failure
    state.tasks[dateStr] = state.tasks[dateStr].filter(t => t.id !== task.id);
    if (!state.tasks[dateStr].length) delete state.tasks[dateStr];
    return null;
  }
  return task;
}

/** FR-4  (editing preserves completion status) */
function editTask(taskId, dateStr, newDescription) {
  if (state.isReadOnly) return false;
  const tasks = state.tasks[dateStr];
  if (!tasks) return false;
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return false;

  const desc = newDescription.trim();
  if (!desc || desc.length > MAX_CHARS) return false;

  const prev = tasks[idx].description;
  tasks[idx].description = desc;

  if (!persist()) { tasks[idx].description = prev; return false; }
  return true;
}

/** FR-5  (caller must have confirmed deletion) */
function deleteTask(taskId, dateStr) {
  if (state.isReadOnly) return false;
  const tasks = state.tasks[dateStr];
  if (!tasks) return false;
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return false;

  const [removed] = tasks.splice(idx, 1);
  if (!tasks.length) delete state.tasks[dateStr];

  if (!persist()) {
    // Rollback
    if (!state.tasks[dateStr]) state.tasks[dateStr] = [];
    state.tasks[dateStr].splice(idx, 0, removed);
    return false;
  }
  return true;
}

/** FR-6, FR-7, FR-8 */
function toggleComplete(taskId, dateStr) {
  if (state.isReadOnly) return false;
  const tasks = state.tasks[dateStr];
  if (!tasks) return false;
  const task = tasks.find(t => t.id === taskId);
  if (!task) return false;

  const wasCompleted    = task.completed;
  const wasCompletedAt  = task.completedAt;

  task.completed   = !task.completed;
  task.completedAt = task.completed ? new Date().toISOString() : null;  // FR-8

  if (!persist()) {
    task.completed   = wasCompleted;
    task.completedAt = wasCompletedAt;
    return false;
  }
  return true;
}

/* ═══════════════════════════════════════════════════════════════════════
   SORTING  (FR-17, FR-18)
═══════════════════════════════════════════════════════════════════════ */
function sortedGroups(dateStr) {
  const all = tasksForDate(dateStr);
  const pending   = all.filter(t => !t.completed)
    .sort((a,b) => new Date(b.createdAt)   - new Date(a.createdAt));   // FR-17
  const completed = all.filter(t =>  t.completed)
    .sort((a,b) => new Date(b.completedAt) - new Date(a.completedAt)); // FR-18
  return { pending, completed };
}

/* ═══════════════════════════════════════════════════════════════════════
   DATE NAVIGATION  (FR-9, FR-11, FR-14)
═══════════════════════════════════════════════════════════════════════ */
function gotoDate(dateStr) {
  state.currentDate          = dateStr;
  state.prefs.lastViewedDate = dateStr;
  state.editingTaskId        = null;
  persistPrefs();
  render();
}

function shiftDate(delta) {
  const [y, m, d] = state.currentDate.split('-').map(Number);
  const next = new Date(y, m-1, d);
  next.setDate(next.getDate() + delta);
  gotoDate(`${next.getFullYear()}-${pad(next.getMonth()+1)}-${pad(next.getDate())}`);
}

/* ═══════════════════════════════════════════════════════════════════════
   RENDERING
═══════════════════════════════════════════════════════════════════════ */
function render() {
  renderDateHeader();
  renderStats();
  renderTaskList();
}

function renderDateHeader() {
  document.getElementById('date-picker').value = state.currentDate;
  document.getElementById('date-label').textContent = labelForDate(state.currentDate);
}

function renderStats() {
  const tasks     = tasksForDate(state.currentDate);
  const nPending  = tasks.filter(t => !t.completed).length;
  const nComplete = tasks.filter(t =>  t.completed).length;
  const el        = document.getElementById('task-stats');

  if (!tasks.length) { el.innerHTML = ''; return; }

  el.innerHTML = `
    <span class="stat-pending">${nPending} pending</span>
    <span class="stat-sep">·</span>
    <span class="stat-completed">${nComplete} completed</span>
    <span class="stat-sep">·</span>
    <span class="stat-total">${tasks.length} total</span>`;
}

/** FR-10, FR-15, FR-16 */
function renderTaskList() {
  const container = document.getElementById('task-list');
  const { pending, completed } = sortedGroups(state.currentDate);

  if (!pending.length && !completed.length) {
    // FR-15 empty state
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📝</div>
        <p>No tasks for today. Add your first task!</p>
      </div>`;
    return;
  }

  let html = '';
  if (pending.length) {
    html += `
      <div class="task-section">
        <h3 class="section-title">
          Pending
          <span class="count-badge badge-pending">${pending.length}</span>
        </h3>
        <ul class="tasks-ul">${pending.map(taskHTML).join('')}</ul>
      </div>`;
  }
  if (completed.length) {
    html += `
      <div class="task-section">
        <h3 class="section-title">
          Completed
          <span class="count-badge badge-completed">${completed.length}</span>
        </h3>
        <ul class="tasks-ul">${completed.map(taskHTML).join('')}</ul>
      </div>`;
  }

  container.innerHTML = html;
  bindTaskEvents();
}

/** Returns HTML string for one task row */
function taskHTML(task) {
  const isEditing = state.editingTaskId === task.id;
  const disabled  = state.isReadOnly ? 'disabled' : '';

  if (isEditing) {
    return `
      <li class="task-item is-editing" data-id="${task.id}">
        <div style="width:20px;flex-shrink:0"></div>
        <div class="task-edit-wrap">
          <textarea
            id="edit-${task.id}"
            class="task-edit-input"
            maxlength="${MAX_CHARS}"
          >${escHtml(task.description)}</textarea>
          <div class="edit-footer">
            <span class="edit-char-count" id="ecc-${task.id}">
              ${task.description.length} / ${MAX_CHARS}
            </span>
            <div class="edit-actions">
              <button class="btn-primary btn-small js-save-edit" data-id="${task.id}">Save</button>
              <button class="btn-secondary btn-small js-cancel-edit" data-id="${task.id}">Cancel</button>
            </div>
          </div>
          <p class="edit-error hidden" id="ee-${task.id}">
            Task description cannot be empty.
          </p>
        </div>
      </li>`;
  }

  const timeTag = task.completed && task.completedAt
    ? `<span class="meta-completed">✓ ${fmtTime(task.completedAt)}</span>`
    : '';
  const addedTag = `<span class="meta-created">Added ${fmtTime(task.createdAt)}</span>`;

  return `
    <li class="task-item" data-id="${task.id}">
      <div class="task-checkbox-wrap">
        <input
          type="checkbox"
          id="cb-${task.id}"
          class="task-checkbox js-toggle"
          data-id="${task.id}"
          ${task.completed ? 'checked' : ''}
          ${disabled}
        />
      </div>
      <div class="task-content">
        <label for="cb-${task.id}">
          <span class="task-desc ${task.completed ? 'done' : ''}">${escHtml(task.description)}</span>
        </label>
        <div class="task-meta">${timeTag}${addedTag}</div>
      </div>
      <div class="task-actions">
        ${!state.isReadOnly ? `
          <button class="icon-btn js-edit"   data-id="${task.id}" title="Edit task">✏️</button>
          <button class="icon-btn js-delete" data-id="${task.id}" title="Delete task">🗑️</button>
        ` : ''}
      </div>
    </li>`;
}

/** Attach event listeners after innerHTML update */
function bindTaskEvents() {
  // Toggle completion  (FR-6, FR-7)
  document.querySelectorAll('.js-toggle').forEach(cb => {
    cb.addEventListener('change', e => {
      if (toggleComplete(e.target.dataset.id, state.currentDate)) render();
    });
  });

  // Open inline edit  (FR-4)
  document.querySelectorAll('.js-edit').forEach(btn => {
    btn.addEventListener('click', e => {
      state.editingTaskId = e.currentTarget.dataset.id;
      render();
      const ta = document.getElementById(`edit-${state.editingTaskId}`);
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        ta.addEventListener('input', () => {
          const cc = document.getElementById(`ecc-${state.editingTaskId}`);
          if (cc) cc.textContent = `${ta.value.length} / ${MAX_CHARS}`;
        });
      }
    });
  });

  // Save edit
  document.querySelectorAll('.js-save-edit').forEach(btn => {
    btn.addEventListener('click', e => commitEdit(e.currentTarget.dataset.id));
  });

  // Cancel edit
  document.querySelectorAll('.js-cancel-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      state.editingTaskId = null;
      render();
    });
  });

  // Delete  (FR-5)
  document.querySelectorAll('.js-delete').forEach(btn => {
    btn.addEventListener('click', e => openDeleteModal(e.currentTarget.dataset.id));
  });
}

function commitEdit(taskId) {
  const ta  = document.getElementById(`edit-${taskId}`);
  const err = document.getElementById(`ee-${taskId}`);
  if (!ta) return;
  const val = ta.value.trim();
  if (!val) { err && err.classList.remove('hidden'); return; }

  if (editTask(taskId, state.currentDate, val)) {
    state.editingTaskId = null;
    render();
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   MODALS
═══════════════════════════════════════════════════════════════════════ */
function openDeleteModal(taskId) {
  state.pendingDeleteId = taskId;
  document.getElementById('delete-modal').classList.remove('hidden');
}

function closeDeleteModal() {
  state.pendingDeleteId = null;
  document.getElementById('delete-modal').classList.add('hidden');
}

function showErrorBanner(msg) {
  const banner = document.getElementById('error-banner');
  document.getElementById('error-message').textContent = msg;
  banner.classList.remove('hidden');
}

/* ═══════════════════════════════════════════════════════════════════════
   MULTI-TAB DETECTION  (FR-22)
   Primary:  BroadcastChannel API
   Fallback: localStorage 'storage' event
═══════════════════════════════════════════════════════════════════════ */
function initMultiTabDetection() {
  if (typeof BroadcastChannel !== 'undefined') {
    const ch = new BroadcastChannel(CHANNEL_NAME);

    ch.onmessage = evt => {
      if (evt.data === 'PING') {
        ch.postMessage('PONG');         // tell new tab we exist
      } else if (evt.data === 'PONG') {
        showMultiTabWarning();          // another tab answered our PING
      }
    };

    ch.postMessage('PING');             // announce ourselves
    window.addEventListener('beforeunload', () => ch.close());
  } else {
    // Fallback via storage key + storage event
    const KEY = 'todo_tab_heartbeat';
    const myId = uuid();
    try { localStorage.setItem(KEY, myId); } catch(_) {}

    window.addEventListener('storage', e => {
      if (e.key === KEY && e.newValue && e.newValue !== myId) showMultiTabWarning();
    });
  }
}

function showMultiTabWarning() {
  document.getElementById('multitab-modal').classList.remove('hidden');
}

/* ═══════════════════════════════════════════════════════════════════════
   BOOTSTRAP
═══════════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {

  // 1. Storage (must complete ≤500 ms per NFR-8)
  initStorage();

  // 2. Multi-tab guard (FR-22)
  initMultiTabDetection();

  // 3. Restore last-viewed date (FR-14)
  state.currentDate = state.prefs.lastViewedDate || todayStr();

  // ── Date navigation ────────────────────────────────────────────
  document.getElementById('prev-day-btn')
    .addEventListener('click', () => shiftDate(-1));

  document.getElementById('next-day-btn')
    .addEventListener('click', () => shiftDate(+1));

  document.getElementById('today-btn')
    .addEventListener('click', () => gotoDate(todayStr()));

  document.getElementById('date-picker')
    .addEventListener('change', e => gotoDate(e.target.value));

  // ── Add-task form ──────────────────────────────────────────────
  const newInput  = document.getElementById('new-task-input');
  const addBtn    = document.getElementById('add-task-btn');
  const charCount = document.getElementById('char-count');
  const inputErr  = document.getElementById('input-error');

  newInput.addEventListener('input', () => {
    const len = newInput.value.length;
    charCount.textContent = `${len} / ${MAX_CHARS}`;
    charCount.classList.toggle('char-warn', len > 450);
    if (len > 0) inputErr.classList.add('hidden');
  });

  // Enter submits (Shift+Enter = newline)
  newInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitNewTask(); }
  });

  addBtn.addEventListener('click', submitNewTask);

  function submitNewTask() {
    if (state.isReadOnly) return;
    const desc = newInput.value.trim();
    if (!desc) {
      inputErr.classList.remove('hidden');
      newInput.focus();
      return;
    }
    inputErr.classList.add('hidden');
    if (createTask(desc, state.currentDate)) {
      newInput.value        = '';
      charCount.textContent = `0 / ${MAX_CHARS}`;
      charCount.classList.remove('char-warn');
      render();
      newInput.focus();
    }
  }

  // ── Delete modal ───────────────────────────────────────────────
  document.getElementById('confirm-delete-btn').addEventListener('click', () => {
    if (state.pendingDeleteId) {
      deleteTask(state.pendingDeleteId, state.currentDate);
      closeDeleteModal();
      render();
    }
  });

  document.getElementById('cancel-delete-btn').addEventListener('click', closeDeleteModal);

  document.getElementById('delete-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('delete-modal')) closeDeleteModal();
  });

  // ── Multi-tab modal ────────────────────────────────────────────
  document.getElementById('close-tab-btn').addEventListener('click', () => {
    window.close();
    // If window.close() is blocked (tab was opened directly, not via script):
    document.body.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;
                  min-height:100vh;font-family:sans-serif;text-align:center;padding:24px;">
        <div>
          <p style="font-size:1.4rem;margin-bottom:12px;">⚠️</p>
          <h2>Please close this tab manually.</h2>
          <p style="color:#6b7280;margin-top:8px;">
            The app is already running in another tab.
          </p>
        </div>
      </div>`;
  });

  // ── Initial render ─────────────────────────────────────────────
  render();
});
