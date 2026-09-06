// 客户端默认档位：设计稿 §15 点名的三家各是哪一档。
// 这一条看着琐碎，但它是用户唯一不会自己判断的参数——挑长了会在客户端里被静默截断
// （尾巴上的内容没进去，助手照样答得流畅）。
import { describe, expect, it } from 'vitest';

import { NO_TOOL_CLIENTS, clientById } from '../clients';
import { OPENER_TIERS } from '../opener';

describe('客户端矩阵', () => {
  it('DeepSeek medium / 豆包 short / Gemini long', () => {
    expect(clientById('deepseek')?.tier).toBe('medium');
    expect(clientById('doubao')?.tier).toBe('short');
    expect(clientById('gemini')?.tier).toBe('long');
  });

  it('每一家的档位都是 opener 认得的那三档之一（写错一个字就没有默认值了）', () => {
    for (const c of NO_TOOL_CLIENTS) {
      expect(Object.keys(OPENER_TIERS), c.id).toContain(c.tier);
      expect(c.note, `${c.id} 缺注意事项`).toBeTruthy();
    }
  });

  it('id 唯一，且认不出的 id 回 undefined（不悄悄回落到第一家）', () => {
    const ids = NO_TOOL_CLIENTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(clientById('没这家')).toBeUndefined();
  });
});
