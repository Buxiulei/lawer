/**
 * 首屏防闪脚本与它们用到的常量。
 * 这个模块**不能**标 'use client'：root layout 是服务端组件，
 * 从客户端模块取字符串会拿到 client reference 存根而不是脚本本体。
 */

export const THEME_STORAGE_KEY = 'lawer.theme';
export const DISCREET_STORAGE_KEY = 'lawer.discreet';

/** 登录态 JWT 的键名。读写一律走 _ui/auth，这里只是给首屏脚本一份字面量。 */
export const TOKEN_STORAGE_KEY = 'lawer.token';

/**
 * 上次解析出来的「我的案件」id。读写一律走 _ui/currentCase，这里同样只是给首屏脚本用。
 * 它是缓存不是真相：真相在 GET /api/v1/cases，缓存只为省掉首屏那次往返。
 */
export const CASE_ID_STORAGE_KEY = 'lawer.caseId';

/** 「我的案件」在缓存缺失时的去处：这一页现查接口再跳。 */
export const CASE_RESOLVER_PATH = '/case';

/** 低调模式开启后对外显示的中性标题（DESIGN.md RISK 1）。 */
export const NEUTRAL_TITLE = '工作台';

/** 非低调模式下路由切换瞬间的兜底标题（避免上一页的案件标题残留）。 */
export const APP_TITLE = '土八鼠';

/**
 * 低调模式下任何可能被旁人瞥见的文案的兜底措辞。
 * 适用范围：document.title、Toast、以及将来接入的系统通知/横幅。
 * 硬规则：这类文案里不得出现「裁员」「仲裁」「赔偿」「解除」「劳动」等字样。
 */
export const NEUTRAL_NOTICE = '有一条新的更新';

/** 在 body 渲染前把主题 class 写到 <html>，逻辑须与 theme.tsx 的 applyMode 一致。 */
export const themeBootstrapScript = `(function(){try{var m=localStorage.getItem('${THEME_STORAGE_KEY}');if(m==='light'||m==='dark'){document.documentElement.classList.add(m)}}catch(e){}})();`;

/** 在 body 渲染前落定低调模式，避免金额与真实标题一闪而过。 */
export const discreetBootstrapScript = `(function(){try{if(localStorage.getItem('${DISCREET_STORAGE_KEY}')==='1'){document.documentElement.dataset.discreet='1';document.title='${NEUTRAL_TITLE}'}}catch(e){}})();`;

/**
 * 落地页专用：已登录的人不该看见 landing。放在落地页正文之前同步执行，
 * 抢在首帧前跳走，不闪一下营销页。React 里用 useEffect 判断做不到这一点——
 * 首帧恒为未登录（见 _ui/auth 的 useAuthToken）。
 *
 * 【这里曾经把每个登录用户都送进演示案件】P0：原实现写死 `/case/demo`。
 * 产品唯一的真实用户刷新一次首页就落在演示案件上，横幅写着「这是演示案件」，
 * 名下 20 条时间线一条不见——在他眼里这不是"跳错了"，是"我的登录没了"。
 * 现在只往两个地方去：缓存里有案件 id 就直接进那个案件，没有就交给 CASE_RESOLVER_PATH
 * 现查接口。**这个脚本不再认识 demo 这个词**，别把它加回来。
 *
 * id 过白名单再拼路径：缓存是浏览器里的可写数据，脏值应当确定性地退回解析页，
 * 而不是把用户领到一个 404 的案件页上。
 */
export const signedInRedirectScript = `(function(){try{if(!localStorage.getItem('${TOKEN_STORAGE_KEY}'))return;var id=localStorage.getItem('${CASE_ID_STORAGE_KEY}');location.replace(/^[1-9][0-9]*$/.test(id||'')?'/case/'+id:'${CASE_RESOLVER_PATH}')}catch(e){}})();`;
