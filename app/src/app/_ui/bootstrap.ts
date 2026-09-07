/**
 * 首屏防闪脚本与它们用到的常量。
 * 这个模块**不能**标 'use client'：root layout 是服务端组件，
 * 从客户端模块取字符串会拿到 client reference 存根而不是脚本本体。
 */

import { DEFAULT_DOMAIN, DOMAINS } from '@/lib/domains/registry';

import { faviconBootstrapSnippet } from './favicon';

export const THEME_STORAGE_KEY = 'lawer.theme';
export const DISCREET_STORAGE_KEY = 'lawer.discreet';

/** 登录态 JWT 的键名。读写一律走 _ui/auth，键名放这儿是为了不与它成环。 */
export const TOKEN_STORAGE_KEY = 'lawer.token';

/**
 * 上次解析出来的「我的案件」id。读写一律走 _ui/currentCase，键名同样放这儿避免成环
 * （_ui/auth 退出登录时要清它，而 currentCase 反过来要 import auth）。
 * 它是缓存不是真相：真相在 GET /api/v1/cases，缓存只为省掉首屏那次往返。
 */
export const CASE_ID_STORAGE_KEY = 'lawer.caseId';

/** 「我的案件」在缓存缺失时的去处：这一页现查接口再跳。 */
export const CASE_RESOLVER_PATH = '/case';

/**
 * 低调模式词典（DESIGN.md RISK 1）。**正本在领域包**（DomainPack.copy.neutral）——
 * 兜底措辞的全部作用是「看一眼看不出这是什么事」，而什么词会暴露完全取决于领域。
 *
 * 【为什么这里取的是缺省领域那一份】首屏防闪脚本在任何案件之前执行，
 * 那一刻服务端还不知道这个人是哪个领域的用户。按案件领域换词是登录之后的事
 * （案件页拿得到 cases.domain），P4-W1 只把正本挪进领域包、取值逐字不变。
 *
 * 硬规则「这类文案里不得出现本领域的显眼词」现在是**机检**的：
 * 领域包声明 forbiddenWords，assertDomainPack 在装载时逐词比对（写进去就抛）。
 */
const NEUTRAL = DOMAINS[DEFAULT_DOMAIN].copy.neutral;

/** 低调模式开启后对外显示的中性标题。 */
export const NEUTRAL_TITLE = NEUTRAL.title;

/** 非低调模式下路由切换瞬间的兜底标题（避免上一页的案件标题残留）。 */
export const APP_TITLE = NEUTRAL.appTitle;

/**
 * 低调模式下任何可能被旁人瞥见的文案的兜底措辞。
 * 适用范围：document.title、Toast、以及将来接入的系统通知/横幅。
 */
export const NEUTRAL_NOTICE = NEUTRAL.notice;

/** 在 body 渲染前把主题 class 写到 <html>，逻辑须与 theme.tsx 的 applyMode 一致。 */
export const themeBootstrapScript = `(function(){try{var m=localStorage.getItem('${THEME_STORAGE_KEY}');if(m==='light'||m==='dark'){document.documentElement.classList.add(m)}}catch(e){}})();`;

/** 在 body 渲染前落定低调模式，避免金额、真实标题与徽章图标一闪而过。 */
export const discreetBootstrapScript = `(function(){try{if(localStorage.getItem('${DISCREET_STORAGE_KEY}')==='1'){document.documentElement.dataset.discreet='1';document.title='${NEUTRAL_TITLE}';${faviconBootstrapSnippet}}}catch(e){}})();`;

/**
 * 【这里曾经有一段「登录即跳走」的首屏脚本，2026-09-01 由产品负责人裁定删除】
 *
 * 它在落地页正文之前同步执行：读到 token 就 `location.replace` 进案件（或解析页）。
 * 后果是登录用户**永远看不到主页**——地址栏输 `/` 会在首帧前被换成 `/case/…`，
 * 想看一眼首页只能先退出登录。用户原话：「不要默认都跳转到 case 里！默认就是主页！」
 *
 * 现在的规矩只有一条，简单可预期：**`/` 永远渲染主页，不自动跳**。
 * 进自己的案件只靠主动点击（主页 CTA / 壳层导航 → `CASE_RESOLVER_PATH` → 自己的案件）。
 * 别把这个机制以任何形式加回来——包括 useEffect 版、middleware 版、meta refresh 版。
 * 判据见 _ui/__tests__/currentCase.test.ts 第五节与 app/__tests__/landing-cta.test.tsx。
 */
