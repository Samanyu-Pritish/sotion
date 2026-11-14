/**
 * ============================================================================
 * Sotion — Pure HTML, CSS & Vanilla JavaScript with SQLite 3 (sql.js / WASM)
 * Master Password: "remove"
 * Zero localStorage — 100% SQLite persistence via IndexedDB binary store
 * ============================================================================
 */

// Global State
let SQL = null;
let db = null;
let isUnlocked = false;
let currentView = 'dashboard'; // 'dashboard' | 'collection' | 'editor'
let currentCollectionId = null;
let currentPageId = null;
let currentViewMode = 'grid'; // 'grid' | 'list'
let editorSaveTimeout = null;
let activePopoverPageId = null;
let modalTargetData = null; // Used for modals (e.g., delete confirmation, badge edit)
let stagedCollectionBadges = []; // Staged collection-level badges in Collection Modal
let editingCollectionBadgeId = null;

// IndexedDB Binary Store Constants
const IDB_NAME = 'sotion_sqlite_database';
const IDB_STORE = 'sqlite_storage';
const IDB_KEY = 'sotion_binary_file';

/* ==========================================================================
   1. STARTUP PASSWORD SYSTEM ("remove")
   ========================================================================== */

function handlePasswordSubmit(event) {
  event.preventDefault();
  const passwordInput = document.getElementById('password-input');
  const errorMsg = document.getElementById('password-error');
  const enteredPassword = passwordInput.value.trim();

  if (enteredPassword === 'remove') {
    isUnlocked = true;
    errorMsg.classList.add('hidden');
    passwordInput.classList.remove('input-error');

    // Hide lock screen and reveal application
    document.getElementById('lock-screen').classList.add('hidden');
    document.getElementById('app-shell').classList.remove('hidden');

    // Initialize SQLite & Application if not yet ready
    if (!db) {
      initApp();
    }
  } else {
    errorMsg.classList.remove('hidden');
    passwordInput.classList.add('input-error');
    passwordInput.value = '';
    passwordInput.focus();
    setTimeout(() => {
      passwordInput.classList.remove('input-error');
    }, 500);
  }
}

function lockWorkspace() {
  isUnlocked = false;
  const passwordInput = document.getElementById('password-input');
  passwordInput.value = '';
  document.getElementById('password-error').classList.add('hidden');
  document.getElementById('app-shell').classList.add('hidden');
  document.getElementById('lock-screen').classList.remove('hidden');
  passwordInput.focus();
  showToast('Workspace locked');
}

/* ==========================================================================
   2. SQLITE 3 & INDEXEDDB PERSISTENCE ENGINE (NO LOCALSTORAGE)
   ========================================================================== */

function openIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = (e) => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains(IDB_STORE)) {
        idb.createObjectStore(IDB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadDbFromIndexedDB() {
  try {
    const idb = await openIndexedDB();
    return new Promise((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(IDB_KEY);
      req.onsuccess = () => resolve(req.result || null); // Uint8Array or null
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.error('Failed to read SQLite from IndexedDB:', err);
    return null;
  }
}

async function saveDbToIndexedDB(binaryArray) {
  try {
    const idb = await openIndexedDB();
    return new Promise((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      store.put(binaryArray, IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.error('Failed to save SQLite to IndexedDB:', err);
  }
}

async function persistDatabase() {
  if (!db) return;
  try {
    const binary = db.export(); // pure SQLite Uint8Array
    await saveDbToIndexedDB(binary);
  } catch (err) {
    console.error('Error exporting SQLite database:', err);
  }
}

// SQL Query Helpers
function queryAll(sql, params = []) {
  if (!db) return [];
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  } catch (err) {
    console.error('SQL queryAll Error:', sql, err);
    return [];
  }
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function execute(sql, params = []) {
  if (!db) return;
  try {
    db.run(sql, params);
    persistDatabase();
  } catch (err) {
    console.error('SQL execute Error:', sql, err);
  }
}

function generateId() {
  return 'id_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
}

/* ==========================================================================
   3. INITIALIZATION & SCHEMA CREATION
   ========================================================================== */

async function initApp() {
  try {
    showToast('Initializing SQLite 3 Engine...');
    // Initialize WebAssembly SQL
    SQL = await initSqlJs({
      locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.12.0/${file}`
    });

    // Check for existing SQLite binary in IndexedDB
    const savedBinary = await loadDbFromIndexedDB();
    if (savedBinary) {
      db = new SQL.Database(savedBinary);
      console.log('Loaded existing SQLite database from IndexedDB.');
      runMigrations();
    } else {
      db = new SQL.Database();
      console.log('Created fresh SQLite database.');
      createSchema();
      seedStarterData();
      await persistDatabase();
    }

    // Apply saved theme from SQLite settings
    loadThemeFromDatabase();

    // Setup UI event listeners
    setupEventListeners();

    // Render workspace
    navigateToDashboard();
    renderSidebar();

    showToast('Welcome to Sotion');
  } catch (err) {
    console.error('Initialization error:', err);
    alert('Failed to initialize SQLite3 engine: ' + err.message);
  }
}

function createSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      icon TEXT DEFAULT 'folder',
      color TEXT DEFAULT '#6366f1',
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'Untitled Page',
      date TEXT DEFAULT NULL,
      icon TEXT DEFAULT 'file-text',
      color TEXT DEFAULT '#64748b',
      content_html TEXT DEFAULT '',
      content_text TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS badges (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#3b82f6',
      is_completed INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      collection_badge_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS collection_badges (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#3b82f6',
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

function runMigrations() {
  if (!db) return;
  db.run(`
    CREATE TABLE IF NOT EXISTS collection_badges (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#3b82f6',
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  try {
    const cols = queryAll(`PRAGMA table_info(badges)`);
    if (!cols.some(c => c.name === 'collection_badge_id')) {
      db.run(`ALTER TABLE badges ADD COLUMN collection_badge_id TEXT`);
    }
  } catch (err) {
    console.warn('Migration warning:', err);
  }
}

function seedStarterData() {
  const col1Id = generateId();
  const col2Id = generateId();

  // Collection 1: Getting Started
  db.run(`INSERT INTO collections (id, name, description, icon, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)`, [
    col1Id,
    'Getting Started',
    'Welcome guide and interactive overview of Sotion features.',
    'compass',
    '#6366f1',
    1
  ]);

  // Collection 1 Badges (Applies to all pages in this collection)
  const cb1 = generateId();
  const cb2 = generateId();
  const cb3 = generateId();
  db.run(`INSERT INTO collection_badges (id, collection_id, label, color, sort_order) VALUES (?, ?, ?, ?, ?)`, [cb1, col1Id, 'Pure HTML/JS', '#6366f1', 1]);
  db.run(`INSERT INTO collection_badges (id, collection_id, label, color, sort_order) VALUES (?, ?, ?, ?, ?)`, [cb2, col1Id, 'SQLite 3', '#10b981', 2]);
  db.run(`INSERT INTO collection_badges (id, collection_id, label, color, sort_order) VALUES (?, ?, ?, ?, ?)`, [cb3, col1Id, 'Getting Started', '#f59e0b', 3]);

  // Page 1: Welcome Page
  const page1Id = generateId();
  const page1Content = `
    <h2>Welcome to your Pure HTML+CSS+JS Workspace!</h2>
    <p>This is <strong>Sotion</strong>, running 100% on standard web technologies with a <strong>genuine SQLite 3 WebAssembly engine</strong>.</p>
    <div class="checklist-item"><input type="checkbox" checked><span>Master Password ("remove") configured</span></div>
    <div class="checklist-item"><input type="checkbox" checked><span>No localstorage used — all data in pure SQLite3</span></div>
    <div class="checklist-item"><input type="checkbox"><span>Try clicking any task badge below to toggle completion</span></div>
    <div class="checklist-item"><input type="checkbox"><span>Export your genuine .db file anytime in DB Manager</span></div>
    <blockquote>"Simplicity is the ultimate sophistication." — Leonardo da Vinci</blockquote>
  `;
  const page1Text = "Welcome to your Pure HTML+CSS+JS Workspace! This is Sotion, running 100% on standard web technologies with a genuine SQLite 3 engine.";

  const todayStr = new Date().toISOString().split('T')[0];

  db.run(`INSERT INTO pages (id, collection_id, title, date, content_html, content_text, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
    page1Id,
    col1Id,
    'Welcome to Sotion',
    todayStr,
    page1Content,
    page1Text,
    1
  ]);

  // Badges for Page 1 linked to collection badges
  db.run(`INSERT INTO badges (id, page_id, label, color, is_completed, sort_order, collection_badge_id) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
    generateId(), page1Id, 'Pure HTML/JS', '#6366f1', 1, 1, cb1
  ]);
  db.run(`INSERT INTO badges (id, page_id, label, color, is_completed, sort_order, collection_badge_id) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
    generateId(), page1Id, 'SQLite 3', '#10b981', 1, 2, cb2
  ]);
  db.run(`INSERT INTO badges (id, page_id, label, color, is_completed, sort_order, collection_badge_id) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
    generateId(), page1Id, 'Getting Started', '#f59e0b', 0, 3, cb3
  ]);

  // Collection 2: Work & Projects
  db.run(`INSERT INTO collections (id, name, description, icon, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)`, [
    col2Id,
    'Work & Projects',
    'Active projects, meeting notes, and roadmap.',
    'target',
    '#10b981',
    2
  ]);

  const cb4 = generateId();
  const cb5 = generateId();
  db.run(`INSERT INTO collection_badges (id, collection_id, label, color, sort_order) VALUES (?, ?, ?, ?, ?)`, [cb4, col2Id, 'Planning', '#3b82f6', 1]);
  db.run(`INSERT INTO collection_badges (id, collection_id, label, color, sort_order) VALUES (?, ?, ?, ?, ?)`, [cb5, col2Id, 'In Progress', '#f59e0b', 2]);

  const page2Id = generateId();
  db.run(`INSERT INTO pages (id, collection_id, title, date, content_html, content_text, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
    page2Id,
    col2Id,
    'Q4 Project Roadmap',
    todayStr,
    '<h2>Q4 Goals</h2><p>Document objectives, deliverables, and badge metrics.</p>',
    'Q4 Goals: Document objectives, deliverables, and badge metrics.',
    1
  ]);

  db.run(`INSERT INTO badges (id, page_id, label, color, is_completed, sort_order, collection_badge_id) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
    generateId(), page2Id, 'Planning', '#3b82f6', 1, 1, cb4
  ]);
  db.run(`INSERT INTO badges (id, page_id, label, color, is_completed, sort_order, collection_badge_id) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
    generateId(), page2Id, 'In Progress', '#f59e0b', 0, 2, cb5
  ]);

  // Default theme setting in SQLite
  db.run(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('theme', 'dark')`);
}

/* ==========================================================================
   4. THEME SYSTEM (PERSISTED IN SQLITE APP_SETTINGS)
   ========================================================================== */

function loadThemeFromDatabase() {
  const row = queryOne(`SELECT value FROM app_settings WHERE key = 'theme'`);
  const theme = row ? row.value : 'dark';
  applyTheme(theme);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) {
    btn.innerHTML = theme === 'dark' 
      ? '<i data-lucide="moon" class="icon-sm"></i>' 
      : '<i data-lucide="sun" class="icon-sm"></i>';
    lucide.createIcons();
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  execute(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('theme', ?)`, [next]);
  showToast(`Switched to ${next} mode`);
}

/* ==========================================================================
   5. NAVIGATION & VIEW ROUTING
   ========================================================================== */

function hideAllViews() {
  document.getElementById('view-dashboard').classList.add('hidden');
  document.getElementById('view-collection').classList.add('hidden');
  document.getElementById('view-editor').classList.add('hidden');
}

function navigateToDashboard() {
  currentView = 'dashboard';
  currentCollectionId = null;
  currentPageId = null;
  hideAllViews();
  document.getElementById('view-dashboard').classList.remove('hidden');

  // Update active sidebar nav
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById('nav-dashboard').classList.add('active');

  renderDashboard();
  renderSidebar();
  closeSidebarOnMobile();
}

function navigateToCollection(collectionId) {
  currentView = 'collection';
  currentCollectionId = collectionId;
  currentPageId = null;
  hideAllViews();
  document.getElementById('view-collection').classList.remove('hidden');

  // Update active sidebar nav
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const navItem = document.getElementById(`nav-col-${collectionId}`);
  if (navItem) navItem.classList.add('active');

  renderCollectionDetail();
  closeSidebarOnMobile();
}

function navigateToEditor(pageId) {
  currentView = 'editor';
  currentPageId = pageId;
  hideAllViews();
  document.getElementById('view-editor').classList.remove('hidden');

  renderEditor(pageId);
  closeSidebarOnMobile();
}

function navigateBackFromEditor() {
  if (currentCollectionId) {
    navigateToCollection(currentCollectionId);
  } else {
    navigateToDashboard();
  }
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  sidebar.classList.toggle('open');
  backdrop.classList.toggle('hidden');
}

function closeSidebarOnMobile() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (sidebar) sidebar.classList.remove('open');
  if (backdrop) backdrop.classList.add('hidden');
}

/* ==========================================================================
   6. RENDERERS: SIDEBAR & DASHBOARD
   ========================================================================== */

function renderSidebar() {
  const collections = queryAll(`SELECT * FROM collections ORDER BY sort_order ASC, created_at ASC`);
  const listEl = document.getElementById('sidebar-collections');
  if (!listEl) return;

  listEl.innerHTML = '';

  collections.forEach(col => {
    const pageCountRow = queryOne(`SELECT COUNT(*) as count FROM pages WHERE collection_id = ?`, [col.id]);
    const pageCount = pageCountRow ? pageCountRow.count : 0;
    const isActive = (currentView === 'collection' && currentCollectionId === col.id);

    const a = document.createElement('a');
    a.className = `nav-item ${isActive ? 'active' : ''}`;
    a.id = `nav-col-${col.id}`;
    a.onclick = () => navigateToCollection(col.id);

    a.innerHTML = `
      <span class="collection-color-dot" style="background: ${col.color || '#6366f1'};"></span>
      <span class="nav-label">${escapeHtml(col.name)}</span>
      <span class="nav-badge">${pageCount}</span>
    `;

    listEl.appendChild(a);
  });

  // Calculate and display sidebar metric
  const badgeStats = queryOne(`SELECT COUNT(*) as total, SUM(is_completed) as completed FROM badges`);
  const total = badgeStats ? badgeStats.total : 0;
  const completed = badgeStats && badgeStats.completed ? badgeStats.completed : 0;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const badgeMetric = document.getElementById('sidebar-badge-metric');
  if (badgeMetric) badgeMetric.textContent = `${pct}%`;

  lucide.createIcons();
}

function renderDashboard() {
  // Update Greeting Date
  const dateGreeting = document.getElementById('dashboard-date-greeting');
  if (dateGreeting) {
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
    dateGreeting.textContent = `Today is ${today} — Here is your productivity summary.`;
  }

  // Calculate metrics via SQLite
  const colCount = queryOne(`SELECT COUNT(*) as count FROM collections`).count;
  const pageCount = queryOne(`SELECT COUNT(*) as count FROM pages`).count;
  const badgeStats = queryOne(`SELECT COUNT(*) as total, SUM(is_completed) as completed FROM badges`);
  const totalBadges = badgeStats ? badgeStats.total : 0;
  const completedBadges = badgeStats && badgeStats.completed ? badgeStats.completed : 0;
  const pendingBadges = totalBadges - completedBadges;
  const completionPct = totalBadges > 0 ? Math.round((completedBadges / totalBadges) * 100) : 0;

  document.getElementById('stat-collections-count').textContent = colCount;
  document.getElementById('stat-pages-count').textContent = pageCount;
  document.getElementById('stat-completion-pct').textContent = `${completionPct}%`;
  document.getElementById('stat-progress-bar').style.width = `${completionPct}%`;
  document.getElementById('stat-pending-badges').textContent = pendingBadges;

  // Render Recent Pages
  const recentPages = queryAll(`
    SELECT p.*, c.name as collection_name, c.color as collection_color
    FROM pages p
    JOIN collections c ON p.collection_id = c.id
    ORDER BY p.updated_at DESC
    LIMIT 6
  `);

  const recentPagesContainer = document.getElementById('dashboard-recent-pages');
  if (recentPages.length === 0) {
    recentPagesContainer.innerHTML = `
      <div class="search-empty-state" style="grid-column: 1 / -1;">
        <p>No pages created yet.</p>
        <button class="btn btn-secondary btn-sm" style="margin-top: 0.5rem;" onclick="openCollectionModal('create')">
          Create your first Collection & Page
        </button>
      </div>
    `;
  } else {
    recentPagesContainer.innerHTML = '';
    recentPages.forEach(page => {
      recentPagesContainer.appendChild(createPageCardElement(page, true));
    });
  }

  // Render All Collections Grid
  const collections = queryAll(`SELECT * FROM collections ORDER BY sort_order ASC, created_at ASC`);
  const collectionsGrid = document.getElementById('dashboard-collections-grid');
  collectionsGrid.innerHTML = '';

  collections.forEach(col => {
    const pageCountRow = queryOne(`SELECT COUNT(*) as count FROM pages WHERE collection_id = ?`, [col.id]);
    const count = pageCountRow ? pageCountRow.count : 0;

    const card = document.createElement('div');
    card.className = 'collection-card';
    card.onclick = () => navigateToCollection(col.id);

    card.innerHTML = `
      <div class="collection-card-top-stripe" style="background: ${col.color || '#6366f1'};"></div>
      <div class="col-card-header">
        <div class="col-card-icon" style="background: ${col.color || '#6366f1'}; color: #fff;">
          <i data-lucide="${escapeHtml(col.icon || 'folder')}"></i>
        </div>
        <h3 class="col-card-title">${escapeHtml(col.name)}</h3>
      </div>
      <p class="col-card-desc">${escapeHtml(col.description || 'No description provided.')}</p>
      <div class="col-card-footer">
        <span>${count} ${count === 1 ? 'page' : 'pages'}</span>
        <span>Open Collection →</span>
      </div>
    `;

    collectionsGrid.appendChild(card);
  });

  lucide.createIcons();
}

/* ==========================================================================
   7. RENDERERS: COLLECTION DETAIL & PAGE CARDS
   ========================================================================== */

function renderCollectionDetail() {
  if (!currentCollectionId) return;

  const col = queryOne(`SELECT * FROM collections WHERE id = ?`, [currentCollectionId]);
  if (!col) {
    navigateToDashboard();
    return;
  }

  // Update banner identity
  document.getElementById('col-detail-name').textContent = col.name;
  document.getElementById('col-detail-desc').textContent = col.description || 'No description provided.';
  const iconBox = document.getElementById('col-detail-icon-box');
  iconBox.style.background = col.color || '#6366f1';
  iconBox.innerHTML = `<i data-lucide="${escapeHtml(col.icon || 'folder')}"></i>`;

  renderCollectionPages();
  lucide.createIcons();
}

function renderCollectionPages() {
  if (!currentCollectionId) return;

  const searchVal = (document.getElementById('collection-page-search')?.value || '').toLowerCase().trim();
  const filterVal = document.getElementById('filter-status-select')?.value || 'all';
  const sortVal = document.getElementById('sort-pages-select')?.value || 'date_desc';

  // Build query
  let sql = `SELECT * FROM pages WHERE collection_id = ?`;
  const params = [currentCollectionId];

  // Apply search query
  if (searchVal) {
    sql += ` AND (LOWER(title) LIKE ? OR LOWER(content_text) LIKE ?)`;
    params.push(`%${searchVal}%`, `%${searchVal}%`);
  }

  // Apply sorting
  if (sortVal === 'date_desc') {
    sql += ` ORDER BY CASE WHEN date IS NULL THEN 1 ELSE 0 END, date DESC, updated_at DESC`;
  } else if (sortVal === 'date_asc') {
    sql += ` ORDER BY CASE WHEN date IS NULL THEN 1 ELSE 0 END, date ASC, updated_at DESC`;
  } else if (sortVal === 'title_asc') {
    sql += ` ORDER BY title COLLATE NOCASE ASC`;
  } else if (sortVal === 'title_desc') {
    sql += ` ORDER BY title COLLATE NOCASE DESC`;
  } else {
    sql += ` ORDER BY updated_at DESC`;
  }

  let pages = queryAll(sql, params);

  // Apply post-query filters
  if (filterVal === 'has_date') {
    pages = pages.filter(p => !!p.date);
  } else if (filterVal === 'pending') {
    pages = pages.filter(p => {
      const pendingCount = queryOne(`SELECT COUNT(*) as c FROM badges WHERE page_id = ? AND is_completed = 0`, [p.id]).c;
      return pendingCount > 0;
    });
  } else if (filterVal === 'completed') {
    pages = pages.filter(p => {
      const totalBadges = queryOne(`SELECT COUNT(*) as c FROM badges WHERE page_id = ?`, [p.id]).c;
      const completedBadges = queryOne(`SELECT COUNT(*) as c FROM badges WHERE page_id = ? AND is_completed = 1`, [p.id]).c;
      return totalBadges > 0 && totalBadges === completedBadges;
    });
  }

  const container = document.getElementById('collection-pages-container');
  container.className = `pages-grid ${currentViewMode === 'list' ? 'list-view' : ''}`;
  container.innerHTML = '';

  if (pages.length === 0) {
    container.innerHTML = `
      <div class="search-empty-state" style="grid-column: 1 / -1;">
        <p>No pages match the current filter.</p>
        <button class="btn btn-primary btn-sm" style="margin-top: 0.5rem;" onclick="createNewPageInCurrentCollection()">
          + Create New Page
        </button>
      </div>
    `;
    return;
  }

  pages.forEach(page => {
    container.appendChild(createPageCardElement(page, false));
  });

  lucide.createIcons();
}

function createPageCardElement(page, showCollectionBadge = false) {
  const card = document.createElement('div');
  card.className = 'page-card';

  // Badges query
  const badges = queryAll(`SELECT * FROM badges WHERE page_id = ? ORDER BY sort_order ASC, created_at ASC`, [page.id]);

  // Date parsing & styling
  const dateInfo = formatRelativeDate(page.date);

  // Excerpt
  const excerpt = page.content_text ? escapeHtml(page.content_text) : 'Empty page. Click to write notes...';

  card.innerHTML = `
    <div class="page-card-header">
      <div style="flex: 1; min-width: 0;">
        ${showCollectionBadge && page.collection_name ? `
          <div style="font-size: 0.725rem; font-weight: 600; color: ${page.collection_color || '#818cf8'}; margin-bottom: 0.25rem;">
            ${escapeHtml(page.collection_name)}
          </div>
        ` : ''}
        <h3 class="page-card-title">${escapeHtml(page.title || 'Untitled Page')}</h3>
      </div>
      <button class="icon-btn-danger" style="margin-top: -0.25rem;" onclick="event.stopPropagation(); confirmDeletePage('${page.id}')" title="Delete">
        <i data-lucide="trash-2" class="icon-xs"></i>
      </button>
    </div>

    <p class="page-card-excerpt">${excerpt}</p>

    <div class="page-card-meta">
      <!-- Date Pill -->
      <button 
        type="button" 
        class="date-pill ${dateInfo.className}" 
        onclick="event.stopPropagation(); openDatePopover(event, '${page.id}')"
        title="Click to edit date"
      >
        <i data-lucide="calendar" class="icon-xs"></i>
        <span>${dateInfo.text}</span>
      </button>

      <!-- Task Badges Tray -->
      <div class="badges-tray">
        ${badges.map(b => createBadgeHtml(b)).join('')}
        <button 
          type="button" 
          class="btn-add-badge-inline" 
          onclick="event.stopPropagation(); openBadgeModal('create', '${page.id}')"
          title="Add Badge"
        >
          <i data-lucide="plus" class="icon-xs"></i>
          <span>Badge</span>
        </button>
      </div>
    </div>
  `;

  // Clicking card opens editor
  card.onclick = () => navigateToEditor(page.id);

  return card;
}

function createBadgeHtml(badge) {
  const isDone = badge.is_completed === 1;
  const color = badge.color || '#3b82f6';

  if (isDone) {
    return `
      <span 
        class="badge-pill completed" 
        style="background: ${color};" 
        onclick="event.stopPropagation(); toggleBadgeCompletion('${badge.id}')"
        title="Completed (Click to toggle)"
      >
        <i data-lucide="check" class="badge-check"></i>
        <span>${escapeHtml(badge.label)}</span>
      </span>
    `;
  } else {
    return `
      <span 
        class="badge-pill incomplete" 
        style="color: ${color}; border-color: ${color};" 
        onclick="event.stopPropagation(); toggleBadgeCompletion('${badge.id}')"
        title="Pending (Click to mark complete)"
      >
        <span class="badge-dot" style="background: ${color};"></span>
        <span>${escapeHtml(badge.label)}</span>
      </span>
    `;
  }
}

function handleCollectionPageFilter() {
  renderCollectionPages();
}

function setViewMode(mode) {
  currentViewMode = mode;
  document.getElementById('btn-view-grid').classList.toggle('active', mode === 'grid');
  document.getElementById('btn-view-list').classList.toggle('active', mode === 'list');
  renderCollectionPages();
}

/* ==========================================================================
   8. TASK BADGE INTERACTIONS (1-CLICK TOGGLE & PERSISTENCE)
   ========================================================================== */

function toggleBadgeCompletion(badgeId) {
  const badge = queryOne(`SELECT * FROM badges WHERE id = ?`, [badgeId]);
  if (!badge) return;

  const nextState = badge.is_completed === 1 ? 0 : 1;
  execute(`UPDATE badges SET is_completed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [nextState, badgeId]);

  // Re-render active view
  if (currentView === 'editor' && currentPageId) {
    renderEditorBadges(currentPageId);
  } else if (currentView === 'collection') {
    renderCollectionPages();
  } else if (currentView === 'dashboard') {
    renderDashboard();
  }
  renderSidebar();

  showToast(nextState === 1 ? `Completed: "${badge.label}"` : `Pending: "${badge.label}"`);
}

function deleteBadge(badgeId) {
  execute(`DELETE FROM badges WHERE id = ?`, [badgeId]);
  if (currentView === 'editor' && currentPageId) {
    renderEditorBadges(currentPageId);
  } else if (currentView === 'collection') {
    renderCollectionPages();
  } else {
    renderDashboard();
  }
  renderSidebar();
  showToast('Badge removed');
}

/* ==========================================================================
   9. RENDERERS: DISTRACTION-FREE PAGE EDITOR
   ========================================================================== */

function renderEditor(pageId) {
  const page = queryOne(`SELECT * FROM pages WHERE id = ?`, [pageId]);
  if (!page) {
    navigateToDashboard();
    return;
  }

  currentCollectionId = page.collection_id;
  const col = queryOne(`SELECT * FROM collections WHERE id = ?`, [page.collection_id]);

  // Breadcrumbs
  document.getElementById('editor-crumb-collection').textContent = col ? col.name : 'Collection';
  document.getElementById('editor-crumb-title').textContent = page.title || 'Untitled Page';

  // Title input
  const titleInput = document.getElementById('editor-page-title');
  titleInput.value = page.title || '';

  // Date
  updateEditorDateDisplay(page.date);

  // Badges
  renderEditorBadges(pageId);

  // Content Canvas
  const canvas = document.getElementById('editor-content');
  canvas.innerHTML = page.content_html || '';

  // Setup checklist click listener inside editor canvas
  setupEditorChecklistListeners(canvas);

  // Auto-save status
  setAutosaveStatus('saved');
  lucide.createIcons();
}

function updateEditorDateDisplay(dateStr) {
  const dateText = document.getElementById('editor-date-text');
  if (!dateText) return;
  const dateInfo = formatRelativeDate(dateStr);
  dateText.textContent = dateInfo.text;
}

function renderEditorBadges(pageId) {
  const badges = queryAll(`SELECT * FROM badges WHERE page_id = ? ORDER BY sort_order ASC, created_at ASC`, [pageId]);
  const tray = document.getElementById('editor-badges-list');
  if (!tray) return;

  tray.innerHTML = '';
  badges.forEach(b => {
    const isDone = b.is_completed === 1;
    const color = b.color || '#3b82f6';
    const pill = document.createElement('span');
    pill.className = `badge-pill ${isDone ? 'completed' : 'incomplete'}`;
    if (isDone) {
      pill.style.background = color;
    } else {
      pill.style.color = color;
      pill.style.borderColor = color;
    }

    pill.innerHTML = `
      ${isDone ? '<i data-lucide="check" class="badge-check"></i>' : `<span class="badge-dot" style="background: ${color};"></span>`}
      <span>${escapeHtml(b.label)}</span>
      <span style="margin-left: 4px; opacity: 0.6; font-size: 11px;" title="Delete badge">✕</span>
    `;

    pill.onclick = (e) => {
      // If clicked the '✕', delete
      if (e.target.textContent === '✕') {
        e.stopPropagation();
        deleteBadge(b.id);
      } else {
        toggleBadgeCompletion(b.id);
      }
    };

    tray.appendChild(pill);
  });

  lucide.createIcons();
}

function handlePageTitleInput(value) {
  if (!currentPageId) return;
  document.getElementById('editor-crumb-title').textContent = value || 'Untitled Page';
  triggerAutosave();
}

function handleEditorContentInput() {
  triggerAutosave();
}

function triggerAutosave() {
  setAutosaveStatus('saving');
  clearTimeout(editorSaveTimeout);

  editorSaveTimeout = setTimeout(() => {
    saveCurrentPage();
  }, 400);
}

function saveCurrentPage() {
  if (!currentPageId || !db) return;

  const title = document.getElementById('editor-page-title').value.trim() || 'Untitled Page';
  const canvas = document.getElementById('editor-content');
  const contentHtml = canvas.innerHTML;
  const contentText = canvas.innerText.trim();

  execute(
    `UPDATE pages SET title = ?, content_html = ?, content_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [title, contentHtml, contentText, currentPageId]
  );

  setAutosaveStatus('saved');
  renderSidebar();
}

function setAutosaveStatus(status) {
  const statusEl = document.getElementById('editor-save-status');
  if (!statusEl) return;

  if (status === 'saving') {
    statusEl.className = 'autosave-status saving';
    statusEl.innerHTML = '<span class="status-dot"></span><span class="status-text">Saving to SQLite...</span>';
  } else {
    statusEl.className = 'autosave-status';
    statusEl.innerHTML = '<span class="status-dot"></span><span class="status-text">Saved to SQLite</span>';
  }
}

function setupEditorChecklistListeners(canvas) {
  canvas.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
    checkbox.onchange = () => {
      if (checkbox.checked) {
        checkbox.setAttribute('checked', 'checked');
      } else {
        checkbox.removeAttribute('checked');
      }
      triggerAutosave();
    };
  });
}

function insertChecklist() {
  const canvas = document.getElementById('editor-content');
  canvas.focus();
  const html = '<div class="checklist-item"><input type="checkbox"><span>New Task</span></div><p></p>';
  document.execCommand('insertHTML', false, html);
  setupEditorChecklistListeners(canvas);
  triggerAutosave();
}

function exportCurrentPageMarkdown() {
  if (!currentPageId) return;
  const page = queryOne(`SELECT * FROM pages WHERE id = ?`, [currentPageId]);
  if (!page) return;

  const badges = queryAll(`SELECT * FROM badges WHERE page_id = ?`, [page.id]);
  const badgeStr = badges.map(b => `[${b.is_completed ? 'x' : ' '}] ${b.label}`).join(', ');

  let md = `# ${page.title}\n\n`;
  if (page.date) md += `**Date:** ${page.date}\n\n`;
  if (badgeStr) md += `**Badges:** ${badgeStr}\n\n`;
  md += `---\n\n`;
  md += `${page.content_text || ''}\n`;

  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(page.title || 'untitled').replace(/[^a-z0-9]/gi, '_').toLowerCase()}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('Exported Markdown file');
}

/* ==========================================================================
   10. DATE POPOVER SYSTEM
   ========================================================================== */

function openDatePopover(event, pageId) {
  event.stopPropagation();
  activePopoverPageId = pageId;

  const popover = document.getElementById('date-popover');
  const triggerBtn = event.currentTarget;
  const rect = triggerBtn.getBoundingClientRect();

  // Position popover below trigger
  popover.style.top = `${rect.bottom + window.scrollY + 6}px`;
  popover.style.left = `${Math.min(rect.left, window.innerWidth - 230)}px`;

  // Pre-fill input with existing page date
  const page = queryOne(`SELECT date FROM pages WHERE id = ?`, [pageId]);
  const dateInput = document.getElementById('popover-date-input');
  dateInput.value = page && page.date ? page.date : '';

  popover.classList.remove('hidden');

  // Global dismiss listener
  setTimeout(() => {
    window.addEventListener('click', closeDatePopoverOnClickOutside);
  }, 10);
}

function closeDatePopover() {
  const popover = document.getElementById('date-popover');
  popover.classList.add('hidden');
  window.removeEventListener('click', closeDatePopoverOnClickOutside);
  activePopoverPageId = null;
}

function closeDatePopoverOnClickOutside(e) {
  const popover = document.getElementById('date-popover');
  if (!popover.contains(e.target)) {
    closeDatePopover();
  }
}

function applyDatePreset(preset) {
  if (!activePopoverPageId) return;

  let dateStr = null;
  const now = new Date();

  if (preset === 'today') {
    dateStr = now.toISOString().split('T')[0];
  } else if (preset === 'tomorrow') {
    now.setDate(now.getDate() + 1);
    dateStr = now.toISOString().split('T')[0];
  } else if (preset === 'next_week') {
    now.setDate(now.getDate() + 7);
    dateStr = now.toISOString().split('T')[0];
  } else if (preset === 'clear') {
    dateStr = null;
  }

  savePageDate(activePopoverPageId, dateStr);
  closeDatePopover();
}

function applyCustomDate(dateVal) {
  if (!activePopoverPageId) return;
  savePageDate(activePopoverPageId, dateVal || null);
  closeDatePopover();
}

function savePageDate(pageId, dateStr) {
  execute(`UPDATE pages SET date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [dateStr, pageId]);

  if (currentView === 'editor' && currentPageId === pageId) {
    updateEditorDateDisplay(dateStr);
  } else if (currentView === 'collection') {
    renderCollectionPages();
  } else {
    renderDashboard();
  }
  showToast(dateStr ? `Date updated to ${dateStr}` : 'Date cleared');
}

function formatRelativeDate(dateStr) {
  if (!dateStr) {
    return { text: 'No Date', className: '' };
  }

  try {
    const target = new Date(dateStr + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const diffMs = target - today;
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return { text: 'Today', className: 'today' };
    if (diffDays === 1) return { text: 'Tomorrow', className: '' };
    if (diffDays === -1) return { text: 'Yesterday', className: 'overdue' };
    if (diffDays < -1) return { text: `${Math.abs(diffDays)}d overdue`, className: 'overdue' };
    if (diffDays <= 7) return { text: `In ${diffDays} days`, className: '' };

    return { 
      text: target.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), 
      className: '' 
    };
  } catch (e) {
    return { text: dateStr, className: '' };
  }
}

/* ==========================================================================
   11. CREATION & DELETION HANDLERS
   ========================================================================== */

function createNewPageInCurrentCollection() {
  if (!currentCollectionId) return;

  const newId = generateId();
  const todayStr = new Date().toISOString().split('T')[0];

  execute(`INSERT INTO pages (id, collection_id, title, date, sort_order) VALUES (?, ?, ?, ?, ?)`, [
    newId,
    currentCollectionId,
    'Untitled Page',
    todayStr,
    Date.now()
  ]);

  // Inherit all collection-level badges for this collection!
  const colBadges = queryAll(`SELECT * FROM collection_badges WHERE collection_id = ? ORDER BY sort_order ASC, created_at ASC`, [currentCollectionId]);
  colBadges.forEach(cb => {
    execute(`INSERT INTO badges (id, page_id, label, color, is_completed, sort_order, collection_badge_id) VALUES (?, ?, ?, ?, 0, ?, ?)`, [
      generateId(), newId, cb.label, cb.color, cb.sort_order, cb.id
    ]);
  });

  renderSidebar();
  navigateToEditor(newId);
  showToast('Created new page');
}

function confirmDeleteCollection(collectionId) {
  const col = queryOne(`SELECT name FROM collections WHERE id = ?`, [collectionId]);
  if (!col) return;

  modalTargetData = { type: 'collection', id: collectionId };
  document.getElementById('delete-modal-title').textContent = 'Delete Collection';
  document.getElementById('delete-modal-desc').textContent = 
    `Are you sure you want to delete "${col.name}" and all of its pages? This action cannot be undone.`;

  document.getElementById('delete-confirm-btn').onclick = () => {
    execute(`DELETE FROM collections WHERE id = ?`, [collectionId]);
    closeModal('modal-delete');
    renderSidebar();
    navigateToDashboard();
    showToast(`Deleted collection "${col.name}"`);
  };

  openModal('modal-delete');
}

function confirmDeletePage(pageId) {
  const page = queryOne(`SELECT title FROM pages WHERE id = ?`, [pageId]);
  if (!page) return;

  modalTargetData = { type: 'page', id: pageId };
  document.getElementById('delete-modal-title').textContent = 'Delete Page';
  document.getElementById('delete-modal-desc').textContent = 
    `Are you sure you want to delete "${page.title}"? This action cannot be undone.`;

  document.getElementById('delete-confirm-btn').onclick = () => {
    execute(`DELETE FROM pages WHERE id = ?`, [pageId]);
    closeModal('modal-delete');
    renderSidebar();
    if (currentView === 'editor') {
      navigateBackFromEditor();
    } else if (currentView === 'collection') {
      renderCollectionPages();
    } else {
      renderDashboard();
    }
    showToast(`Deleted page "${page.title}"`);
  };

  openModal('modal-delete');
}

/* ==========================================================================
   12. COLLECTION & BADGE MODALS (WITH COLLECTION-LEVEL BADGES)
   ========================================================================== */

function switchCollectionModalTab(tab) {
  const detailsBtn = document.getElementById('col-tab-btn-details');
  const badgesBtn = document.getElementById('col-tab-btn-badges');
  const detailsForm = document.getElementById('col-details-form');
  const badgesPanel = document.getElementById('col-badges-panel');

  if (tab === 'details') {
    if (detailsBtn) detailsBtn.classList.add('active');
    if (badgesBtn) badgesBtn.classList.remove('active');
    if (detailsForm) detailsForm.classList.remove('hidden');
    if (badgesPanel) badgesPanel.classList.add('hidden');
  } else {
    if (detailsBtn) detailsBtn.classList.remove('active');
    if (badgesBtn) badgesBtn.classList.add('active');
    if (detailsForm) detailsForm.classList.add('hidden');
    if (badgesPanel) badgesPanel.classList.remove('hidden');
    cancelEditCollectionBadge();
    const labelInput = document.getElementById('col-badge-input-label');
    if (labelInput) labelInput.focus();
  }
}

function openCollectionModal(mode, collectionId = null) {
  const modal = document.getElementById('modal-collection');
  const titleEl = document.getElementById('col-modal-title');
  const submitBtn = document.getElementById('col-submit-btn');
  const nameInput = document.getElementById('col-input-name');
  const descInput = document.getElementById('col-input-desc');

  modalTargetData = { mode, collectionId };
  switchCollectionModalTab('details');
  cancelEditCollectionBadge();

  if (mode === 'edit' && collectionId) {
    const col = queryOne(`SELECT * FROM collections WHERE id = ?`, [collectionId]);
    titleEl.textContent = 'Edit Collection';
    submitBtn.textContent = 'Save Changes';
    nameInput.value = col.name;
    descInput.value = col.description || '';
    selectColorDot('col-color-picker', col.color || '#6366f1', 'col-selected-color');
    selectIconOption('col-icon-picker', col.icon || 'folder', 'col-selected-icon');

    // Load existing collection-level badges
    stagedCollectionBadges = queryAll(`SELECT * FROM collection_badges WHERE collection_id = ? ORDER BY sort_order ASC, created_at ASC`, [collectionId]);
  } else {
    titleEl.textContent = 'New Collection';
    submitBtn.textContent = 'Create Collection';
    nameInput.value = '';
    descInput.value = '';
    selectColorDot('col-color-picker', '#6366f1', 'col-selected-color');
    selectIconOption('col-icon-picker', 'folder', 'col-selected-icon');

    stagedCollectionBadges = [];
  }

  renderCollectionBadgesList();
  openModal('modal-collection');
  nameInput.focus();
}

function renderCollectionBadgesList() {
  const container = document.getElementById('col-badges-items-container');
  const counterBadge = document.getElementById('col-badges-count-badge');
  if (!container) return;

  if (counterBadge) {
    counterBadge.textContent = stagedCollectionBadges.length;
  }

  container.innerHTML = '';
  if (stagedCollectionBadges.length === 0) {
    container.innerHTML = `
      <div class="col-badge-empty">
        <span>No badges configured. Add a badge above to apply it to all pages.</span>
      </div>
    `;
    return;
  }

  stagedCollectionBadges.forEach(b => {
    const item = document.createElement('div');
    item.className = 'col-badge-item';

    item.innerHTML = `
      <div class="col-badge-item-left">
        <span class="badge-pill incomplete" style="color: ${b.color}; border-color: ${b.color}; pointer-events: none;">
          <span class="badge-dot" style="background: ${b.color};"></span>
          <span>${escapeHtml(b.label)}</span>
        </span>
        <span style="font-size: 0.775rem; color: var(--text-muted);">Shared on all pages</span>
      </div>
      <div class="col-badge-actions">
        <button type="button" class="icon-btn-ghost" onclick="startEditCollectionBadge('${b.id}')" title="Edit badge">
          <i data-lucide="pencil" class="icon-xs"></i>
        </button>
        <button type="button" class="icon-btn-danger" onclick="handleDeleteCollectionBadge('${b.id}')" title="Delete badge from all pages">
          <i data-lucide="trash-2" class="icon-xs"></i>
        </button>
      </div>
    `;
    container.appendChild(item);
  });

  lucide.createIcons();
}

function applyColBadgePreset(label, color) {
  const input = document.getElementById('col-badge-input-label');
  if (input) input.value = label;
  selectColorDot('col-badge-color-picker', color, 'col-badge-selected-color');
}

function handleSaveCollectionBadge() {
  const labelInput = document.getElementById('col-badge-input-label');
  const label = labelInput ? labelInput.value.trim() : '';
  const color = document.getElementById('col-badge-selected-color')?.value || '#3b82f6';

  if (!label) {
    if (labelInput) labelInput.focus();
    return;
  }

  if (editingCollectionBadgeId) {
    // 1. EDIT EXISTING BADGE
    const badgeIndex = stagedCollectionBadges.findIndex(b => b.id === editingCollectionBadgeId);
    if (badgeIndex !== -1) {
      stagedCollectionBadges[badgeIndex].label = label;
      stagedCollectionBadges[badgeIndex].color = color;
    }

    if (modalTargetData.mode === 'edit' && modalTargetData.collectionId) {
      // Update in collection_badges table
      execute(`UPDATE collection_badges SET label = ?, color = ? WHERE id = ?`, [label, color, editingCollectionBadgeId]);
      // Update across ALL pages in this collection!
      execute(`UPDATE badges SET label = ?, color = ?, updated_at = CURRENT_TIMESTAMP WHERE collection_badge_id = ?`, [label, color, editingCollectionBadgeId]);
      showToast(`Updated "${label}" across all pages in this collection`);
    } else {
      showToast(`Updated "${label}" in collection template`);
    }

    cancelEditCollectionBadge();
  } else {
    // 2. ADD NEW BADGE
    const newId = generateId();

    if (modalTargetData.mode === 'edit' && modalTargetData.collectionId) {
      // Insert in collection_badges table
      execute(`INSERT INTO collection_badges (id, collection_id, label, color, sort_order) VALUES (?, ?, ?, ?, ?)`, [
        newId, modalTargetData.collectionId, label, color, Date.now()
      ]);

      // Add to ALL existing pages in this collection!
      const pages = queryAll(`SELECT id FROM pages WHERE collection_id = ?`, [modalTargetData.collectionId]);
      pages.forEach(p => {
        execute(`INSERT INTO badges (id, page_id, label, color, is_completed, sort_order, collection_badge_id) VALUES (?, ?, ?, ?, 0, ?, ?)`, [
          generateId(), p.id, label, color, Date.now(), newId
        ]);
      });

      stagedCollectionBadges.push({ id: newId, label, color, collection_id: modalTargetData.collectionId });
      showToast(`Added "${label}" to all ${pages.length} pages in this collection!`);
    } else {
      // Staged for new collection being created
      stagedCollectionBadges.push({ id: newId, label, color, isNew: true });
      showToast(`Added "${label}" to collection template`);
    }

    if (labelInput) labelInput.value = '';
  }

  renderCollectionBadgesList();

  // Re-render active view if currently looking at this collection or a page in it
  if (currentView === 'collection' && modalTargetData.collectionId) {
    renderCollectionPages();
  } else if (currentView === 'editor' && currentPageId) {
    renderEditorBadges(currentPageId);
  }
}

function startEditCollectionBadge(badgeId) {
  const badge = stagedCollectionBadges.find(b => b.id === badgeId);
  if (!badge) return;

  editingCollectionBadgeId = badgeId;
  const labelInput = document.getElementById('col-badge-input-label');
  if (labelInput) labelInput.value = badge.label;
  selectColorDot('col-badge-color-picker', badge.color || '#3b82f6', 'col-badge-selected-color');

  const saveText = document.getElementById('col-badge-save-text');
  if (saveText) saveText.textContent = 'Update Badge';
  const formTitle = document.getElementById('col-badge-form-title');
  if (formTitle) formTitle.textContent = 'Edit Collection Badge';
  const cancelBtn = document.getElementById('col-badge-cancel-edit-btn');
  if (cancelBtn) cancelBtn.classList.remove('hidden');

  if (labelInput) labelInput.focus();
}

function cancelEditCollectionBadge() {
  editingCollectionBadgeId = null;
  const labelInput = document.getElementById('col-badge-input-label');
  if (labelInput) labelInput.value = '';
  selectColorDot('col-badge-color-picker', '#3b82f6', 'col-badge-selected-color');

  const saveText = document.getElementById('col-badge-save-text');
  if (saveText) saveText.textContent = 'Add Badge';
  const formTitle = document.getElementById('col-badge-form-title');
  if (formTitle) formTitle.textContent = 'Add Badge to All Pages';
  const cancelBtn = document.getElementById('col-badge-cancel-edit-btn');
  if (cancelBtn) cancelBtn.classList.add('hidden');
}

function handleDeleteCollectionBadge(badgeId) {
  const badge = stagedCollectionBadges.find(b => b.id === badgeId);
  if (!badge) return;

  if (modalTargetData.mode === 'edit' && modalTargetData.collectionId) {
    // Delete from all pages that have this collection badge!
    execute(`DELETE FROM badges WHERE collection_badge_id = ?`, [badgeId]);
    // Delete from collection_badges
    execute(`DELETE FROM collection_badges WHERE id = ?`, [badgeId]);
    showToast(`Removed "${badge.label}" from all pages in this collection`);
  } else {
    showToast(`Removed "${badge.label}" from template`);
  }

  stagedCollectionBadges = stagedCollectionBadges.filter(b => b.id !== badgeId);
  if (editingCollectionBadgeId === badgeId) {
    cancelEditCollectionBadge();
  }

  renderCollectionBadgesList();

  // Re-render active view
  if (currentView === 'collection' && modalTargetData.collectionId) {
    renderCollectionPages();
  } else if (currentView === 'editor' && currentPageId) {
    renderEditorBadges(currentPageId);
  }
}

function handleFinishCollectionModal() {
  if (modalTargetData.mode === 'create') {
    switchCollectionModalTab('details');
  } else {
    closeModal('modal-collection');
  }
}

function handleSaveCollection(event) {
  event.preventDefault();
  const name = document.getElementById('col-input-name').value.trim();
  const desc = document.getElementById('col-input-desc').value.trim();
  const color = document.getElementById('col-selected-color').value;
  const icon = document.getElementById('col-selected-icon').value;

  if (!name) return;

  if (modalTargetData.mode === 'edit' && modalTargetData.collectionId) {
    execute(`UPDATE collections SET name = ?, description = ?, color = ?, icon = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
      name, desc, color, icon, modalTargetData.collectionId
    ]);
    showToast(`Updated collection "${name}"`);
  } else {
    const newId = generateId();
    execute(`INSERT INTO collections (id, name, description, color, icon, sort_order) VALUES (?, ?, ?, ?, ?, ?)`, [
      newId, name, desc, color, icon, Date.now()
    ]);

    // Save all staged collection-level badges for this new collection
    stagedCollectionBadges.forEach((b, idx) => {
      execute(`INSERT INTO collection_badges (id, collection_id, label, color, sort_order) VALUES (?, ?, ?, ?, ?)`, [
        b.id, newId, b.label, b.color, idx + 1
      ]);
    });

    currentCollectionId = newId;
    showToast(`Created collection "${name}"`);
  }

  closeModal('modal-collection');
  renderSidebar();

  if (currentView === 'collection' && modalTargetData.collectionId) {
    renderCollectionDetail();
  } else if (modalTargetData.mode === 'create') {
    navigateToCollection(currentCollectionId);
  } else {
    renderDashboard();
  }
}

function openBadgeModal(mode, pageId) {
  modalTargetData = { mode, pageId };
  const labelInput = document.getElementById('badge-input-label');
  labelInput.value = '';
  document.getElementById('badge-input-completed').checked = false;
  selectColorDot('badge-color-picker', '#3b82f6', 'badge-selected-color');

  openModal('modal-badge');
  labelInput.focus();
}

function applyBadgePreset(label, color) {
  document.getElementById('badge-input-label').value = label;
  selectColorDot('badge-color-picker', color, 'badge-selected-color');
}

function handleSaveBadge(event) {
  event.preventDefault();
  const label = document.getElementById('badge-input-label').value.trim();
  const color = document.getElementById('badge-selected-color').value;
  const isCompleted = document.getElementById('badge-input-completed').checked ? 1 : 0;

  if (!label || !modalTargetData.pageId) return;

  const newBadgeId = generateId();
  execute(`INSERT INTO badges (id, page_id, label, color, is_completed, sort_order) VALUES (?, ?, ?, ?, ?, ?)`, [
    newBadgeId, modalTargetData.pageId, label, color, isCompleted, Date.now()
  ]);

  closeModal('modal-badge');

  if (currentView === 'editor' && currentPageId === modalTargetData.pageId) {
    renderEditorBadges(modalTargetData.pageId);
  } else if (currentView === 'collection') {
    renderCollectionPages();
  } else {
    renderDashboard();
  }
  renderSidebar();
  showToast(`Added badge "${label}"`);
}

function selectColorDot(containerId, color, hiddenInputId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.querySelectorAll('.color-dot').forEach(dot => {
    dot.classList.toggle('active', dot.getAttribute('data-color') === color);
  });
  document.getElementById(hiddenInputId).value = color;
}

function selectIconOption(containerId, icon, hiddenInputId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.querySelectorAll('.icon-option').forEach(opt => {
    opt.classList.toggle('active', opt.getAttribute('data-icon') === icon);
  });
  document.getElementById(hiddenInputId).value = icon;
}

/* ==========================================================================
   13. QUICK SEARCH MODAL (CTRL+K)
   ========================================================================== */

function openSearchModal() {
  openModal('modal-search');
  const input = document.getElementById('global-search-input');
  input.value = '';
  document.getElementById('search-results-container').innerHTML = `
    <div class="search-empty-state">
      <span>Type anything to search across your local SQLite workspace</span>
    </div>
  `;
  input.focus();
}

function handleGlobalSearch(query) {
  const container = document.getElementById('search-results-container');
  const q = query.trim().toLowerCase();

  if (!q) {
    container.innerHTML = `
      <div class="search-empty-state">
        <span>Type anything to search across your local SQLite workspace</span>
      </div>
    `;
    return;
  }

  // Query Collections & Pages via SQLite
  const collections = queryAll(`SELECT * FROM collections WHERE LOWER(name) LIKE ? OR LOWER(description) LIKE ? LIMIT 5`, [`%${q}%`, `%${q}%`]);
  const pages = queryAll(`
    SELECT p.*, c.name as collection_name 
    FROM pages p 
    JOIN collections c ON p.collection_id = c.id 
    WHERE LOWER(p.title) LIKE ? OR LOWER(p.content_text) LIKE ? 
    LIMIT 10
  `, [`%${q}%`, `%${q}%`]);

  if (collections.length === 0 && pages.length === 0) {
    container.innerHTML = `
      <div class="search-empty-state">
        <span>No matching results found for "${escapeHtml(query)}"</span>
      </div>
    `;
    return;
  }

  container.innerHTML = '';

  // Render Collection Results
  collections.forEach(col => {
    const item = document.createElement('div');
    item.className = 'search-result-item';
    item.onclick = () => {
      closeModal('modal-search');
      navigateToCollection(col.id);
    };
    item.innerHTML = `
      <i data-lucide="${escapeHtml(col.icon || 'folder')}" class="icon-sm" style="color: ${col.color || '#6366f1'};"></i>
      <div class="search-result-info">
        <div class="search-result-title">${escapeHtml(col.name)}</div>
        <span class="search-result-meta">Collection • ${escapeHtml(col.description || 'Folder')}</span>
      </div>
    `;
    container.appendChild(item);
  });

  // Render Page Results
  pages.forEach(page => {
    const item = document.createElement('div');
    item.className = 'search-result-item';
    item.onclick = () => {
      closeModal('modal-search');
      navigateToEditor(page.id);
    };
    item.innerHTML = `
      <i data-lucide="file-text" class="icon-sm" style="color: #64748b;"></i>
      <div class="search-result-info">
        <div class="search-result-title">${escapeHtml(page.title)}</div>
        <span class="search-result-meta">in ${escapeHtml(page.collection_name)} ${page.date ? '• ' + page.date : ''}</span>
      </div>
    `;
    container.appendChild(item);
  });

  lucide.createIcons();
}

/* ==========================================================================
   14. SQLITE DATABASE & BACKUP MANAGER
   ========================================================================== */

function openDbModal() {
  openModal('modal-db');
  updateDbStatsPanel();
}

function updateDbStatsPanel() {
  if (!db) return;
  const colCount = queryOne(`SELECT COUNT(*) as c FROM collections`).c;
  const pageCount = queryOne(`SELECT COUNT(*) as c FROM pages`).c;
  const badgeCount = queryOne(`SELECT COUNT(*) as c FROM badges`).c;

  const binary = db.export();
  const sizeKb = (binary.byteLength / 1024).toFixed(1);

  document.getElementById('db-stat-collections').textContent = colCount;
  document.getElementById('db-stat-pages').textContent = pageCount;
  document.getElementById('db-stat-badges').textContent = badgeCount;
  document.getElementById('db-stat-size').textContent = `${sizeKb} KB`;
}

function exportSqliteDatabase() {
  if (!db) return;
  const binary = db.export();
  const blob = new Blob([binary], { type: 'application/x-sqlite3' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sotion_${new Date().toISOString().split('T')[0]}.db`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('SQLite .db file downloaded');
}

function handleImportSqliteFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const uInt8Array = new Uint8Array(reader.result);
      const testDb = new SQL.Database(uInt8Array);

      // Verify essential tables exist
      const check = testDb.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='collections'`);
      if (!check || check.length === 0) {
        throw new Error('Invalid database: Missing collections table');
      }

      db = testDb;
      await persistDatabase();
      loadThemeFromDatabase();
      closeModal('modal-db');
      navigateToDashboard();
      renderSidebar();
      showToast('Database successfully restored!');
    } catch (err) {
      alert('Failed to load SQLite file: ' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

function confirmResetDatabase() {
  if (confirm('Are you sure you want to completely erase the database and recreate starter data?')) {
    db = new SQL.Database();
    createSchema();
    seedStarterData();
    persistDatabase();
    loadThemeFromDatabase();
    closeModal('modal-db');
    navigateToDashboard();
    renderSidebar();
    showToast('Workspace reset to default starter state');
  }
}

/* ==========================================================================
   15. MODAL UTILITIES
   ========================================================================== */

function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.remove('hidden');
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.add('hidden');
}

function handleModalBackdropClick(event, modalId) {
  if (event.target.id === modalId) {
    closeModal(modalId);
  }
}

/* ==========================================================================
   16. EVENT LISTENERS & SETUP
   ========================================================================== */

function setupEventListeners() {
  // Global Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    // Ctrl+K or Cmd+K: Open Search
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (isUnlocked) openSearchModal();
    }
    // Escape: Close any open modal or popover
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-backdrop').forEach(m => m.classList.add('hidden'));
      closeDatePopover();
    }
  });

  // Editor Formatting Toolbar
  document.querySelectorAll('.toolbar-btn[data-command]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const cmd = btn.getAttribute('data-command');
      document.execCommand(cmd, false, null);
      triggerAutosave();
    });
  });

  document.querySelectorAll('.toolbar-btn[data-format]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const tag = btn.getAttribute('data-format');
      document.execCommand('formatBlock', false, `<${tag}>`);
      triggerAutosave();
    });
  });

  // Color picker event delegation
  document.querySelectorAll('.color-palette').forEach(palette => {
    palette.addEventListener('click', (e) => {
      const dot = e.target.closest('.color-dot');
      if (!dot) return;
      const color = dot.getAttribute('data-color');
      let inputId = 'badge-selected-color';
      if (palette.id === 'col-color-picker') inputId = 'col-selected-color';
      else if (palette.id === 'col-badge-color-picker') inputId = 'col-badge-selected-color';
      selectColorDot(palette.id, color, inputId);
    });
  });

  // Icon picker event delegation
  const iconPicker = document.getElementById('col-icon-picker');
  if (iconPicker) {
    iconPicker.addEventListener('click', (e) => {
      const opt = e.target.closest('.icon-option');
      if (!opt) return;
      const icon = opt.getAttribute('data-icon');
      selectIconOption('col-icon-picker', icon, 'col-selected-icon');
    });
  }
}

// Toast Notifications
function showToast(message) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<i data-lucide="info" class="icon-sm color-indigo"></i><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  lucide.createIcons();

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 2600);
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
