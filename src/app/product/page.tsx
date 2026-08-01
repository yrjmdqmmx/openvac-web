import { ContentPage } from "@/components/content-page";

export default function ProductPage() {
  const filingNumber =
    process.env.GEN_AI_FILING_NUMBER?.trim() || "公开试用前补充备案号";

  return (
    <ContentPage
      eyebrow="产品透明度"
      title="OpenVac Web V1"
      intro="面向中国大陆工程、维保和采购人员的真空泵专业问答工具。V1 提供有依据的回答、来源引用和问题反馈入口，不替代工程定案。"
    >
      <section>
        <h2 className="text-2xl font-semibold">基础模型</h2>
        <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-[180px_1fr]">
          <dt className="text-[var(--muted)]">首发回答模型</dt>
          <dd>DeepSeek V4 Flash（服务端标识 deepseek-v4-flash）</dd>
          <dt className="text-[var(--muted)]">向量模型</dt>
          <dd>阿里云 text-embedding-v4，1024 维</dd>
          <dt className="text-[var(--muted)]">生成式 AI 备案号</dt>
          <dd>{filingNumber}</dd>
        </dl>
      </section>
      <section>
        <h2 className="text-2xl font-semibold">能力边界</h2>
        <p className="mt-4 leading-8 text-[var(--muted)]">
          选泵、方案、故障和配件都可以提问，但 V1
          不提供自动工程定案、确定性计算器、库存价格、支付下单、紧急支持或终端用户文件上传。高风险问题只提供停机、隔离与检查建议，并要求联系设备制造商或现场合格人员。
        </p>
      </section>
      <section>
        <h2 className="text-2xl font-semibold">开源许可</h2>
        <p className="mt-4 leading-8 text-[var(--muted)]">
          网站源码以 AGPL-3.0-only
          发布。运行时密钥、用户数据、私有知识原件和备份不进入公开仓库。
        </p>
      </section>
    </ContentPage>
  );
}
