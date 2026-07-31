import { ContentPage } from "@/components/content-page";

export default function SourcesPage() {
  return (
    <ContentPage
      eyebrow="知识与引用"
      title="来源先分级，再进入答案"
      intro="OpenVac 不把网页标题、厂家营销材料或模型记忆直接当作工程证据。每份资料都带来源、授权类别、修订和发布时间。"
    >
      <section>
        <h2 className="text-2xl font-semibold tracking-[-0.03em]">
          可全文检索
        </h2>
        <p className="mt-4 leading-8 text-[var(--muted)]">
          仅接纳逐份核验为开放许可的 CERN 真空课程资料、无第三方版权限制的 NIST
          内容、HSE 开放许可安全资料，以及权利人明确授权商业 AI
          使用的私有手册、故障库、配件表和维修记录。
        </p>
      </section>
      <section>
        <h2 className="text-2xl font-semibold tracking-[-0.03em]">
          仅元数据与链接
        </h2>
        <p className="mt-4 leading-8 text-[var(--muted)]">
          GB/ISO 标准以及 Leybold、Pfeiffer、Edwards、Busch、Atlas Copco
          等厂家官网默认只保存标题、摘要、链接和授权状态；未取得明确授权前不全文向量化。
        </p>
      </section>
      <section>
        <h2 className="text-2xl font-semibold tracking-[-0.03em]">发布门禁</h2>
        <p className="mt-4 leading-8 text-[var(--muted)]">
          OCR
          资料必须人工复核型号、数字、小数点、单位和曲线。新修订先进入草稿，完成检索评测和引用回溯后才能发布；任何版本都可回滚。
        </p>
      </section>
    </ContentPage>
  );
}
