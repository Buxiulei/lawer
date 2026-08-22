'use client';

import { useDiscreet } from './discreet';

/**
 * 低调模式下把一处壳层文案换成中性词，否则照原样。
 *
 * 给**服务端组件**里的页面标题用——为了换两个字把整页转成客户端组件不值当。
 * 客户端组件里直接用 useDiscreet 三元也行，用这个只是省得重复写。
 *
 * 换的是壳层，不是正文：正文整块进糊层（见 _ui/veil），不换词。
 */
export function NeutralLabel({ plain, neutral }: { plain: string; neutral: string }) {
  const { discreet } = useDiscreet();
  return <>{discreet ? neutral : plain}</>;
}
