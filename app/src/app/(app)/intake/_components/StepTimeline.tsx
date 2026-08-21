'use client';

import { Button } from '@/components/shadcn/button';
import { Card } from '@/components/shadcn/card';
import { TextareaField } from '@/components/shadcn/field';
import { Input } from '@/components/shadcn/input';
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
          <Card key={e.id} className="p-3 shadow-none">
            <div className="flex items-center justify-between gap-2">
              <span className="num text-[13px] text-ink-2">第 {i + 1} 条</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => remove(e.id)}
                aria-label={`删除第 ${i + 1} 条`}
                className="px-2 text-[14px] text-ink-2"
              >
                删掉
              </Button>
            </div>
            <div className="mt-1 flex flex-col gap-2 sm:flex-row">
              <Input
                type="date"
                value={e.date}
                onChange={(ev) => update(e.id, { date: ev.target.value })}
                aria-label={`第 ${i + 1} 条的日期`}
                className="num sm:w-[160px]"
              />
              <Input
                value={e.text}
                onChange={(ev) => update(e.id, { text: ev.target.value })}
                placeholder={EXAMPLES[i % EXAMPLES.length]}
                aria-label={`第 ${i + 1} 条发生了什么`}
                // flex-1 只在 ≥sm 的横排里给：竖排时 flex-basis:0 会把 h-12 压成一行文字高
                className="min-w-0 sm:flex-1"
              />
            </div>
          </Card>
        ))}

        <Button variant="secondary" onClick={add} className="w-full">
          + 再记一条
        </Button>
      </div>

      <TextareaField
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
