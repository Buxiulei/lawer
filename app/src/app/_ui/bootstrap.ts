/**
 * 首屏防闪脚本与它们用到的常量。
 * 这个模块**不能**标 'use client'：root layout 是服务端组件，
 * 从客户端模块取字符串会拿到 client reference 存根而不是脚本本体。
 */

export const THEME_STORAGE_KEY = 'lawer.theme';
export const DISCREET_STORAGE_KEY = 'lawer.discreet';

/** 登录态 JWT 的键名。读写一律走 _ui/auth，这里只是给首屏脚本一份字面量。 */
export const TOKEN_STORAGE_KEY = 'lawer.token';

/** 低调模式开启后对外显示的中性标题（DESIGN.md RISK 1）。 */
export const NEUTRAL_TITLE = '工作台';

/** 非低调模式下路由切换瞬间的兜底标题（避免上一页的案件标题残留）。 */
export const APP_TITLE = '裁员应对专员';

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
 * TODO 接 cases 列表接口后改跳用户自己的案件，现在全站只有 demo 一个去处。
 */
export const signedInRedirectScript = `(function(){try{if(localStorage.getItem('${TOKEN_STORAGE_KEY}')){location.replace('/case/demo')}}catch(e){}})();`;
