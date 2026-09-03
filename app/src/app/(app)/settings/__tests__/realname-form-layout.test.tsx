/**
 * 实名认证两条通道的**排版结构守卫**。
 *
 * 【这些断言各有多强，免得后来人高估】
 * - **结构断言（中）**：表单容器带 max-w 类、上传格数量与顺序、按钮组主次顺序、
 *   disabled 时那句缺项提示——这些都从渲染出的 HTML 里读，挡得住"有人把列宽类删了"
 *   "两格顺序反了""次按钮排到主按钮前面"。挡不住 Tailwind 没把类编进产物、
 *   也挡不住像素级的间距（本仓 vitest 是 node 环境，没有布局引擎，量不出 px）。
 * - **源码断言（弱但唯一可行）**：两条通道的文件里不许再各自写 `input[type=file]`。
 *   共用原语这件事没有运行时痕迹——两边各写一份长得一模一样的上传格，
 *   渲染结果几乎不可分辨，只有源码看得出来。
 *
 * 【身份证通道为什么没有上传格】刷脸在阿里云的 H5 页上做，我们这边只收姓名+身份证号，
 * 它压根没有照片材料。**"两条通道都 import 同一个上传格组件"在这条通道上不成立**，
 * 所以这里守的是**单一入口**：realname 相关组件里 `input[type=file]` 只许出现在
 * UploadTile 一处。哪天身份证通道真要传证件照，它 import UploadTile 就直接满足这条。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/_ui/discreet', () => ({ useDiscreet: () => ({ discreet: false }) }));

const { PassportForm, passportMissing } = await import('../_components/PassportForm');
const { IdCardForm } = await import('../_components/IdCardForm');
const { FORM_BODY, missingHint } = await import('../_components/formLayout');
const { UploadTile } = await import('@/components/UploadTile');

const src = (rel: string) =>
  readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

const passportHtml = renderToStaticMarkup(
  <PassportForm onSubmitted={() => {}} onCancel={() => {}} />,
);
const idCardHtml = renderToStaticMarkup(
  <IdCardForm
    name=""
    idCard=""
    submitting={false}
    missing={['姓名', '身份证号']}
    onNameChange={() => {}}
    onIdCardChange={() => {}}
    onSubmit={() => {}}
    onUsePassport={() => {}}
  />,
);

/** 按 DOM 顺序取出所有 <button> 的文字 */
function buttonTexts(html: string): string[] {
  return [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, '').trim(),
  );
}

describe('表单列宽：卡片全宽，表单主体不跟着撑满', () => {
  it.each([
    ['护照通道', passportHtml],
    ['身份证通道', idCardHtml],
  ])('%s 的 form 带 md:max-w-[36rem] 且手机全宽', (_label, html) => {
    const formTag = html.slice(0, html.indexOf('>') + 1);
    expect(formTag).toMatch(/^<form\b/);
    expect(formTag).toContain('md:max-w-[36rem]');
    expect(formTag).toContain('w-full');
  });

  it('两条通道用的是同一份排版常量，不是各写一遍长得像的 class', () => {
    for (const html of [passportHtml, idCardHtml]) {
      expect(html.slice(0, html.indexOf('>') + 1)).toContain(FORM_BODY);
    }
  });
});

describe('上传格', () => {
  /*
   * 顺序**要按格子的 input id 比，不能按标题文字比**：「护照资料页」这五个字
   * 在护照号那条 hint 里先出现过一次（「护照资料页右上角那串」），
   * 拿 indexOf('护照资料页') 去比，两格对调了它照样绿——第一版就是这么写的，
   * 变异 M3 当场抓到（GREEN），这行注释是那次的墓碑。
   */
  it('护照通道正好两格，顺序是资料页在前、手持自拍在后', () => {
    const tiles = [...passportHtml.matchAll(/data-upload-tile=""/g)];
    expect(tiles).toHaveLength(2);
    const order = [...passportHtml.matchAll(/id="passport-(id_page|selfie)"/g)].map(
      (m) => m[1],
    );
    expect(order).toEqual(['id_page', 'selfie']);
  });

  it('空态整格可点：格子是 label，关联的正是那一格的 file input', () => {
    for (const key of ['id_page', 'selfie']) {
      expect(passportHtml).toContain(`for="passport-${key}"`);
      expect(passportHtml).toContain(`id="passport-${key}"`);
    }
    // 孤立的小按钮已经不在了——整格才是触区
    expect(passportHtml).not.toContain('选择照片');
    expect(passportHtml).toContain('点这里选照片');
  });

  it('空态给的是可操作的一行提示，不是「请上传清晰照片」', () => {
    expect(passportHtml).toContain('四个角都拍进去');
    expect(passportHtml).toContain('脸和护照在同一张照片里');
  });
});

describe('上传格是共用原语，两处不许各写一份', () => {
  it('护照表单自己不写 input[type=file]，走 UploadTile', () => {
    const s = src('_components/PassportForm.tsx');
    expect(s).not.toContain('type="file"');
    expect(s).toContain("from '@/components/UploadTile'");
  });

  /*
   * 身份证通道现在没有照片材料（刷脸在阿里云页面上做）。守的是单一入口：
   * 它哪天要传证件照，只能 import UploadTile，不许自己再长一个 file input 出来。
   */
  it('身份证表单里没有第二份 file input', () => {
    expect(src('_components/IdCardForm.tsx')).not.toContain('type="file"');
  });

  it('实名认证这一片里，file input 只有 UploadTile 一处', () => {
    const own = ['_components/PassportForm.tsx', '_components/IdCardForm.tsx', '_components/RealnameCard.tsx']
      .filter((f) => src(f).includes('type="file"'));
    expect(own).toEqual([]);
    expect(
      readFileSync(
        path.resolve(__dirname, '../../../../components/UploadTile.tsx'),
        'utf8',
      ),
    ).toContain('type="file"');
  });
});

