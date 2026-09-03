/**
 * 护照实名通道。这条通道的用户是**没有中国大陆身份证的人**——
 * 原来的卡片对他们是一堵没有门的墙：走不下去，也看不到为什么。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/app/_ui/api';

vi.mock('@/app/_ui/discreet', () => ({ useDiscreet: () => ({ discreet: false }) }));

const { passportReady, submitFailureCopy, PassportForm } = await import(
  '../_components/PassportForm'
);
const { Pending } = await import('../_components/RealnameCard');

const err = (code: string) => new ApiError(code, '后端原话', 400);
const text = (html: string) => html.replace(/<[^>]+>/g, '');

describe('提交条件', () => {
  const full = { realName: '张三', passportNo: 'E12345678', hasIdPage: true, hasSelfie: true };

  it('四样齐了才能提交', () => {
    expect(passportReady(full)).toBe(true);
  });

  it.each([
    ['姓名空', { realName: '  ' }],
    ['护照号空', { passportNo: '' }],
    ['缺资料页', { hasIdPage: false }],
    ['缺手持自拍', { hasSelfie: false }],
  ])('缺一样就不能提交：%s', (_label, patch) => {
    expect(passportReady({ ...full, ...patch })).toBe(false);
  });

  /*
   * **这条是刻意的产品决定，不是漏写校验。**
   * 各国护照号规则不一：纯数字的、字母数字混的、长度 6–9 不等。
   * 前端写正则必然误拒一部分真实护照，而**误拒的代价是用户被自己的证件挡在门外，
   * 且他没有申诉入口**。格式判断交给后端（它有 INVALID_PASSPORT_NO）。
   */
  it('不按格式拦护照号——各国规则不一，前端正则必然误拒真护照', () => {
    for (const no of ['12345678', 'E1234567', 'AB123456', 'X1', 'P123456789012345']) {
      expect(passportReady({ ...full, passportNo: no })).toBe(true);
    }
  });
});

describe('错误码文案', () => {
  it.each([
    ['INVALID_PASSPORT_NO', '护照号'],
    ['MISSING_MATERIAL', '两张照片'],
    ['INVALID_NAME', '姓名'],
    ['ALREADY_VERIFIED', '已经实名过了'],
    ['MATERIAL_TOO_LARGE', '8MB'],
  ])('%s 说清楚该改哪儿', (code, needle) => {
    expect(submitFailureCopy(err(code))).toContain(needle);
  });

  it('每个码各说各的，不共用一句万能话', () => {
    const codes = [
      'INVALID_PASSPORT_NO',
      'MISSING_MATERIAL',
      'INVALID_NAME',
      'ALREADY_VERIFIED',
      'MATERIAL_TOO_LARGE',
    ];
    const copies = codes.map((c) => submitFailureCopy(err(c)));
    expect(new Set(copies).size).toBe(codes.length);
  });

  it('服务端故障要明说是我们的问题，并告诉他照片不用重选', () => {
    // 端点没上（404）或 5xx：用户刚交完照片，看到「这一步没成功」只会怀疑自己的证件
    for (const status of [404, 500, 502]) {
      const copy = submitFailureCopy(new ApiError('SOMETHING_ELSE', '原话', status));
      expect(copy).toContain('是我们的问题');
      expect(copy).toContain('照片不用重选');
    }
  });

  it('用户能自己改的那四类，不许甩锅给自己人', () => {
    for (const code of ['INVALID_PASSPORT_NO', 'MISSING_MATERIAL', 'INVALID_NAME']) {
      expect(submitFailureCopy(err(code))).not.toContain('是我们的问题');
    }
  });

  it('不把后端原话直接甩给用户', () => {
    expect(submitFailureCopy(err('INVALID_PASSPORT_NO'))).not.toContain('后端原话');
  });
});

