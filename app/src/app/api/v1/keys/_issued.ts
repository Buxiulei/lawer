// app/src/app/api/v1/keys/_issued.ts
// 「刚拿到一把可用明文」这件事对外的响应形状，只在这里拼一次。
//
// 签发（POST /keys）与轮换（POST /keys/{id}/rotate）返回的是同一件东西：明文 + 往哪儿连。
// 两处各手拼一份的形态是——某天给 setupUrls 加了个字段（本单就加了 skill_url），
// 只有其中一处跟上了，而另一处生成的话术**看起来完全正常**，只是少了一行「先取 skill」。
import { setupUrls } from '@/lib/mcp/setup';

/**
 * 保管提醒。这一条与密文落库无关，永远成立：能读写这份档案的凭据就这一串。
 */
export const ISSUED_KEY_WARNING =
  '拿到这串明文的人就能以你的身份读写你的案件档案，不要贴进聊天群、截图或公开仓库。';

/**
 * 「丢了怎么办」。
 *
 * 【为什么不再写「唯一一次显示，丢了只能重建」】secret_enc 落库之后那句话就是假的：
 * 用户随时能在设置页用 GET /keys/{id}/secret 把明文取回来。留着旧措辞的代价不是吓唬人，
 * 是**逼他为了一件不必要的事去吊销重建**——而重建会让所有已经配好的客户端一起断连。
 */
export const ISSUED_KEY_NOTE =
  '忘了也不要紧：随时可以回设置页把它再看一次，或者轮换换一把新的。';

export function issuedKeyBody(
  req: Request,
  params: { id: number; name: string; scopes: string[]; clientName: string | null; key: string },
) {
  return {
    ok: true as const,
    id: params.id,
    name: params.name,
    scopes: params.scopes,
    // 轮换换的是密钥不是「这把 key 代表谁」，所以自报名原样带回，前端不必再拉一次列表
    client_name: params.clientName,
    key: params.key,
    // 拿到 key 的下一步一定是"往哪儿连"，顺手给全（字段名与 /api/v1/agent-setup 一致，
    // 那里还能拿到工具清单与接入说明全文）
    ...setupUrls(req),
    warning: ISSUED_KEY_WARNING,
    note: ISSUED_KEY_NOTE,
  };
}
