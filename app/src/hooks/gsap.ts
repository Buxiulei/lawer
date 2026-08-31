/**
 * **全站 gsap 的唯一入口。**想用 gsap 只能从这里 import。
 *
 * 收口是为了三件在别处必然会漏的事：
 *
 * 1. `gsap.registerPlugin(useGSAP)` 只调一次。散在各组件里调，
 *    删掉其中一个组件时另一个就静默失去清理能力。
 * 2. `gsap.defaults` 把默认时长/曲线钉到 token 上，
 *    这样忘了写 `ease` 的那条 tween 落在 `--ease-out` 上，而不是 gsap 的 `power1.out`。
 * 3. **禁 `gsap/all`**：那一行会把全部插件拖进首屏 chunk。
 *    本期一个插件都不用；将来要用，插件在这里单独 import 并登记，
 *    调用方仍然只认这一个出口。
 */
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';

import { EASE, MO, sec } from '@/app/_ui/motion';

gsap.registerPlugin(useGSAP);
gsap.defaults({ duration: sec(MO.base), ease: EASE.out });

export { gsap, useGSAP };
