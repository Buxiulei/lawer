'use client';

/**
 * 按 `IntakeFieldSpec.kind` 画一格首诊输入。
 *
 * ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
 * 问的是什么、选项有哪些、错了说什么，全部来自传进来的 field（正本在 lib/domains/<key>.ts）。
 * 这里只有画法。由 app/__tests__/page-domain-guard.test.ts 机检。
 * ─────────────────────────────────────────────────────
 *
 * 【为什么 record 的子问画成一行输入框，而不是「有 / 没有 / 不确定」】
 * `IntakeFieldSpec.fields` 只给了子问的键与标签，**没有给取值集合**。
 * 替它挑一套答案的形态是：那套答案是从上一个领域抄来的，而落库那侧只是把它原样拼进
 * 一条事件里——读起来完全正常，只有这个行当的人知道那三个词不对。
 * 要受控词表就往 schema 里加取值，别在页面上补。
 */

import { Button } from '@/components/shadcn/button';
import { Card } from '@/components/shadcn/card';
import { InputField, TextareaField } from '@/components/shadcn/field';
import { Input } from '@/components/shadcn/input';
import type { IntakeFieldSpec } from '@/lib/domains/registry';
import { ChoiceCards } from './ChoiceCard';
import type { EventValue, FieldValue } from './schemaFlow';

function newEvent(): EventValue {
  return {
    id: `ev_${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`,
    date: '',
    text: '',
  };
}

export function SchemaField({
  field,
  value,
  onChange,
}: {
  field: IntakeFieldSpec;
  value: FieldValue;
  onChange: (next: FieldValue) => void;
}) {
  // 整格进糊层：低调模式下这些答案是全页最要命的（与手写向导各步同一条口径）
  return (
    <div data-veil="" className="flex flex-col gap-5">
      <Body field={field} value={value} onChange={onChange} />
    </div>
  );
}

function Body({
  field,
  value,
  onChange,
}: {
  field: IntakeFieldSpec;
  value: FieldValue;
  onChange: (next: FieldValue) => void;
}) {
  const text = typeof value === 'string' ? value : '';

  switch (field.kind) {
    case 'enum':
      return (
        <ChoiceCards
          ariaLabel={field.description}
          options={(field.values ?? []).map((v) => ({ value: v }))}
          value={text}
          onChange={(next) => onChange(next)}
        />
      );

    case 'date':
      return (
        <InputField
          label={field.description}
          type="date"
          value={text}
          max="2100-12-31"
          onChange={(e) => onChange(e.target.value)}
          hint={field.futureMessage}
        />
      );

    case 'money':
      return (
        <InputField
          label={field.description}
          type="text"
          inputMode="decimal"
          value={text}
          onChange={(e) => onChange(e.target.value)}
          // 单位在 description 里由领域包自己说清楚；这里只提醒「只填数字」这条与领域无关的约束
          hint="只填数字，不要带单位或逗号。"
        />
      );

    case 'stringList': {
      const list = Array.isArray(value) ? (value as string[]) : [];
      return (
        <TextareaField
          label={field.description}
          rows={5}
          value={list.join('\n')}
          onChange={(e) => onChange(e.target.value.split('\n'))}
          hint="一行一项。空行会被忽略。"
        />
      );
    }

    case 'eventList': {
      const events = Array.isArray(value) ? (value as EventValue[]) : [];
      const update = (id: string, next: Partial<EventValue>) =>
        onChange(events.map((e) => (e.id === id ? { ...e, ...next } : e)));
      return (
        <div className="flex flex-col gap-3">
          {events.map((e, i) => (
            <Card key={e.id} className="p-3 shadow-none">
              <div className="flex items-center justify-between gap-2">
                <span className="num text-[13px] text-ink-2">第 {i + 1} 条</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onChange(events.filter((x) => x.id !== e.id))}
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
                  aria-label={`第 ${i + 1} 条发生了什么`}
                  className="min-w-0 sm:flex-1"
                />
              </div>
            </Card>
          ))}
          <Button variant="secondary" onClick={() => onChange([...events, newEvent()])} className="w-full">
            + 再记一条
          </Button>
          <p className="text-[13px] leading-5 text-ink-2">
            日期记不清可以空着，先把事记下来更重要。
          </p>
        </div>
      );
    }

    case 'record': {
      const record = value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, string>)
        : {};
      return (
        <div className="flex flex-col gap-4">
          {(field.fields ?? []).map((sub) => (
            <InputField
              key={sub.key}
              label={sub.label}
              value={record[sub.key] ?? ''}
              onChange={(e) => onChange({ ...record, [sub.key]: e.target.value })}
            />
          ))}
        </div>
      );
    }

    default:
      return (
        <InputField
          label={field.description}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}
