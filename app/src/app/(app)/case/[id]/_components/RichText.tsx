'use client';

import type { ReactNode } from 'react';
import { Sensitive } from '@/components/Sensitive';

/**
 * 消息正文的轻量 markdown：段落、有序/无序列表、**加粗**。不引 md 库。
 * 正文里出现的金额自动包 <Sensitive>，低调模式下与档案面板一起打码。
 */

const BOLD = /\*\*([^*]+)\*\*/g;
/**
 * 金额：带「元 / 万元」的数字，外加裸写的四位以上数字（月薪 25000 这种）。
 * 后一支排除日期与条号，免得把「2026 年」「第 47 条」一起打码。
 */
const MONEY = /(\d[\d,]*(?:\.\d+)?\s*(?:万元|元)|\d{4,}(?![\d\s]*[年月日号条]))/g;

function withMoney(text: string, key: string): ReactNode[] {
  return text.split(MONEY).map((part, i) =>
    i % 2 === 1 ? (
      <Sensitive key={`${key}-m${i}`} className="num">
        {part}
      </Sensitive>
    ) : (
      part
    ),
  );
}

/**
 * 【案号待核实】：服务端拦下编造案号后留的占位（notice: CITATION_BLOCKED）。
 * 淡色标注表示"此处引用待核实"，不用警报色。
 */
const CITE_PENDING = /(【案号待核实】)/g;

function withMarks(text: string, key: string): ReactNode[] {
  return text.split(CITE_PENDING).flatMap((part, i) =>
    i % 2 === 1 ? (
      <span
        key={`${key}-c${i}`}
        className="rounded bg-surface-2 px-1 text-[0.92em] text-ink-2"
      >
        {part}
      </span>
    ) : (
      withMoney(part, `${key}-w${i}`)
    ),
  );
}

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  let i = 0;
  for (const m of text.matchAll(BOLD)) {
    const at = m.index ?? 0;
    if (at > cursor) out.push(...withMarks(text.slice(cursor, at), `${key}-t${i}`));
    out.push(
      <strong key={`${key}-b${i}`} className="font-semibold text-ink">
        {withMarks(m[1], `${key}-bs${i}`)}
      </strong>,
    );
    cursor = at + m[0].length;
    i += 1;
  }
  out.push(...withMarks(text.slice(cursor), `${key}-e`));
  return out;
}

/** 纯文本里的金额打码：给不走 markdown 的地方用（用户气泡、档案里的叙述字段）。 */
export function MaskedText({ text }: { text: string }) {
  return <>{withMoney(text, 'mask')}</>;
}

type Block =
  | { type: 'p'; text: string }
  | { type: 'ul' | 'ol'; items: string[] };

function parse(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    const ol = /^\d+[.、)]\s+(.*)$/.exec(line);
    const ul = /^[-•*]\s+(.*)$/.exec(line);
    const type = ol ? 'ol' : ul ? 'ul' : 'p';

    if (type === 'p') {
      blocks.push({ type: 'p', text: line });
      continue;
    }
    const item = (ol ?? ul)![1];
    const last = blocks[blocks.length - 1];
    if (last && last.type === type) last.items.push(item);
    else blocks.push({ type, items: [item] });
  }
  return blocks;
}

export function RichText({ text }: { text: string }) {
  const blocks = parse(text);
  return (
    <div className="prose-measure space-y-3 text-[16px] leading-[1.75] text-ink">
      {blocks.map((block, i) => {
        if (block.type === 'p') {
          return <p key={i}>{inline(block.text, `p${i}`)}</p>;
        }
        const ListTag = block.type === 'ol' ? 'ol' : 'ul';
        return (
          <ListTag
            key={i}
            className={
              block.type === 'ol'
                ? 'list-decimal space-y-2 pl-6 marker:text-ink-2'
                : 'list-disc space-y-2 pl-6 marker:text-ink-2'
            }
          >
            {block.items.map((item, j) => (
              <li key={j}>{inline(item, `l${i}-${j}`)}</li>
            ))}
          </ListTag>
        );
      })}
    </div>
  );
}