describe('表单初始渲染', () => {
  const html = renderToStaticMarkup(
    <PassportForm onSubmitted={() => {}} onCancel={() => {}} />,
  );
  const t = text(html);

  it('说明白这是人工审核，不是刷脸那种马上出结果', () => {
    expect(t).toContain('人工审核');
  });

  it('两张照片的指引是可操作的，不是「请上传清晰照片」', () => {
    expect(t).toContain('四个角都拍进去'); // 资料页
    expect(t).toContain('脸和护照在同一张照片里'); // 手持自拍
  });

  it('提交键默认禁用——四样没齐不给点', () => {
    // `disabled=""` 要连等号一起钉：按钮 class 里本就有 disabled:pointer-events-none，
    // 松正则（/[^>]*disabled[^>]*/）在属性被删掉之后照样绿。
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>[^<]*提交审核/);
  });

  it('留了回到身份证通道的路', () => {
    expect(t).toContain('用身份证认证');
  });
});

describe('待审文案按通道分支', () => {
  const render = (method: 'cloudauth' | 'passport' | null) =>
    text(
      renderToStaticMarkup(
        <Pending
          message="认证进行中"
          method={method}
          certifyUrl={null}
          exhausted={false}
          onRefresh={() => {}}
          onRestart={() => {}}
        />,
      ),
    );

  it('护照：说人工审核与时长，给刷新', () => {
    const t = render('passport');
    expect(t).toContain('人工审核');
    expect(t).toContain('一到两个工作日');
    expect(t).toContain('刷新审核结果');
  });

  /*
   * 交完护照材料的人如果看到「手机上做完之后…」，会以为自己还漏了一步没做——
   * 而他根本没有那一步可做。这是最容易回归的一处：两条通道共用一个待审分支就会这样。
   */
  it('护照：**不许**出现刷脸那套话', () => {
    const t = render('passport');
    expect(t).not.toContain('手机上做完');
    expect(t).not.toContain('人脸核验');
    expect(t).not.toContain('重新填一次');
  });

  it('刷脸：仍是原来那套，没被护照分支带偏', () => {
    const t = render('cloudauth');
    expect(t).toContain('认证进行中'); // 正对照：走的是 message 那条路
    expect(t).toContain('手机上做完');
    expect(t).toContain('重新填一次');
  });

  it('method 缺失时按刷脸渲染——老数据没有这个字段，不能因此白屏', () => {
    expect(render(null)).toContain('手机上做完');
  });
});

/**
 * 被人工审核打回之后。**这是最需要正确指引的时刻**——
 * 拿护照的人若被送回身份证通道，会读到「身份证号要与本人证件完全一致、
 * 光线足一点再刷一次」这种他根本无法执行的建议。
 */
describe('审核未通过', () => {
  const html = renderToStaticMarkup(
    <PassportForm onSubmitted={() => {}} onCancel={() => {}} rejectedMessage="资料页反光看不清" />,
  );
  const t = text(html);

  it('把后端给的原因原样带出来', () => {
    expect(t).toContain('资料页反光看不清');
  });

  it('给的是能执行的重拍指引，不是「请重新提交」', () => {
    expect(t).toContain('把护照放平');
    expect(t).toContain('避开顶灯');
  });

  /*
   * 断言要挑**身份证通道那套建议**，不是「身份证」三个字——
   * 表单底下那个「用身份证认证」是**回到另一条通道的出路**，是正当的。
   * 第一版写成 not.toContain('身份证') 当场误伤了它：
   * 守卫拦的必须是有害的那句话，不是碰巧同字的那个词。
   */
  it('不出现身份证通道那套建议——他没有身份证，那些他做不到', () => {
    expect(t).not.toContain('身份证号要与本人证件完全一致');
    expect(t).not.toContain('光线足一点再刷一次');
  });

  it('但回到身份证通道的出路要留着（万一他其实两样都有）', () => {
    expect(t).toContain('用身份证认证');
  });

  it('没被打回时不显示这块，不制造无谓的警报', () => {
    const clean = text(
      renderToStaticMarkup(<PassportForm onSubmitted={() => {}} onCancel={() => {}} />),
    );
    expect(clean).not.toContain('上一次没通过');
  });
});
