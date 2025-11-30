/**
 * ShiftFlow Internationalization (i18n) Module
 * Handles language switching and text updates.
 */
(function (globalScope) {
  var translations = {
    ja: {
      app_title: 'ShiftFlow',
      nav_home: 'ホーム',
      nav_tasks: 'タスク',
      nav_messages: 'メッセージ',
      nav_members: 'メンバー',
      nav_files: 'ファイル',
      nav_settings: '設定',
      user_menu_profile: 'プロフィール設定',
      user_menu_theme: 'テーマ設定',
      user_menu_lang: '言語設定',
      user_menu_logout: 'ログアウト',
      lang_ja: '日本語',
      lang_en: 'English',
      section_today_tasks: '今日のタスク',
      section_unread_messages: '未読メッセージ',
      task_search_placeholder: 'タスクを検索...',
      filter_all_tasks: 'すべてのタスク',
      filter_my_tasks: '自分のタスク',
      filter_assigned_tasks: '依頼したタスク',
      status_todo: '未着手',
      status_doing: '進行中',
      status_done: '完了',
      priority_high: '高',
      priority_medium: '中',
      priority_low: '低',
      btn_create_task: 'タスク作成',
      btn_login_google: 'Google でログイン',
      guest_user: 'ゲストユーザー',
    },
    en: {
      app_title: 'ShiftFlow',
      nav_home: 'Home',
      nav_tasks: 'Tasks',
      nav_messages: 'Messages',
      nav_members: 'Members',
      nav_files: 'Files',
      nav_settings: 'Settings',
      user_menu_profile: 'Profile',
      user_menu_theme: 'Theme',
      user_menu_lang: 'Language',
      user_menu_logout: 'Logout',
      lang_ja: 'Japanese',
      lang_en: 'English',
      section_today_tasks: 'Today\'s Tasks',
      section_unread_messages: 'Unread Messages',
      task_search_placeholder: 'Search tasks...',
      filter_all_tasks: 'All Tasks',
      filter_my_tasks: 'My Tasks',
      filter_assigned_tasks: 'Assigned Tasks',
      status_todo: 'To Do',
      status_doing: 'In Progress',
      status_done: 'Done',
      priority_high: 'High',
      priority_medium: 'Medium',
      priority_low: 'Low',
      btn_create_task: 'Create Task',
      btn_login_google: 'Sign in with Google',
      guest_user: 'Guest User',
    },
  };

  var currentLang = 'ja';
  var STORAGE_KEY = 'shiftflow_lang';

  function initI18n() {
    // Load persisted language or default to browser language or 'ja'
    var saved = localStorage.getItem(STORAGE_KEY);
    if (saved && translations[saved]) {
      currentLang = saved;
    } else {
      var browserLang = (navigator.language || navigator.userLanguage || '').split('-')[0];
      if (translations[browserLang]) {
        currentLang = browserLang;
      } else {
        currentLang = 'ja';
      }
    }
    updateUI();
    updateHtmlLang();
  }

  function setLanguage(lang) {
    if (translations[lang]) {
      currentLang = lang;
      localStorage.setItem(STORAGE_KEY, lang);
      updateUI();
      updateHtmlLang();

      // Update active state in language selector if it exists
      updateLangSelectorState();
    }
  }

  function t(key) {
    var dict = translations[currentLang] || translations['ja'];
    return dict[key] || key;
  }

  function updateUI() {
    var elements = document.querySelectorAll('[data-i18n]');
    elements.forEach(function (el) {
      var key = el.getAttribute('data-i18n');
      var text = t(key);

      if (el.tagName === 'INPUT' && el.getAttribute('placeholder')) {
        el.setAttribute('placeholder', text);
      } else {
        // Preserve icon if it exists as first child
        var icon = el.querySelector('.material-icons, .material-icons-outlined');
        if (icon) {
            // If there is an icon, we assume the text is in a text node or a span following it.
            // For simplicity in this app's structure, we might need to target a specific child or just append text.
            // Let's check if there is a .nav-label or similar.
            var label = el.querySelector('.nav-label, .user-menu-name, .brand-text-main, span:not(.material-icons):not(.material-icons-outlined)');
            if (label) {
                label.textContent = text;
            } else {
                // Fallback: replace text content but keep children?
                // This is risky if we replace the icon.
                // Let's try to find the text node.

                // Safe approach for this specific app structure:
                // Most nav items are: <i class="material-icons">...</i> <span class="nav-label">Text</span>
                // So targeting .nav-label etc is better.

                // If no specific label class found, and it has an icon, maybe we shouldn't overwrite innerHTML.
                // But if we added data-i18n to the container, we expect it to handle the text.

                // Let's refine: The data-i18n should ideally be ON the text element itself if possible.
                // If it's on the container, we look for a text container.
            }
        } else {
            el.textContent = text;
        }
      }
    });

    // Special handling for elements that might need specific targeting
    // (Moved logic to data-i18n placement strategy: place data-i18n on the text span)
  }

  function updateHtmlLang() {
      document.documentElement.lang = currentLang;
  }

  function updateLangSelectorState() {
      // Will implement once the selector HTML is known
      var items = document.querySelectorAll('.lang-selector-item');
      items.forEach(function(item) {
          if (item.dataset.lang === currentLang) {
              item.classList.add('active');
              // Add checkmark if needed
          } else {
              item.classList.remove('active');
          }
      });
  }

  // Expose to global
  globalScope.I18n = {
    init: initI18n,
    setLanguage: setLanguage,
    t: t,
    get currentLang() { return currentLang; }
  };

  // Auto init on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initI18n);
  } else {
    initI18n();
  }

})(typeof window !== 'undefined' ? window : this);
