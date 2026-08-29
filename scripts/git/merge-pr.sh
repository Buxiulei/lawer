#!/usr/bin/env bash
# 合并一个 PR，**标题是必填参数**。
#
# 【为什么要有这个脚本】squash 合并用的是 **PR 标题**，不是分支上那些提交的标题。
# 于是「开 PR 时写的标题」会原样变成 main 的历史，而开 PR 那一刻的措辞常常
# 已经过期（"待某某落地后合"、"WIP"、"v4" 而内容早换成了 v6）。
#
# 这个错我犯过两次：
#   a559a81 标题写「矢量稿 v4 入库」，实际入库的是 v6；
#   056cf8c 标题挂「待端点落地后合」，而合并时端点早已落地、联调也过了。
# 第一次之后我把「合并前 gh pr edit --title」写进了检查表——**第二次照样漏**。
# **检查表放在脑子里就不算流程。** 所以把它变成结构上做不到：
# 不给标题就没法调用这个脚本，标题必然是合并那一刻重新说出来的。
set -euo pipefail

if [ $# -lt 2 ]; then
  cat >&2 <<'USAGE'
用法：scripts/git/merge-pr.sh <PR号> "<最终标题>"

标题是必填的——它会成为 main 上那条 squash 提交的标题。
合并前先问自己：这个标题描述的是**现在这份改动**，还是开 PR 那天的想法？
USAGE
  exit 2
fi

pr="$1"; title="$2"
old="$(gh pr view "$pr" --json title --jq .title)"
state="$(gh pr view "$pr" --json state --jq .state)"

[ "$state" = "OPEN" ] || { echo "PR #$pr 状态是 $state，不是 OPEN，不合。" >&2; exit 1; }

if [ "$old" != "$title" ]; then
  echo "标题将改写："
  echo "  旧：$old"
  echo "  新：$title"
  gh pr edit "$pr" --title "$title"
else
  echo "标题未变：$title"
fi

gh pr merge "$pr" --squash --delete-branch
echo "已合。main = $(git -C "$(git rev-parse --show-toplevel)" rev-parse --short HEAD 2>/dev/null || echo '(需 git pull)')"
