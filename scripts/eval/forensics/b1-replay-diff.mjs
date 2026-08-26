import fs from 'node:fs';
const [B, A] = ['b1-before.json','b1-after.json'].map(f => JSON.parse(fs.readFileSync(process.argv[2]+'/'+f,'utf8')));
const key = t => `${t.file}|${t.scenario}|${t.index}`;
const bm = new Map(B.turns.map(t => [key(t), t]));
console.log('汇总 before:', JSON.stringify(B.summary));
console.log('汇总 after :', JSON.stringify(A.summary));
const newFire = [], lostFire = [], changed = [];
for (const a of A.turns) {
  const b = bm.get(key(a));
  if (!b) { console.log('★ after 多出一轮（不该发生）', key(a)); continue; }
  const ba = (b.added ?? []).join('§'), aa = (a.added ?? []).join('§');
  if (ba === aa) continue;
  if (!ba && aa) newFire.push({ ...a, before: b.added, after: a.added });
  else if (ba && !aa) lostFire.push({ ...a, before: b.added, after: a.added });
  else changed.push({ ...a, before: b.added, after: a.added });
}
const show = (title, list) => {
  console.log(`\n=== ${title}：${list.length} 轮 ===`);
  for (const t of list) console.log(`  ${t.scenario} 轮${t.index}  [${t.file}]\n     修前 added=[${t.before.join('、') || '空'}]\n     修后 added=[${t.after.join('、') || '空'}]`);
};
show('★新开火（修前不补、修后补）', newFire);
show('⚠️失去开火（修前补、修后不补）——回归风险', lostFire);
show('两侧都开火但内容变了', changed);
console.log(`\n文本指纹变化轮数：${A.turns.filter(a => bm.get(key(a))?.textSha !== a.textSha).length}（应为 0：回放不改归档正文）`);