describe('按钮组', () => {
  it('护照通道：主按钮「提交审核」在前，次按钮「改用身份证认证」在后', () => {
    const texts = buttonTexts(passportHtml);
    expect(texts).toEqual(['提交审核', '改用身份证认证']);
  });

  it('身份证通道：主按钮「开始实名认证」在前，次按钮「改用护照认证」在后', () => {
    const texts = buttonTexts(idCardHtml);
    expect(texts).toEqual(['开始实名认证', '改用护照认证']);
  });

  it.each([
    ['护照通道', passportHtml],
    ['身份证通道', idCardHtml],
  ])('%s：次按钮是 outline，与主按钮同高（都是默认 md）', (_label, html) => {
    const buttons = [...html.matchAll(/<button\b[^>]*class="([^"]*)"[^>]*>/g)].map(
      (m) => m[1],
    );
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toContain('bg-primary'); // 主
    expect(buttons[1]).toContain('border'); // 次：outline
    expect(buttons[1]).not.toContain('bg-primary');
    for (const cls of buttons) expect(cls).toContain('h-12'); // 同高
  });

  it.each([
    ['护照通道', passportHtml],
    ['身份证通道', idCardHtml],
  ])('%s：手机上下全宽（主在上），≥sm 一行', (_label, html) => {
    const buttons = [...html.matchAll(/<button\b[^>]*class="([^"]*)"[^>]*>/g)].map(
      (m) => m[1],
    );
    for (const cls of buttons) {
      expect(cls).toContain('w-full');
      expect(cls).toContain('sm:w-auto');
    }
    expect(html).toContain('flex flex-col gap-3 sm:flex-row');
  });
});

describe('主按钮 disabled 时旁边要说清缺什么', () => {
  it('护照通道空表单：按钮禁用，且点名四样都缺', () => {
    expect(passportHtml).toMatch(/<button[^>]*\sdisabled=""[^>]*>[^<]*提交审核/);
    expect(passportHtml).toContain('还缺：姓名、护照号、护照资料页照片、手持护照自拍');
  });

  it('身份证通道空表单：按钮禁用，且点名缺姓名、身份证号', () => {
    expect(idCardHtml).toMatch(/<button[^>]*\sdisabled=""[^>]*>[^<]*开始实名认证/);
    expect(idCardHtml).toContain('还缺：姓名、身份证号');
  });

  it('缺项顺序跟着字段从上往下，不是随机的集合序', () => {
    expect(
      passportMissing({ realName: '', passportNo: '', hasIdPage: false, hasSelfie: false }),
    ).toEqual(['姓名', '护照号', '护照资料页照片', '手持护照自拍']);
  });

  it('缺一样就只说那一样，不把已经填好的也念一遍', () => {
    expect(
      passportMissing({
        realName: '张三',
        passportNo: 'E1234567',
        hasIdPage: true,
        hasSelfie: false,
      }),
    ).toEqual(['手持护照自拍']);
  });

  it('齐了就没有这句话——不留一句「都齐了」占位', () => {
    expect(missingHint([])).toBeNull();
    const ready = renderToStaticMarkup(
      <IdCardForm
        name="张三"
        idCard="11010119900307001X"
        submitting={false}
        missing={[]}
        onNameChange={() => {}}
        onIdCardChange={() => {}}
        onSubmit={() => {}}
        onUsePassport={() => {}}
      />,
    );
    expect(ready).not.toContain('还缺');
    expect(ready).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>[^<]*开始实名认证/);
  });
});

describe('说明文字：卡顶两句保留，人工审核那句成了带图标的一行 callout', () => {
  it('护照通道的人工审核说明带图标', () => {
    const at = passportHtml.indexOf('人工审核');
    expect(at).toBeGreaterThan(-1);
    // callout 那个 <p> 里有一枚 svg（图标）
    const pStart = passportHtml.lastIndexOf('<p class', at);
    const pEnd = passportHtml.indexOf('</p>', at);
    expect(passportHtml.slice(pStart, pEnd)).toContain('<svg');
  });
});

describe('低调模式：姓名/证件号/照片缩略图进糊层', () => {
  it.each([
    ['护照通道', passportHtml],
    ['身份证通道', idCardHtml],
  ])('%s：两个输入字段各自在一个 data-veil 块里', (_label, html) => {
    expect([...html.matchAll(/data-veil=""/g)]).toHaveLength(2);
  });

  it('选中照片后，缩略图与文件名也在 data-veil 块里', () => {
    const file = new File([new Uint8Array(3)], 'passport-page.jpg', { type: 'image/jpeg' });
    const html = renderToStaticMarkup(
      <UploadTile
        id="t"
        label="护照资料页"
        hint="四个角都拍进去"
        file={file}
        preview="blob:x"
        onPick={() => {}}
      />,
    );
    const at = html.indexOf('data-veil=""');
    expect(at).toBeGreaterThan(-1);
    expect(html.slice(at)).toContain('<img');
    expect(html.slice(at)).toContain('passport-page.jpg');
  });
});

describe('上传格错误态', () => {
  const html = renderToStaticMarkup(
    <UploadTile
      id="t"
      label="护照资料页"
      hint="四个角都拍进去"
      error="这张 9.1 MB，超过单张 8MB。"
      onPick={() => {}}
    />,
  );

  it('红边 + 一句原因，就落在出问题的那一格上', () => {
    expect(html).toContain('border-danger-ink');
    expect(html).toContain('text-danger-ink');
    expect(html).toContain('超过单张 8MB');
  });
});
