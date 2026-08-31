import type { Metadata } from 'next';
import { CaseResolver } from './_components/CaseResolver';

export const metadata: Metadata = { title: '打开我的案件' };

/**
 * `/case`：「我的案件」的解析口。凡是知道要去自己的案件、但不知道 id 的地方
 * 都指到这里（见 _ui/currentCase 的 CASE_RESOLVER_PATH），由这一页现查接口再跳。
 */
export default function CaseResolverPage() {
  return <CaseResolver />;
}
