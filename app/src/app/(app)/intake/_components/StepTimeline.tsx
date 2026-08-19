'use client';

import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Field';
import type { EventNote, IntakeDraft } from './draft';

const EXAMPLES = [
  '部门开会宣布架构调整',
  'HR 第一次找我谈',
  '收到解除通知书',
  '权限被收走 / 工资没发',
];

function newNote(): EventNote {
  return {
    id: `ev_${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`,
    date: '',
    text: '',
  };
}

export function StepTimeline({
  draft,
  patch,
}: {
  draft: IntakeDraft;
  patch: (p: Partial<IntakeDraft>) => void;
}) {
  const events = draft.events;

  const update = (id: string, next: Partial<EventNote>) =>
    patch({ events: events.map((e) => (e.id === id ? { ...e, ...next } : e)) });

  const remove = (id: string) => patch({ events: events.filter((e) => e.id !== id) });

  const add = () => patch({ events: [...events, newNote()] });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        {events.length === 0 && (
          <p className="rounded-[10px] bg-surface-2 px-3.5 py-3 text-[15px] leading-7 text-ink-2">
            一条只写一句话就够，比如「{EXAMPLES[1]}」。日期记不清可以空着，先把事记下来更重要。
          </p>
        )}

        {events.map((e, i) => (
          <div key={e.id} className="rounded-[12px] border border-line bg-surface p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="num text-[13px] text-ink-2">第 {i + 1} 条</span>
              <button
                type="button"
                onClick={() => remove(e.id)}
                aria-label={`删除第 ${i + 1} 条`}
                className="min-h-11 px-2 text-[14px] text-ink-2 hover:text-ink"
              >
                删掉
              </button>
            </div>
            <div className="mt-1 flex flex-col gap-2 sm:flex-row">
              <input
                type="date"
                value={e.date}
                onChange={(ev) => update(e.id, { date: ev.target.value })}
                aria-label={`第 ${i + 1} 条的日期`}
                className="num h-12 rounded-[10px] border border-line bg-surface-2 px-3 text-[16px] text-ink focus:border-primary focus:outline-none sm:w-[160px]"
              />
              <input
                value={e.text}
                onChange={(ev) => update(e.id, { text: ev.target.value })}
                placeholder={EXAMPLES[i % EXAMPLES.length]}
                aria-label={`第 ${i + 1} 条发生了什么`}
                className="h-12 min-w-0 flex-1 rounded-[10px] border border-line bg-surface-2 px-3 text-[16px] text-ink placeholder:text-ink-2/70 focus:border-primary focus:outline-none"
              />
            </div>
          </div>
        ))}

        <Button variant="secondary" onClick={add} fullWidth>
          + 再记一条
        </Button>
      </div>

      <Textarea
        label="或者整段粘进来"
        rows={6}
        value={draft.freeText}
        onChange={(e) => patch({ freeText: e.target.value })}
        placeholder="和 HR 的聊天记录、邮件原文、或者你自己回忆的经过，直接粘在这里。"
        hint="不用整理格式。建档时会自动拆成时间线，你再核对一遍就行。"
      />
    </div>
  );
}
