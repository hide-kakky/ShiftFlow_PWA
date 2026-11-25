import { drainNotifications } from '../../../functions/utils/notifications.js';
import { enqueueTaskReminders } from '../../../functions/utils/taskReminders.js';

export default {
  async scheduled(_event, env, ctx) {
    // 通常APIのcommit後配信に加え、閲覧中の利用者がいない場合も再試行する。
    ctx.waitUntil((async () => {
      try { await enqueueTaskReminders(env); }
      catch { console.warn('[ShiftFlow][Push]', { code: 'scheduled_task_reminders_unavailable' }); }
      await drainNotifications(env);
    })().catch(() => {
      console.warn('[ShiftFlow][Push]', { code: 'scheduled_push_unavailable' });
    }));
  },
};
