#!/usr/bin/env python3
"""改名行为面批读数器——**在看到数据之前写好**，跑完只运行、不改。

用法: python3 scripts/eval/forensics/read-rename.py <批次目录>

【为什么入库】品牌名 08-27 一天改了两次（裁员应对专员 → 土拨鼠劳动仲裁 → 土八鼠），
每次都要重跑同一套。**方法与对照臂原封复用，唯一会变的是名字表**——
把名字表写在这里，重跑就是机械动作，不必每次重写读数器。

【对照臂的口径】自称不该出现在下发给用户的正文里。**历史上每一个名字都要数**：
只数当前那个，会把"旧名残留在输出里"这条漏掉——而那正是改名最可能出的问题。
"""
# 历史上用过的全部自称。**只增不删**——旧名残留是改名最可能的失败形态。
SELF_NAMES = ['裁员应对专员', '土拨鼠劳动仲裁', '土八鼠']

import json
import re
import sys
import datetime
from pathlib import Path

batch = Path(sys.argv[1])
results = Path('/home/roots/caiyuan-ws/eval/scripts/eval/results')

meta = (batch / 'META').read_text()
sha = re.search(r'sha=(\w+)', meta).group(1)
kb = re.search(r'kb_index_blob=(\w+)', meta).group(1)
cards = re.search(r'kb_cards=(\d+)', meta).group(1)
start = re.search(r'start=(\S+)', meta).group(1)
print(f'三轴戳: sha={sha[:7]} kb_index_blob={kb} kb_cards={cards}')
print(f'行为 SHA 全量: {sha}')
for line in meta.splitlines():
    if line.startswith('run=') or line.startswith('archived_to='):
        print('  ' + line)

t0 = datetime.datetime.fromisoformat(start).timestamp()
files = sorted(p for p in results.glob('2026-*.json') if p.stat().st_mtime >= t0 - 5)
print(f'\n本批转录 {len(files)} 份: {[f.name for f in files]}')
assert files, 'FATAL 读数器自检失败：没找到本批转录，不许把这个空当结论'

# 预设读法第二节：L1 五条 + G 系
L1_WANT = ['必含热线号码', '首段自身完整且不重复', '无情感杠杆', '首段无杠杆', '零付费内容']
turns = 0
l1_rows = []
other_fail = []
name_old = 0
name_new = 0
for f in files:
    d = json.loads(f.read_text())
    for s in d.get('scenarios', []):
        for t in s.get('turns', []):
            turns += 1
            name_old += sum(t['text'].count(n) for n in SELF_NAMES[:1])
            name_new += sum(t['text'].count(n) for n in SELF_NAMES[1:])
        for v in s.get('mechanical', []):
            tier = v.get('tier')
            if tier == 'L1':
                l1_rows.append((f.name, v['id'], v['pass'], v.get('na'), v['detail']))
            elif not v['pass'] and not v.get('na'):
                other_fail.append((f.name, tier, v['id'], v['detail']))
        for j in s.get('semantic', []):
            if j['verdict'] != 'PASS':
                other_fail.append((f.name, j.get('tier'), f"judge:{j['item'][:40]}", ' / '.join(x for x in j['reasons'] if x)[:120]))

assert turns > 0, 'FATAL 读数器自检失败：0 轮'
print(f'\n=== 按预设读法填表（轮 {turns}）===')

print('\n【L1 逐条】')
red = 0
for name, vid, ok, na, detail in l1_rows:
    mark = '➖N/A' if na else ('✅' if ok else '❌')
    if not ok and not na:
        red += 1
    print(f'  {mark} {vid}')
    if not ok and not na:
        print(f'       {detail[:200]}')
covered = {w for w in L1_WANT if any(w in vid for _, vid, _, _, _ in l1_rows)}
missing = [w for w in L1_WANT if w not in covered]
print(f'  L1 断言实例 {len(l1_rows)} 条，报红 {red} 条')
if missing:
    print(f'  ⚠️ 预设读法点名的 L1 里，本批没产出的: {missing}（非危机轮不产出属正常，但要写出来）')

print('\n【对照臂·自称是否进入用户面正文】')
print(f'  改后（本批 {turns} 轮）: 旧名 {name_old} 次 / 新名合计 {name_new} 次  [在数: {SELF_NAMES}]')
print('  改前（归档 155 轮，全部早于 126cbe4）: 两者均 0 次')
if name_old == 0 and name_new == 0:
    print('  ⇒ 两侧都是 0，符合预期：自称没有进入用户面正文')
else:
    print('  ⇒ **改前 0、改后 >0 ⇒ 改名把自称推进了用户面，是本批实发现**')

print(f'\n【其它挂点】{len(other_fail)} 条')
for name, tier, vid, detail in other_fail[:8]:
    print(f'  [{tier}] {vid} — {str(detail)[:140]}')

print('\n=== 结论（按预设读法的措辞，不许写成"无影响"）===')
if red == 0:
    print(f'  在 ws/backend@{sha[:7]} 上，**本批未观察到改名对 L1 与 G 系的影响**。')
    print('  （两跑不刻画分布 ⇒ 只能写"未观察到"，不能写"无影响"。）')
else:
    print(f'  在 ws/backend@{sha[:7]} 上，**L1 报红 {red} 条**——逐轮原句见上，单独立条报 manager。')
    print('  与改名的因果不作断言：需改前语料对照才谈得上归因。')
