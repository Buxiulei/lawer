// app/src/app/api/v1/domains/route.ts
// GET 当前环境开着哪几个领域（设计稿 §13 / §16 的灰度开关 LAWER_DOMAINS_ENABLED）。
//
// **免鉴权**：回的只有「这套站点现在支持哪几类纠纷」——注册页要在建号之前就摆出选择，
// 那一刻还没有任何凭据。这里不带任何案件、用户或配置细节，无泄密面。
//
// 【为什么要有这条端点】灰度开关只在服务端读得到：Next 的客户端包里
// `process.env.LAWER_DOMAINS_ENABLED` 恒为 undefined（只有 NEXT_PUBLIC_* 会被注入），
// 于是浏览器里 enabledDomainKeys() 永远只回缺省领域。把选择控件挂在客户端却让它自己去问
// 那个开关的形态是：运维把第二个领域打开了，页面上**一个选项都不会多**，
// 而没有任何一处会报错——开关看起来没生效，运维会以为自己写错了变量名。
//
// 【为什么 force-dynamic】enabledDomainKeys 的约定是「每次现读 env，不进程级缓存」。
// 让这条端点被静态预渲染，等于把开关烙进构建产物：改完开关重启进程也不生效。
import { listDomains } from '@/lib/domains/registry';
import { apiJson } from '@/lib/http/json';

export const dynamic = 'force-dynamic';

export async function GET() {
  const domains = listDomains();
  return apiJson(
    {
      ok: true,
      // key 是落进 cases.domain 的那个值，label 是给人看的名字。
      // **顺序即开关里写的顺序**；但「不选时落哪个」取的是 registry.DEFAULT_DOMAIN，
      // 不是这份清单的第一项（cases.ensureDefaultCase 的 `domain ?? DEFAULT_DOMAIN`）。
      // 两件事说成一件的形态是：运维调换开关里的顺序想改缺省，改完毫无变化且不报错。
      domains: domains.map((d) => ({ key: d.key, label: d.label })),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
