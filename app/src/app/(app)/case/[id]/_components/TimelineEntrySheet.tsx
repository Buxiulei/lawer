'use client';

import { useEffect, useId, useState } from 'react';
import { humanError } from '@/app/_ui/api';
import { useCaseDomain } from '@/app/_ui/caseDomain';
import { packOf } from '@/app/_ui/domain';
import { Alert, AlertDescription, AlertTitle } from '@/components/shadcn/alert';
import { AppSheet } from '@/components/shadcn/app-sheet';
import { Button } from '@/components/shadcn/button';
import { Field, InputField, TextareaField } from '@/components/shadcn/field';
import { RadioGroup, RadioGroupItem } from '@/components/shadcn/radio-group';
import { Select } from '@/components/shadcn/select';
import { TIMELINE_KINDS } from '@/lib/cases/timeline-kinds';
import { createEvent, setEventType, type TimelineEventView } from './timelineData';

/**
 * 「记一件事」与「选类型」两张抽屉。骨架照证据登记那一条（AppSheet + 闭合枚举 +
 * fetch + humanError + 成功后本地头插），不另起一套表单机制。
 *
 * 【为什么不让用户选来源档】网页登记的就是当事人自己的说法，档位由服务端缺省成最弱的那一档。
 * 摆一个下拉让他选「书证」的形态是：要件表据此把这一条判成"成立"，
 * 而庭上拿不出与它对应的那份原件——误差方向必须偏向少认（见 lib/cases/source-tier.ts）。
 *
 * 【为什么不加二次确认】记一条是可追加、对外不可见的操作。DESIGN.md 把二次确认留给
 * "会被公司看到 / 不可逆"的那几个出口；每一处都弹一下的形态是它不再被人读。
 */

/** 没选类型时那一行说明。**不写"必须选"**——不选是一条正当的路，判定会回去读那段字。 */
const UNSURE_HINT = '挑不准就不选。不选也存得下，只是之后的判定要回去读你写的那段字。';

/** 本机今天（'YYYY-MM-DD'）。日期框的初值——绝大多数人记的是刚发生的事。 */
function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 「这条记录是什么」那一格。**这一类不分型（空数组）时整个不渲染**：
 * 摆一个只有"先不选"一项的下拉，是在让人回答一个没有人会读的问题。
 */
