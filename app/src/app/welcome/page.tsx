import type { Metadata } from 'next';
import { WelcomeGate } from './_components/WelcomeGate';

/**
 * 标签页标题对**两种态**都得成立：这一页画的可能是「档案已创建」，
 * 也可能是「欢迎回来」。写死成前者，老用户的标签页上仍旧挂着那句
 * 「你的档案刚建好」——F-201 那句话从 <title> 上原样漏出来（复核顺带）。
 */
export const metadata: Metadata = { title: '欢迎' };

/**
 * 登录成功后的落地页。**两种态**：
 *   新人（案件里四个维度全空）→「档案已创建 / 开始首诊」
 *   老用户（任一维度有东西）  →「欢迎回来 / 进入我的案件」
 *
 * 【为什么要分两种（F-201）】老用户退出重登，原先一律读到「档案已创建…接下来做一次首诊」，
 * 唯一 CTA 是「开始首诊」——他的时间线、对话、证据一条没少，只是这一屏从没问过他是谁。
 * 一个正等仲裁的人读到"你的档案刚建好"，第一反应是"我讲过的都没了"。
 *
 * 【为什么不改登录后的落点】经理裁决：主理人对自动跳转敏感，/welcome 保留。
 * 所以修的是这一屏说什么，不是它出不出现。
 *
 * 两屏的正文都在 _components/WelcomeScreens（纯组件，能裸渲，判据够得着），
 * 「新人还是老用户」的判定在 lib/cases/freshness 的 isFreshCase（纯函数，全站一份）。
 */
export default function WelcomePage() {
  return <WelcomeGate />;
}
