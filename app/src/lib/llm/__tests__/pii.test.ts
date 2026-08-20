// app/src/lib/llm/__tests__/pii.test.ts
// 出境 PII 脱敏（PIPL 39 条）。这些用例守的是合规红线，不是代码风格：
// 任何一条挂掉都意味着真实身份证/手机号/银行卡被发去了境外。
import { describe, expect, it } from 'vitest';

import { createPiiSession, withPiiRedaction } from '../pii';
import { createProvider } from '../providers';
import { MODELS } from '../routing.config';
import type { ChatMessage, ChatStreamResult, Provider } from '../types';
import { emptyUsage } from '../types';
import { drain, mockFetch, sseResponse } from './mock-fetch';

describe('redact：出站替换', () => {
  it('身份证嵌在长句里也认得出，且句子其余部分一字不动', () => {
    const s = createPiiSession();
    const out = s.redact('我叫张三，身份证110101199003078888，2019年3月入职，现在公司不给赔偿。');
    expect(out).toBe('我叫张三，身份证〔身份证#1〕，2019年3月入职，现在公司不给赔偿。');
    // 「2019年3月」这种日常数字绝不能被当成 PII 吃掉
    expect(out).toContain('2019年3月入职');
  });

  it('同一个号码多次指代用同一个占位符，不同号码分别编号', () => {
    const s = createPiiSession();
    const out = s.redact(
      '我手机13812345678，公司只有这个号；HR 说给我发到 138 1234 5678。她自己的号是 13900001111。',
    );
    // 「13812345678」与「138 1234 5678」是同一个号，必须同占位符
    expect(out).toContain('我手机〔手机号#1〕');
    expect(out).toContain('发到 〔手机号#1〕');
    expect(out).toContain('她自己的号是 〔手机号#2〕');
    expect(s.size).toBe(2);
  });

  it('身份证 / 手机号 / 银行卡三类各自独立编号，15 位老证也认', () => {
    const s = createPiiSession();
    const out = s.redact('证件110101900307888，电话13812345678，工资卡6222021234567890123。');
    expect(out).toBe('证件〔身份证#1〕，电话〔手机号#1〕，工资卡〔银行卡#1〕。');
  });

  it('18 位身份证不会被更宽的银行卡规则抢走（顺序即优先级）', () => {
    const s = createPiiSession();
    expect(s.redact('110101199003078888')).toBe('〔身份证#1〕');
  });

  it('统一社会信用代码含字母，不被当成银行卡', () => {
    const s = createPiiSession();
    const text = '被申请人：某某科技有限公司，统一社会信用代码 91110105MA01ABCD2X。';
    expect(s.redact(text)).toBe(text);
    expect(s.size).toBe(0);
  });

  it('日期、金额、工号一类的短数字不误伤', () => {
    const s = createPiiSession();
    const text = '2026-08-19 收到通知，月薪 22000 元，工号 100234，仲裁时效 1 年。';
    expect(s.redact(text)).toBe(text);
  });

  it('公共求助号码一个都不能被改写（差一位就是把人推向空号）', () => {
    // 这些号码经 system prompt 与 knowledge pack 出境，被误替换会在还原后错位，
    // 而 S08 危机场景里给错热线号码是最严重的一类事故。
    const s = createPiiSession();
    const text = [
      '心理援助：12356（24 小时）；北京心理援助热线 座机 800-810-1117 / 手机 010-82951332。',
      '朝阳劳动监察投诉 010-53918580；政策咨询 12333；工会 12351；法律服务 12348。',
      '朝阳法援中心 010-85963226。仲裁院 010-87983310。',
    ].join('\n');
    expect(s.redact(text)).toBe(text);
    expect(s.size).toBe(0);
  });

  it('文号里的年份括号不被当成 PII（京高法发〔2024〕534号）', () => {
    const s = createPiiSession();
    const text = '依据京高法发〔2024〕534号第73问，以及（2024）京03民终12345号。';
    expect(s.redact(text)).toBe(text);
  });
});

describe('restore：入站还原', () => {
  it('出站脱敏 → 入站还原的回环，真值一字不差地回来', () => {
    const s = createPiiSession();
    const original = '本人李哲，身份证110101199003078888，手机13812345678，工资卡6222021234567890123。';
    const redacted = s.redact(original);
    expect(redacted).not.toContain('110101199003078888');
    // 模型会照着占位符起草文书，这是最典型的回程形态
    const modelOutput = `致公司：本人〔身份证#1〕，联系电话〔手机号#1〕，请将补偿款打入〔银行卡#1〕。`;
    expect(s.restore(modelOutput)).toBe(
      '致公司：本人110101199003078888，联系电话13812345678，请将补偿款打入6222021234567890123。',
    );
    expect(s.restore(redacted)).toBe(original);
  });

  it('模型自己编的占位符（映射表里没有）原样保留，不抹成空', () => {
    const s = createPiiSession();
    s.redact('13812345678');
    expect(s.restore('〔手机号#7〕和〔身份证#1〕')).toBe('〔手机号#7〕和〔身份证#1〕');
  });
});