function EventTypeField({
  domain,
  kind,
  value,
  onChange,
}: {
  domain: string;
  kind: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const id = useId();
  const options = packOf(domain).timelineEventTypes[kind] ?? [];
  if (options.length === 0) return null;
  // 选中那一项自带的说明；没选时给那句"挑不准就不选"。
  const hint = options.find((o) => o.id === value)?.hint ?? UNSURE_HINT;

  return (
    <Field label="这条记录是什么" hint={hint} htmlFor={id}>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">先不选</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** 写入失败那一块。**服务端那句话原样摆出来**——取值非法时它里面列着这一类的全部允许值。 */
function WriteFailure({ message }: { message: string }) {
  return (
    <Alert tone="danger">
      <AlertTitle>这一条没存下来</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

export function AddEventSheet({
  caseId,
  open,
  onClose,
  onCreated,
}: {
  caseId: string;
  open: boolean;
  onClose: () => void;
  onCreated: (created: TimelineEventView) => void;
}) {
  const domain = useCaseDomain(caseId);
  const [kind, setKind] = useState<string>(TIMELINE_KINDS[0]);
  const [happenedAt, setHappenedAt] = useState('');
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [eventType, setEventTypeValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 每次打开都重置：上一次填过的字留在框里的形态是，用户以为自己已经记过这一条了。
  // 初值在 effect 里取而不是 useState 的初始值：today() 在服务端渲染那一帧算出来的是
  // 服务器的日期，与用户本机的日期可能差一天。
  useEffect(() => {
    if (!open) return;
    setKind(TIMELINE_KINDS[0]);
    setHappenedAt(today());
    setTitle('');
    setDetail('');
    setEventTypeValue('');
    setError(null);
    setSaving(false);
  }, [open]);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      onCreated(
        await createEvent(caseId, {
          kind,
          happenedAt,
          title: title.trim(),
          detail,
          eventType: eventType || null,
        }),
      );
      onClose();
    } catch (err) {
      setError(humanError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppSheet
      open={open}
      onClose={onClose}
      title={packOf(domain).copy.pages.timelineAddLabel}
      footer={
        <div className="flex gap-2.5">
          <Button variant="secondary" onClick={onClose} className="min-w-24">
            取消
          </Button>
          <Button
            className="flex-1"
            disabled={saving || title.trim() === '' || happenedAt === ''}
            onClick={() => void submit()}
          >
            {saving ? '正在存…' : '存下来'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {error !== null && <WriteFailure message={error} />}

        <div data-veil="" className="flex flex-col gap-2">
          <p className="fs-s font-medium text-ink">这是谁做的</p>
          <RadioGroup
            aria-label="事件类别"
            value={kind}
            onValueChange={(next) => {
              setKind(next);
              // 类型的取值域按 kind 走，换了类别就必须清空——留着的形态是：
              // 提交时服务端回一句"这个取值不在这一类下"，而用户根本没再碰过那一格。
              setEventTypeValue('');
            }}
          >
            {TIMELINE_KINDS.map((k) => (
              <RadioGroupItem key={k} value={k}>
                {k}
              </RadioGroupItem>
            ))}
          </RadioGroup>
        </div>

        <div data-veil="">
          <EventTypeField
            domain={domain}
            kind={kind}
            value={eventType}
            onChange={setEventTypeValue}
          />
        </div>

        <InputField
          label="哪一天"
          type="date"
          required
          value={happenedAt}
          onChange={(e) => setHappenedAt(e.target.value)}
          hint="记不清具体哪天就先填个大概，之后补一条更准的。"
        />

        <div data-veil="">
          <InputField
            label="一句话说这件事"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：收到书面通知"
            hint="像日记标题那样短就行，细节写在下面。"
          />
        </div>

        <div data-veil="">
          <TextareaField
            label="经过（可留空）"
            rows={3}
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder="谁在场、说了什么、给了什么纸。"
            hint="现在想不起来可以留空，记得了再补一条新的——这一条存下去就不改了。"
          />
        </div>
      </div>
    </AppSheet>
  );
}

/**
 * 「选类型」：给一条**已经登记过、但没人说过它是什么**的事件补上分类标签。
 *
 * 内容一格都改不了（时间线只追加不改删），所以这张抽屉里只有一个下拉：
 * 事件本身原样摆在上面，让人知道自己正在给哪一条选。
 */
export function PickTypeSheet({
  caseId,
  event,
  onClose,
  onSaved,
}: {
  caseId: string;
  event: TimelineEventView | null;
  onClose: () => void;
  onSaved: (updated: TimelineEventView) => void;
}) {
  const domain = useCaseDomain(caseId);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!event) return;
    setValue(event.eventType ?? '');
    setError(null);
    setSaving(false);
  }, [event]);

  const submit = async () => {
    if (!event) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await setEventType(caseId, event.id, value));
      onClose();
    } catch (err) {
      setError(humanError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppSheet
      open={event !== null}
      onClose={onClose}
      title="这条记录是什么"
      footer={
        <div className="flex gap-2.5">
          <Button variant="secondary" onClick={onClose} className="min-w-24">
            取消
          </Button>
          <Button className="flex-1" disabled={saving || value === ''} onClick={() => void submit()}>
            {saving ? '正在存…' : '存下来'}
          </Button>
        </div>
      }
    >
      {event && (
        <div className="flex flex-col gap-5">
          {error !== null && <WriteFailure message={error} />}

          <div data-veil="" className="rounded-[10px] bg-surface-2 px-3.5 py-3">
            <p className="fs-m font-medium text-ink">{event.title}</p>
            <p className="num mt-0.5 fs-xs text-ink-2">{event.kind}</p>
          </div>

          <div data-veil="">
            <EventTypeField
              domain={domain}
              kind={event.kind}
              value={value}
              onChange={setValue}
            />
          </div>

          <p className="fs-xs text-ink-2">
            只改这一格。这条事件记的是哪天、谁做的、写了什么，落库之后一格都改不了——
            记错了补一条新的。
          </p>
        </div>
      )}
    </AppSheet>
  );
}
