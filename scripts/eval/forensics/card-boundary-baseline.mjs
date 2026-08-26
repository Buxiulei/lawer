// 整卡口径两处边界的**实测底数**（2026-08-26）。产出的两个数被引用在：
//   · crisis.ts `hotlineStripDeclined` 的注释（body 内 ≥2 张整卡 = 0 段）
//   · 报评测官/manager 的「L1 与 L2 打架」那条（首段1+模型段1 = 11 段，占全部 ≥2 判定的 11/11）
// **数字会过期，脚本不会**——语料长了就重跑，别引用这里的旧数。
// 评测官问的底数：真实语料里「≥2 张整卡、且后一张与第一张同行」有多少
import fs from 'node:fs'; import path from 'node:path';
const { cardOccurrences, stripDuplicateHotlineList, splitCrisisOpener } =
  await import('/home/roots/caiyuan-ws/backend/app/src/lib/agent/crisis.ts');
const PH=['12356','800-810-1117','010-82951332'];
const DIRS=['/home/roots/caiyuan-ws/eval/scripts/eval/results','/home/roots/caiyuan-ws/eval-evidence-archive'];
const files=[]; const walk=d=>{ if(!fs.existsSync(d))return; for(const n of fs.readdirSync(d)){const p=path.join(d,n); const st=fs.statSync(p); if(st.isDirectory())walk(p); else if(n.endsWith('.json'))files.push(p);} }; DIRS.forEach(walk);
let bodies=0, dup=0, declined=0, alsoOpenerPair=0; const seen=new Set();
for(const f of files){ let d; try{ d=JSON.parse(fs.readFileSync(f,'utf8')); }catch{ continue; }
  for(const sc of d.scenarios??[]){ const k=path.basename(f)+'|'+sc.id; if(seen.has(k))continue; seen.add(k);
    for(const t of sc.turns??[]){
      const { opener, body } = splitCrisisOpener(t.text);
      if(!body) continue; bodies++;
      const spans = cardOccurrences(body, PH);
      if(spans.length>=2){ dup++; if(stripDuplicateHotlineList(body,PH)===body) declined++; }
      // 顺带量评测官那条 L1/L2 打架：首段 1 张 + 模型段 1 张 ⇒ 整轮 2
      if(opener && cardOccurrences(opener,PH).length>=1 && spans.length===1) alsoOpenerPair++;
    } } }
console.log(`模型段样本 ${bodies} 段`);
console.log(`  body 内 ≥2 张整卡：${dup} 段；其中**产线剥不动**（后一张与第一张同行）：${declined} 段`);
console.log(`  首段 1 张 + 模型段恰好 1 张（评测官那条 L1/L2 打架的形态）：${alsoOpenerPair} 段`);
