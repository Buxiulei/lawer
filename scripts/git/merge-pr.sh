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
  echo "PR 标题将改写："
  echo "  旧：$old"
  echo "  新：$title"
  gh pr edit "$pr" --title "$title"
fi

# **落地标题由 --subject 直接指定**，不靠 PR 标题。
# 【为什么不能只改 PR 标题】squash 的落地标题来源不止一处：**PR 多个提交时用 PR 标题，
# 只有一个提交时用那个提交的 subject**。本脚本第一版只做了 `gh pr edit --title`，
# 于是它在单提交 PR 上**完全不起作用**——而它自己的引入提交（8d11122）就是单提交 PR，
# 落地标题取的是提交 subject，我传进去的标题一个字都没用上。
# 一个"看起来结构化"的机制，在它自己的第一次使用上就是空的。
gh pr merge "$pr" --squash --delete-branch --subject "$title"

# 自证：合完回读 main 的首行，标题对不上就喊。
# 守卫不验自己的效果，就只是一段和问题并存的代码。
root="$(git rev-parse --show-toplevel)"
git -C "$root" fetch -q origin
landed="$(git -C "$root" log -1 --format=%s origin/main)"
expected="$title (#$pr)"
if [ "$landed" != "$expected" ]; then
  echo "⚠ 落地标题与预期不符——请人工核对后决定是否补勘误：" >&2
  echo "  预期：$expected" >&2
  echo "  实际：$landed" >&2
  exit 1
fi
echo "已合并且标题核对通过：$landed"
