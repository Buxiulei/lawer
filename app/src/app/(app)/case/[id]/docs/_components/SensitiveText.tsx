import { Fragment } from 'react';
import { demoCompany } from '@/app/_mock/demo';
import { Sensitive } from '@/components/Sensitive';

/**
 * 公司文件原文里的公司名与金额是低调模式要打码的内容，但它们混在整段文字中间。
 * 这里按字面量切分，只把命中的片段包进 <Sensitive>，其余照常渲染。
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PATTERN = new RegExp(
  `(${escapeRegExp(demoCompany.name)}|\\d[\\d,]*(?:\\.\\d+)?\\s*(?:万元|元))`,
  'g',
);

export function SensitiveText({ text }: { text: string }) {
  const parts = text.split(PATTERN);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <Sensitive key={i}>{part}</Sensitive>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
