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
      user_menu_logout: 'ログアウト',
      user_menu_lang_hint: '言語設定は「設定」で変更できます。',
      home_welcome_suffix: 'さん、おかえりなさい。',
      home_action_open_tasks: 'タスクを開く',
      home_action_new_task: '新規タスク',
      home_action_new_message: '新規メッセージ',
      home_stat_today_label: '今日のタスク',
      home_stat_today_hint: '直近のカードがここに並びます',
      home_stat_unread_label: '未読',
      home_stat_unread_hint: '未読メッセージの合計',
      home_stat_overdue_label: '期限超過リスク',
      home_stat_overdue_hint: '今日時点での見逃せない件数',
      unit_items: '件',
      home_recent_tasks_title: '直近のタスク',
      home_recent_messages_title: '新着メッセージ',
      home_shift_title: 'シフト',
      home_shift_link: '過去シフト',
      home_shift_empty: 'シフト投稿はありません。',
      home_shift_untitled: '（無題のシフト）',
      link_view_all: '一覧へ',
      btn_reload: '再読込',
      task_tab_my: 'あなたのタスク',
      task_tab_created: '依頼したタスク',
      task_tab_all: '全タスク',
      placeholder_keyword_search: 'キーワード検索',
      task_filter_assignee: '担当者で絞り込み',
      messages_filter_folder: 'フォルダ',
      filter_all: '全て',
      messages_filter_unread_only: '未読のみ',
      messages_mark_all_read: '全て既読にする',
      settings_profile_title: 'プロフィール',
      settings_profile_desc: 'メンバーに表示される名前とプロフィール画像を管理します。',
      settings_profile_choose_image: '画像を選択',
      settings_profile_display_name_label: '表示名',
      settings_profile_display_name_placeholder: 'チームで表示される名前',
      settings_profile_image_note: '最大8MBの画像ファイルがアップロードされ、ドライブに安全に保存されます。',
      settings_profile_image_empty: '未設定',
      settings_language_label: '表示言語',
      settings_language_option_ja: '日本語',
      settings_language_option_en: '英語',
      settings_language_note: '保存すると、次回以降もこの言語で表示されます。',
      settings_theme_title: '外観設定',
      settings_theme_desc: 'アプリの配色テーマを切り替えて見やすさを調整します。',
      settings_theme_label: 'テーマ',
      settings_theme_option_light: 'ライト',
      settings_theme_option_dark: 'ダーク',
      settings_theme_option_system: 'システムに合わせる',
      settings_theme_status_light: 'ライトテーマを適用中',
      settings_theme_status_dark: 'ダークテーマを適用中',
      settings_theme_status_system: 'システム設定に連動中',
      settings_theme_guide_intro: '選択したテーマはすぐに反映されます。',
      settings_theme_light_desc: '明るく爽やかなトーンで日中の作業に最適。',
      settings_theme_dark_desc: '暗い環境や長時間の閲覧で目を保護。',
      settings_theme_system_desc: 'ご利用端末のテーマ設定に自動追従します。',
      btn_save_changes: '変更を保存',
      section_basic_info: '基本情報',
      section_details: '詳細設定',
      label_title: 'タイトル',
      label_due: '期限',
      label_priority: '優先度',
      label_assignees: '担当者',
      label_recurrence: '繰り返し',
      label_pattern: 'パターン',
      label_subject: '件名',
      label_body: '本文',
      label_templates: '定型文',
      label_attachments: '添付',
      label_status: 'ステータス',
      label_comments: 'コメント',
      label_read: '既読',
      label_unread: '未読',
      label_name: '名称',
      label_color: 'カラー',
      label_source_message: '元メッセージ：',
      status_todo: '未着手',
      status_doing: '進行中',
      status_done: '完了',
      priority_high: '高',
      priority_medium: '中',
      priority_low: '低',
      assignee_select_all: 'すべて選択',
      assignee_clear_all: 'すべて解除',
      assignee_note: 'タスクの担当者を1名以上選択してください。自分自身も選択できます。',
      repeat_none: '単発（繰り返しなし）',
      repeat_daily: '毎日',
      repeat_weekly: '毎週',
      repeat_monthly: '毎月',
      repeat_note: '完了時に次回タスクを自動で生成します。',
      messages_select_folder: 'フォルダを選択',
      attachments_add: '画像を追加',
      attachments_hint: '最大5件・各10MBまで',
      btn_cancel: 'キャンセル',
      btn_save: '保存する',
      btn_post: '投稿する',
      btn_delete: '削除',
      btn_close: '閉じる',
      btn_back: '戻る',
      modal_task_new_title: '新しいタスク',
      modal_message_new_title: '新しいメッセージ',
      modal_task_detail_title: 'タスク詳細',
      modal_message_detail_title: 'メッセージ詳細',
      modal_folder_create_title: 'フォルダを作成',
      modal_unread_status_title: '未読状況',
      message_convert_task: 'この内容でタスク',
      message_mark_read: '既読にする',
      message_unread_status: '未読状況確認',
      comments_placeholder: 'コメントを入力...',
      comments_post: 'コメントを投稿',
      fab_task: 'タスク',
      fab_message: 'メッセージ',
      task_update_now: 'この内容で更新',
      task_mark_complete: '完了にする',
      folder_name_placeholder: 'メイン',
      folder_public_label: '全員に公開',
      folder_members_label: 'メンバー (限定公開時)',
      folder_member_placeholder: '名前・メールで絞り込み',
      assignee_count_prefix: '選択 ',
      assignee_count_suffix: ' 件',
    },
    en: {
      app_title: 'ShiftFlow',
      nav_home: 'Home',
      nav_tasks: 'Tasks',
      nav_messages: 'Messages',
      nav_members: 'Members',
      nav_files: 'Files',
      nav_settings: 'Settings',
      user_menu_profile: 'Profile settings',
      user_menu_logout: 'Sign out',
      user_menu_lang_hint: 'Change the interface language from Settings.',
      home_welcome_suffix: ', welcome back!',
      home_action_open_tasks: 'Open tasks',
      home_action_new_task: 'New task',
      home_action_new_message: 'New message',
      home_stat_today_label: "Today's tasks",
      home_stat_today_hint: 'Recent tasks appear here',
      home_stat_unread_label: 'Unread',
      home_stat_unread_hint: 'Total unread messages',
      home_stat_overdue_label: 'Overdue risk',
      home_stat_overdue_hint: 'High-priority items due today',
      unit_items: 'items',
      home_recent_tasks_title: 'Recent tasks',
      home_recent_messages_title: 'New messages',
      home_shift_title: 'Shifts',
      home_shift_link: 'Past shifts',
      home_shift_empty: 'No shift posts.',
      home_shift_untitled: '(Untitled shift)',
      link_view_all: 'View all',
      btn_reload: 'Refresh',
      task_tab_my: 'Your tasks',
      task_tab_created: 'Assigned by you',
      task_tab_all: 'All tasks',
      placeholder_keyword_search: 'Search by keyword',
      task_filter_assignee: 'Filter by assignee',
      messages_filter_folder: 'Folder',
      filter_all: 'All',
      messages_filter_unread_only: 'Unread only',
      messages_mark_all_read: 'Mark all read',
      settings_profile_title: 'Profile',
      settings_profile_desc: 'Manage the name and photo shown to teammates.',
      settings_profile_choose_image: 'Choose image',
      settings_profile_display_name_label: 'Display name',
      settings_profile_display_name_placeholder: 'Name shown to the team',
      settings_profile_image_note: 'Images up to 8MB are uploaded securely to Drive.',
      settings_profile_image_empty: 'Not set',
      settings_language_label: 'Language',
      settings_language_option_ja: 'Japanese',
      settings_language_option_en: 'English',
      settings_language_note: 'Your preference applies immediately and is saved for future visits.',
      settings_theme_title: 'Appearance',
      settings_theme_desc: 'Switch the color theme to suit your environment.',
      settings_theme_label: 'Theme',
      settings_theme_option_light: 'Light',
      settings_theme_option_dark: 'Dark',
      settings_theme_option_system: 'Match system',
      settings_theme_status_light: 'Light theme active',
      settings_theme_status_dark: 'Dark theme active',
      settings_theme_status_system: 'Following system setting',
      settings_theme_guide_intro: 'Changes apply immediately.',
      settings_theme_light_desc: 'Bright, refreshing tones ideal for daytime work.',
      settings_theme_dark_desc: 'Protects your eyes in darker rooms or long sessions.',
      settings_theme_system_desc: 'Automatically follows your device preference.',
      btn_save_changes: 'Save changes',
      section_basic_info: 'Basic info',
      section_details: 'Advanced settings',
      label_title: 'Title',
      label_due: 'Due date',
      label_priority: 'Priority',
      label_assignees: 'Assignees',
      label_recurrence: 'Recurrence',
      label_pattern: 'Pattern',
      label_subject: 'Subject',
      label_body: 'Body',
      label_templates: 'Templates',
      label_attachments: 'Attachments',
      label_status: 'Status',
      label_comments: 'Comments',
      label_read: 'Read',
      label_unread: 'Unread',
      label_name: 'Name',
      label_color: 'Color',
      label_source_message: 'Source message:',
      status_todo: 'To do',
      status_doing: 'In progress',
      status_done: 'Done',
      priority_high: 'High',
      priority_medium: 'Medium',
      priority_low: 'Low',
      assignee_select_all: 'Select all',
      assignee_clear_all: 'Clear all',
      assignee_note: 'Select at least one assignee. You can include yourself.',
      repeat_none: 'One-time (no repeat)',
      repeat_daily: 'Daily',
      repeat_weekly: 'Weekly',
      repeat_monthly: 'Monthly',
      repeat_note: 'Automatically schedules the next task after completion.',
      messages_select_folder: 'Choose a folder',
      attachments_add: 'Add images',
      attachments_hint: 'Up to 5 files, 10MB each',
      btn_cancel: 'Cancel',
      btn_save: 'Save',
      btn_post: 'Post',
      btn_delete: 'Delete',
      btn_close: 'Close',
      btn_back: 'Back',
      modal_task_new_title: 'New task',
      modal_message_new_title: 'New message',
      modal_task_detail_title: 'Task details',
      modal_message_detail_title: 'Message details',
      modal_folder_create_title: 'Create folder',
      modal_unread_status_title: 'Unread status',
      message_convert_task: 'Create task from message',
      message_mark_read: 'Mark as read',
      message_unread_status: 'Unread overview',
      comments_placeholder: 'Type a comment...',
      comments_post: 'Post comment',
      fab_task: 'Task',
      fab_message: 'Message',
      task_update_now: 'Update with these changes',
      task_mark_complete: 'Mark complete',
      folder_name_placeholder: 'Main',
      folder_public_label: 'Visible to everyone',
      folder_members_label: 'Members (when private)',
      folder_member_placeholder: 'Filter by name or email',
      assignee_count_prefix: 'Selected ',
      assignee_count_suffix: ' items',
    },
  };

  var currentLang = 'ja';
  var STORAGE_KEY = 'shiftflow_lang';
  var LANGUAGE_EVENT = 'shiftflow:languagechange';

  function persistLanguage(lang) {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (_err) {
      /* noop */
    }
  }

  function resolveInitialLanguage() {
    var bootstrap = globalScope.__SHIFT_FLOW_BOOTSTRAP__ || {};
    var bootstrapLang =
      bootstrap.userInfo && typeof bootstrap.userInfo.language === 'string'
        ? bootstrap.userInfo.language.trim().toLowerCase()
        : '';
    if (bootstrapLang && translations[bootstrapLang]) {
      return bootstrapLang;
    }
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved && translations[saved]) {
        return saved;
      }
    } catch (_err) {}
    var browserLang = (navigator.language || navigator.userLanguage || '').split('-')[0];
    if (translations[browserLang]) {
      return browserLang;
    }
    return 'ja';
  }

  function initI18n() {
    currentLang = resolveInitialLanguage();
    persistLanguage(currentLang);
    updateUI();
    updateHtmlLang();
    updateLangSelectorState();
    emitLanguageChange();
  }

  function setLanguage(lang) {
    if (!translations[lang]) {
      return;
    }
    if (currentLang === lang) {
      persistLanguage(lang);
      updateHtmlLang();
      updateLangSelectorState();
      return;
    }
    currentLang = lang;
    persistLanguage(lang);
    updateUI();
    updateHtmlLang();
    updateLangSelectorState();
    emitLanguageChange();
  }

  function t(key) {
    var dict = translations[currentLang] || translations['ja'];
    return dict[key] || key;
  }

  function emitLanguageChange() {
    if (typeof document === 'undefined' || typeof document.dispatchEvent !== 'function') {
      return;
    }
    try {
      var event;
      if (typeof CustomEvent === 'function') {
        event = new CustomEvent(LANGUAGE_EVENT, { detail: { lang: currentLang } });
      } else if (typeof document.createEvent === 'function') {
        event = document.createEvent('CustomEvent');
        event.initCustomEvent(LANGUAGE_EVENT, true, true, { lang: currentLang });
      }
      if (event) {
        document.dispatchEvent(event);
      }
    } catch (_err) {
      /* noop */
    }
  }

  function updateUI() {
    var elements = document.querySelectorAll('[data-i18n]');
    elements.forEach(function (el) {
      var key = el.getAttribute('data-i18n');
      var text = t(key);

      var tagName = el.tagName;
      if ((tagName === 'INPUT' || tagName === 'TEXTAREA') && el.getAttribute('placeholder')) {
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
    var items = document.querySelectorAll('.lang-selector-item');
    if (items.length) {
      items.forEach(function (item) {
        var targetLang = item.getAttribute('data-lang');
        var isActive = targetLang === currentLang;
        item.classList.toggle('active', isActive);
        if (item.classList.contains('btn')) {
          item.classList.toggle('btn-primary', isActive);
          item.classList.toggle('btn-outline-secondary', !isActive);
        }
        item.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
    }
    var select = document.getElementById('setting-language');
    if (select && select.value !== currentLang) {
      select.value = currentLang;
    }
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
