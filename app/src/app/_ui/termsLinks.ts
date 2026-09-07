// app/src/app/_ui/termsLinks.ts
// 条款族四张页的**地址与自称**（共用层，无领域字面量）。
//
// 【为什么与 aiLabelingTerms.ts 分成两份】那一份只管标识说明那一页，
// 它的常量已经被首页页脚、登录页脚与一组判据引着；把三个新地址塞进去，
// 那个文件就从"标识条款的地址"变成"所有条款的地址"，而它的名字与注释都还在说前一件事。
//
// 【为什么地址要收成常量】指过去的链接今天有四处（首页页脚、登录页脚、协议正文互指、
// 设置页的帮助入口），将来还会有注册回执。各处各写一遍 href 的形态是：改路由时漏掉一处，
// 那一处静默 404——而 404 页面看起来只是"链接坏了"，不像"合规条款没人读得到"。

/** 《用户服务协议》正文页 */
export const TERMS_HREF = '/terms';
/** 协议的自称：标题、标签页名与各处链接文案都用这一个 */
export const TERMS_TITLE = '用户服务协议';

/** 境外模型的单独同意说明页（协议第五条第 5 款 / 个保法 §39） */
export const TERMS_OVERSEAS_HREF = '/terms/overseas';
export const TERMS_OVERSEAS_TITLE = '境外模型与个人信息出境说明';

/** 受托方清单（协议第五条第 7 款） */
export const TERMS_PROCESSORS_HREF = '/terms/processors';
export const TERMS_PROCESSORS_TITLE = '受托方清单';

/** 投诉、举报与个人信息权利请求的站内入口（协议第十二条第 1 款） */
export const HELP_COMPLAINTS_HREF = '/settings/help';
export const HELP_COMPLAINTS_TITLE = '帮助与投诉';

/**
 * 服务邮箱的**占位**。主理人还没给定这个地址，上线前由经理替换。
 *
 * 【为什么留占位而不是先编一个】编一个 support@… 的形态是：页面上出现一个看起来完全
 * 正常、发过去却没有人收的地址，而协议在同一句里承诺 3 个工作日受理——
 * 一个收不到的入口比明写"这里还没定"更糟。占位由 <Pending> 画成醒目样式，
 * 判据（terms-page.test.tsx / help-page.test.tsx）盯着它别被顺手删掉。
 */
export const SERVICE_EMAIL_PENDING = '服务邮箱';