describe('StreamRestorer：占位符被 SSE 分片截断', () => {
  /** 把整段文本按定长切片喂进还原器，返回下发给用户的完整文本 */
  function feed(text: string, size: number, s = createPiiSession()): string {
    const r = s.createStreamRestorer();
    let out = '';
    for (let i = 0; i < text.length; i += size) out += r.push(text.slice(i, i + size));
    return out + r.flush();
  }

  it('逐字符喂入也能拼回真值（最狠的切法：每片 1 字符）', () => {
    const s = createPiiSession();
    s.redact('身份证110101199003078888');
    expect(feed('本人〔身份证#1〕特此通知。', 1, s)).toBe('本人110101199003078888特此通知。');
  });

  it('切在占位符正中间（〔身份 | 证#1〕）不产生半截占位符', () => {
    const s = createPiiSession();
    s.redact('13812345678');
    for (const size of [2, 3, 5, 7]) {
      expect(feed('电话〔手机号#1〕，请回电。', size, s)).toBe('电话13812345678，请回电。');
    }
  });

  it('孤立的「〔」不会把后续输出永久扣住（超过占位符长度上限即放行）', () => {
    const s = createPiiSession();
    const r = s.createStreamRestorer();
    let out = r.push('参见〔');
    out += r.push('京高法发〔2024〕534号第73问，理由必须当场写对');
    out += r.flush();
    expect(out).toBe('参见〔京高法发〔2024〕534号第73问，理由必须当场写对');
  });

  it('流末未闭合的尾巴由 flush 交出，不吞字', () => {
    const s = createPiiSession();
    const r = s.createStreamRestorer();
    expect(r.push('结尾〔身份')).toBe('结尾');
    expect(r.flush()).toBe('〔身份');
  });
});

describe('withPiiRedaction：包在 provider 上的整体行为', () => {
  /** 造一个假 provider：记下收到的 messages，回放指定正文与工具调用 */
  function fakeProvider(name: Provider['name'], reply: { text: string; toolArgs?: string }) {
    const seen: ChatMessage[][] = [];
    const p: Provider = {
      name,
      model: 'x',
      billingModel: 'x',
      async chatStream(messages) {
        seen.push(messages);
        return (async function* (): AsyncGenerator<string, ChatStreamResult, void> {
          for (const ch of reply.text) yield ch;
          return {
            finishReason: 'stop',
            toolCalls: reply.toolArgs
              ? [{ id: 't1', type: 'function', function: { name: 'draft_write', arguments: reply.toolArgs } }]
              : [],
            usage: { model: 'x', usage: emptyUsage() },
          };
        })();
      },
    };
    return { p, seen };
  }

  const history: ChatMessage[] = [
    { role: 'system', content: '客服工单：联系人手机 13812345678' },
    { role: 'user', content: '我身份证110101199003078888，公司不给赔偿' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 't0',
          type: 'function',
          function: { name: 'timeline_add', arguments: '{"detail":"申请人13812345678于当日提出异议"}' },
        },
      ],
    },
  ];

  it('anthropic：system / user / 历史 tool_calls 参数全部脱敏后才出站', async () => {
    const { p, seen } = fakeProvider('anthropic', { text: 'ok' });
    await drain(await withPiiRedaction(p).chatStream(history));
    const sent = JSON.stringify(seen[0]);
    expect(sent).not.toContain('13812345678');
    expect(sent).not.toContain('110101199003078888');
    expect(seen[0][0].content).toBe('客服工单：联系人手机 〔手机号#1〕');
    expect(seen[0][1].content).toBe('我身份证〔身份证#1〕，公司不给赔偿');
    expect(seen[0][2].tool_calls![0].function.arguments).toContain('〔手机号#1〕');
  });

  it('deepseek：境内不脱敏，原样出站（连包装对象都不建）', async () => {
    const { p, seen } = fakeProvider('deepseek', { text: 'ok' });
    expect(withPiiRedaction(p)).toBe(p);
    await drain(await p.chatStream(history));
    expect(seen[0][1].content).toContain('110101199003078888');
  });

  it('模型回程的正文与工具参数都还原成真值', async () => {
    const { p } = fakeProvider('openai', {
      text: '已为你起草，落款用〔身份证#1〕。',
      toolArgs: '{"content":"本人身份证〔身份证#1〕，联系电话〔手机号#1〕"}',
    });
    const { text, result } = await drain(await withPiiRedaction(p).chatStream(history));
    expect(text).toBe('已为你起草，落款用110101199003078888。');
    expect(result.toolCalls[0].function.arguments).toBe(
      '{"content":"本人身份证110101199003078888，联系电话13812345678"}',
    );
  });
});

describe('createProvider：脱敏是路由出口的默认行为', () => {
  const SSE = ['data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}', '', 'data: {"type":"message_stop"}', '', ''].join('\n');

  it('经 createProvider 建的 anthropic 客户端，请求体里没有身份证明文', async () => {
    const [fetchImpl, calls] = mockFetch(() => sseResponse(SSE));
    const client = createProvider(
      { provider: 'anthropic', model: MODELS.CLAUDE_SONNET },
      { apiKey: 'sk-test', fetchImpl },
    );
    await drain(await client.chatStream([{ role: 'user', content: '身份证110101199003078888' }]));
    expect(JSON.stringify(calls[0].body)).not.toContain('110101199003078888');
    expect(JSON.stringify(calls[0].body)).toContain('〔身份证#1〕');
  });

  it('经 createProvider 建的 deepseek 客户端照常发明文（境内不受本机制影响）', async () => {
    const [fetchImpl, calls] = mockFetch(() => sseResponse('data: [DONE]\n\n'));
    const client = createProvider(
      { provider: 'deepseek', model: MODELS.DEEPSEEK_PRO },
      { apiKey: 'sk-test', fetchImpl },
    );
    await drain(await client.chatStream([{ role: 'user', content: '身份证110101199003078888' }]));
    expect(JSON.stringify(calls[0].body)).toContain('110101199003078888');
  });
});
