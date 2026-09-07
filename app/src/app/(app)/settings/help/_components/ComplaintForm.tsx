'use client';

import { useState } from 'react';

import { apiFetch, humanError } from '@/app/_ui/api';
import { Pending } from '@/app/_ui/Pending';
import { SERVICE_EMAIL_PENDING } from '@/app/_ui/termsLinks';
import { Button } from '@/components/shadcn/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/shadcn/card';
import { Field } from '@/components/shadcn/field';
import { Input } from '@/components/shadcn/input';
import { Select } from '@/components/shadcn/select';
import { Textarea } from '@/components/shadcn/textarea';
import {
  COMPLAINT_ACK_WORKDAYS,
  COMPLAINT_BODY_MAX,
  COMPLAINT_CONTACT_MAX,
  COMPLAINT_KIND_HINTS,
  COMPLAINT_KINDS,
  COMPLAINT_REPLY_WORKDAYS,
  type ComplaintKind,
} from '@/lib/complaints-policy';

import { FORM_ACTIONS, FORM_ACTION_BUTTON, FORM_BODY, FORM_FIELDS } from '../../_components/formLayout';

/**
 * 投诉 / 举报 / 个人信息权利请求的提交表单（协议第十二条第 1 款、
 *《生成式人工智能服务管理暂行办法》第十五条「设置便捷的投诉、举报入口，公布处理流程和反馈时限」）。
 *
 * ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
 * 不得出现任何具体领域的字面量：来到这一页的人可能一个案件都没建过
 *（他多半正是为了「把我的信息删掉」才来的），那时没有领域可问。
 * ─────────────────────────────────────────────────────
 *
 * 【提交成功之后为什么整块换成回执，而不是弹一句 toast】用户手上唯一的凭据就是那串受理编号。
 * toast 三秒后消失的形态是：他还没来得及记下来，页面已经回到空表单——
 * 而我们在协议里承诺过「确认受理并给出编号」。所以回执**留在屏幕上**，
 * 连同两个时限一起；要再提一条得自己点「再提一条」。
 *
 * 【时限为什么不写死在这里】它同时印在协议第十二条与这一页上。两处各写一遍的形态是：
 * 改一次口径只改到其中一处，而另一处照常渲染、读起来完全像一句承诺。
 * 常量在 lib/complaints-policy，服务端回执里也带一份。
 */

interface Created {
  receipt_no: string;
  kind: string;
  created_at: string;
  ack_workdays: number;
  reply_workdays: number;
}

export function ComplaintForm() {
  const [kind, setKind] = useState<ComplaintKind>(COMPLAINT_KINDS[0]);
  const [body, setBody] = useState('');
  const [contact, setContact] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Created | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ complaint: Created }>('/complaints', {
        method: 'POST',
        body: { kind, body: body.trim(), contact: contact.trim() },
      });
      setDone(res.complaint);
      setBody('');
      setContact('');
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>已收到，受理编号如下</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-[14px] leading-7 text-ink-2">
          <p className="num rounded-[10px] border border-line bg-surface-2 px-3 py-2.5 text-[18px] font-semibold text-ink">
            {done.receipt_no}
          </p>
          <p>
            请记下这串编号——你日后来问这一条时，它是最快找到它的办法。类型：{done.kind}。
          </p>
          <p>
            我们在 <span className="num">{done.ack_workdays}</span>{' '}
            个工作日内确认受理，
            <span className="num">{done.reply_workdays}</span>{' '}
            个工作日内答复处理结果；属于个人信息权利请求的，同样在{' '}
            <span className="num">{done.reply_workdays}</span> 个工作日内办结，拒绝的会说明理由。
          </p>
          <div className={FORM_ACTIONS}>
            <Button variant="outline" className={FORM_ACTION_BUTTON} onClick={() => setDone(null)}>
              再提一条
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const ready = body.trim().length > 0 && contact.trim().length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>提交投诉、举报或个人信息权利请求</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={FORM_BODY}>
          <div className={FORM_FIELDS}>
            <Field label="类型" hint={COMPLAINT_KIND_HINTS[kind]} required>
              <Select value={kind} onChange={(e) => setKind(e.target.value as ComplaintKind)}>
                {COMPLAINT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="描述"
              hint={`发生了什么、你希望我们怎么处理。最多 ${COMPLAINT_BODY_MAX} 字。`}
              required
            >
              <Textarea
                rows={7}
                maxLength={COMPLAINT_BODY_MAX}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="例如：哪一页、哪一步、什么时候、你看到的和你预期的分别是什么。"
              />
            </Field>

            <Field
              label="联系方式"
              hint="手机号或邮箱，答复往这里发。不填我们就只能把结果挂在站内，而你可能不会再登录。"
              required
            >
              <Input
                value={contact}
                maxLength={COMPLAINT_CONTACT_MAX}
                onChange={(e) => setContact(e.target.value)}
                placeholder="手机号或邮箱"
              />
            </Field>
          </div>

          {error && (
            <p className="rounded-[10px] bg-danger-wash px-3 py-2.5 text-[14px] leading-6 text-danger-ink">
              {error}
            </p>
          )}

          <div className={FORM_ACTIONS}>
            <Button className={FORM_ACTION_BUTTON} disabled={!ready || busy} onClick={submit}>
              {busy ? '提交中…' : '提交'}
            </Button>
            {!ready && (
              <span className="text-[13px] leading-5 text-ink-2">
                还缺：{[body.trim() ? null : '描述', contact.trim() ? null : '联系方式']
                  .filter(Boolean)
                  .join('、')}
              </span>
            )}
          </div>

          <p className="text-[13px] leading-6 text-ink-2">
            也可以发邮件到
            <Pending>{SERVICE_EMAIL_PENDING}</Pending>
            。任何人都可以通过该邮箱举报本服务生成的违法或侵权内容，不限于本站用户。
            我们在 <span className="num">{COMPLAINT_ACK_WORKDAYS}</span> 个工作日内确认受理并给出编号，
            <span className="num">{COMPLAINT_REPLY_WORKDAYS}</span> 个工作日内答复处理结果。
            你也有权直接向网信、市场监管等主管部门投诉、举报。
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
