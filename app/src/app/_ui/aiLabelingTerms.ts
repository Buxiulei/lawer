// app/src/app/_ui/aiLabelingTerms.ts
// 标识条款那一页的**地址与入口话术**（共用层，无领域字面量）。
//
// 【为什么单起一个文件】§8 要的是"用户服务协议里写明、且提示用户读"。指过去的链接
// 今天有两处（首页页脚、登录页脚），将来还会有注册回执与设置页。
// 各处各写一遍 href 的形态是：改路由时漏掉一处，那一处静默 404——
// 而 404 页面看起来只是"链接坏了"，不像"合规条款没人读得到"。
export const AI_LABELING_TERMS_HREF = '/terms/ai-labeling';
export const AI_LABELING_TERMS_LINK_TEXT = '生成合成内容标识说明';
