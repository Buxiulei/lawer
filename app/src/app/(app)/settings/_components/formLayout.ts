/**
 * 实名认证两条通道（身份证刷脸 / 护照人工审核）共用的表单排版。
 *
 * 【为什么收成常量，而不是两个文件各写一遍 class】这两条通道是**同一张卡里的两个分支**，
 * 用户在它们之间来回切；哪一边的列宽、字段间距、按钮排布走样了，切过去就是一次"页面变了形"。
 * 而这种走样是静默的——tsc 绿、测试也绿，只有人眼看得出来。所以排版收成一处，
 * 结构判据钉在这一处（realname-form-layout.test.tsx）。
 *
 * 【列宽 36rem 的由来】卡片本身是全宽（≥850px），输入框跟着撑满时，
 * 一行输入框宽得跟一整段正文一样，光标落点和标签隔着半屏，读写都费劲。
 * 表单主体锁 36rem（576px）左对齐、卡片保持全宽：手机上 `md:` 不生效，仍是全宽。
 *
 * 【按钮组为什么左对齐】仓内 `justify-end` 只出现在弹窗/面板的 footer
 * （shadcn 的 dialog / alert-dialog、案件页 DropPanel、GraphCanvas 的浮层）；
 * **页面内的表单一律左对齐**（settings 各卡、身份证通道原样）。跟着页面那一档走。
 */

/** 表单主体：手机全宽，≥md 锁 36rem 左对齐。分区之间 32px。 */
export const FORM_BODY = 'flex w-full flex-col gap-8 md:max-w-[36rem]';

/** 一个字段分区：字段与字段之间 20px（标签-输入 8px 在 Field 里定） */
export const FORM_FIELDS = 'flex flex-col gap-5';

/** 底部按钮组：手机上下全宽（主在上），≥sm 一行左对齐 */
export const FORM_ACTIONS = 'flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center';

/** 按钮组里的按钮：手机全宽，≥sm 按内容宽 */
export const FORM_ACTION_BUTTON = 'w-full sm:w-auto';

/**
 * 主按钮 disabled 时旁边那句灰字。**禁用的按钮不解释自己为什么禁用，就是一堵没有门的墙**——
 * 用户看得见"提交审核"是灰的，却不知道是姓名没填还是照片没传，只能挨个回去猜。
 * 齐了返回 null（不留一句"都齐了"的废话占位）。
 */
export function missingHint(missing: string[]): string | null {
  return missing.length > 0 ? `还缺：${missing.join('、')}` : null;
}
