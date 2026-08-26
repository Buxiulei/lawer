// 整卡口径两处边界的**实测底数**（2026-08-26）。产出的两个数被引用在：
//   · crisis.ts `hotlineStripDeclined` 的注释（body 内 ≥2 张整卡 = 0 段）
//   · 报评测官/manager 的「L1 与 L2 打架」那条（首段1+模型段1 = 11 段，占全部 ≥2 判定的 11/11）
// **数字会过期，脚本不会**——语料长了就重跑，别引用这里的旧数。
//
// 【去重必须按内容哈希，不能按文件名 —— 2026-08-26 实测】
// 评测官的"跑完即归档"会把同一份转录同时留在 results/ 与 archive/ 两处。
// 那次两边独立数：我 153 轮/11 次，他 157 轮/13 次——**差额全部来自同一批转录被数了两遍**。
// 按文件名去重只挡得住其中 2 个；换成内容哈希后实得 **8 个重复剧本实例**，
// **另外 6 个是同内容不同文件名，文件名去重完全看不见。**
// ⇒ **一个会随归档增长而膨胀的分母，会让此后每一条"N 轮语料里 X 次"都悄悄失真。**
//
// 【我改这一处时自己踩的坑，留着】第一版我把说明改成了"已按内容哈希剔除"，
// **但那次字符串替换没匹配上，代码里还是文件名去重**——脚本照样跑完，
// 打出"另有 **0** 个重复副本"。**说明说的是新口径，跑的是旧口径，而输出看起来完全正常。**
// 是那个 0 与我已知的 2 对不上才发现的。**说明与实现的漂移，最后一道防线是对着数字发愣。**
// 评测官问的底数：真实语料里「≥2 张整卡、且后一张与第一张同行」有多少
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
const { cardOccurrences, stripDuplicateHotlineList, splitCrisisOpener } =
  await import('/home/roots/caiyuan-ws/backend/app/src/lib/agent/crisis.ts');
const PH=['12356','800-810-1117','010-82951332'];
const DIRS=['/home/roots/caiyuan-ws/eval/scripts/eval/results','/home/roots/caiyuan-ws/eval-evidence-archive'];
const files=[]; const walk=d=>{ if(!fs.existsSync(d))return; for(const n of fs.readdirSync(d)){const p=path.join(d,n); const st=fs.statSync(p); if(st.isDirectory())walk(p); else if(n.endsWith('.json'))files.push(p);} }; DIRS.forEach(walk);
// 【按**内容哈希**去重，不按文件名】2026-08-26 实测：评测官的"跑完即归档"会把同一份转录
// 同时留在 results/ 与 archive/ 两处；按文件名去重这次侥幸挡住了，但**归档换个名字它就漏**。
// 后果不是小数点：那次我数 153/11、他数 157/13，差额全部来自同一批转录被数了两遍。
// **一个会随归档增长而膨胀的分母，会让此后每一条"N 轮语料里 X 次"都悄悄失真。**
let bodies=0, dup=0, declined=0, alsoOpenerPair=0, dupFiles=0; const seen=new Set();
for(const f of files){ let d; try{ d=JSON.parse(fs.readFileSync(f,'utf8')); }catch{ continue; }
  for(const sc of d.scenarios??[]){ const k=crypto.createHash('sha256').update(JSON.stringify(sc)).digest('hex'); if(seen.has(k)){ dupFiles++; continue; } seen.add(k);
    for(const t of sc.turns??[]){
      const { opener, body } = splitCrisisOpener(t.text);
      if(!body) continue; bodies++;
      const spans = cardOccurrences(body, PH);
      if(spans.length>=2){ dup++; if(stripDuplicateHotlineList(body,PH)===body) declined++; }
      // 顺带量评测官那条 L1/L2 打架：首段 1 张 + 模型段 1 张 ⇒ 整轮 2
      if(opener && cardOccurrences(opener,PH).length>=1 && spans.length===1) alsoOpenerPair++;
    } } }
console.log(`模型段样本 ${bodies} 段（另有 ${dupFiles} 个剧本实例是重复副本，已按内容哈希剔除）`);
console.log(`  body 内 ≥2 张整卡：${dup} 段；其中**产线剥不动**（后一张与第一张同行）：${declined} 段`);
console.log(`  首段 1 张 + 模型段恰好 1 张（评测官那条 L1/L2 打架的形态）：${alsoOpenerPair} 段`);
