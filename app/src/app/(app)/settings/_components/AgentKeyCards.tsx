'use client';

import { AgentSetupCard } from './AgentSetupCard';
import { ApiKeysCard } from './ApiKeysCard';
import { useAgentKeySecret } from './useAgentKeySecret';

/**
 * 设置页上要用到「当前这把密钥」的两张卡，共吃一份 state。
 *
 * 【为什么不各自 useAgentKeySecret】两张卡挨着摆在同一屏上，各持一份 state 的形态是：
 * 在上面那张「API key」卡里点「新建」，弹层里的话术确实带着真密钥，关掉弹层——
 * 上面列表已经列出「启用中」，下面「接到你自己的 AI 助手上」那张卡还写着
 * 「还没有密钥。照指南生成一把」、话术还是占位符 `<粘贴你生成时保存的密钥>`，
 * 要整页刷新才对上。用户从常驻那张卡复制走的，是一段粘过去必然 401 的占位符话术。
 * 两张卡各自看都很正常，没有任何报错——只有并排看同一屏才看得出来。
 *
 * 【为什么是 prop 不是 context】只有一层、只有两个消费者，context 那套壳换不来任何东西；
 * 而 prop 必填意味着「谁把这两张卡摆到一起却忘了共用同一份」是**编译错**，
 * 不是又一次静默过期。密钥明文的正本仍只有 useAgentKeySecret 一处。
 */
export function AgentKeyCards() {
  const secret = useAgentKeySecret();
  return (
    <>
      <ApiKeysCard secret={secret} />
      <AgentSetupCard secret={secret} />
    </>
  );
}
