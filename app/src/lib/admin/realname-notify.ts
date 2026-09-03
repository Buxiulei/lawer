// app/src/lib/admin/realname-notify.ts
// 审核出结果后给用户发一封**中性**通知。尽力而为：发不出去不影响审核已经落定这件事。
//
// 【为什么不塞进路由里的一段 try/catch】那样"没邮箱"与"发失败"就都退化成同一个
// "什么也没发生"，而这两件事的处置完全不同（前者本来就不该发，后者是通道坏了要修）。
// 单独一个函数，把三种结局各自命名，路由与测试都能对着结局说话。
//
// 【为什么必须在事务之外调用】发信是网络 IO，把它写进 db.transaction 的回调里，
// 一次 SMTP 超时就会把已经核过的实名整个回滚——审核人看到报错、库里什么都没变、
// 而用户那边状态还停在待审。落定与通知的关系是"先落定，再尽力通知"，不可颠倒。
import type Database from 'better-sqlite3';

import { findUserById } from '@/lib/db/otp';
import { realnameReviewResult } from '@/lib/notify/copy';
import { sendMail as realSendMail } from '@/lib/notify/email';
import type { MailCopy } from '@/lib/notify/copy';

/** 三种结局各自有名字：没邮箱不是失败，失败也不是"发过了"。 */
export type RealnameNotifyOutcome = 'sent' | 'no_email' | 'failed';

export interface RealnameNotifyDeps {
  sendMail?: (to: string, copy: MailCopy) => Promise<void>;
}

/**
 * 给刚被审核的用户发一封「有结果了，去看看」。
 * 邮件不说通过还是驳回（见 copy.realnameReviewResult），结果留在站内。
 */
export async function notifyRealnameReviewed(
  db: Database.Database,
  userId: number,
  deps: RealnameNotifyDeps = {},
): Promise<RealnameNotifyOutcome> {
  const user = findUserById(db, userId);
  const email = user?.email?.trim();
  if (!email) return 'no_email';
  try {
    await (deps.sendMail ?? realSendMail)(email, realnameReviewResult({ detailed: user!.notify_verbose === 1 }));
    return 'sent';
  } catch {
    // 发不出去只损失一次提醒：用户下次打开设置页照样看得到结果，且审核已经落定。
    return 'failed';
  }
}
