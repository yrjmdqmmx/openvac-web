import { ContentPage } from "@/components/content-page";
import { getPublicOperationsDetails } from "@/lib/public-operations";

export const dynamic = "force-dynamic";

export default function ProductPage() {
  const operations = getPublicOperationsDetails();
  const publicDetails = [
    ["运营主体", operations.operatorName],
    ["运营地址", operations.operatorAddress],
    ["联系邮箱", operations.publicContactEmail],
    ["ICP备案号", operations.icpFilingNumber],
    ["生成式 AI 备案号", operations.genAiFilingNumber]
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  return (
    <ContentPage
      eyebrow="产品透明度"
      title="OpenVac Agent V2"
      intro="面向中国大陆工程、维保和采购人员的真空泵专业问答工具。提供有依据的回答、来源引用、确定性工程计算和问题反馈入口，不替代工程定案。"
    >
      <section>
        <h2 className="text-2xl font-semibold">运行能力</h2>
        <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-[180px_1fr]">
          <dt className="text-[var(--muted)]">回答运行时</dt>
          <dd>Responses Agent；按问题自动选择快速或深度回答</dd>
          <dt className="text-[var(--muted)]">向量模型</dt>
          <dd>阿里云 text-embedding-v4，1024 维</dd>
        </dl>
      </section>
      <section>
        <h2 className="text-2xl font-semibold">能力边界</h2>
        <p className="mt-4 leading-8 text-[var(--muted)]">
          选泵、方案、故障和配件都可以提问，但 Agent V2
          不提供自动工程定案、库存价格承诺、支付下单、紧急支持或终端用户文件上传。工程计算只覆盖已验证公式，高风险问题要求停机、能源隔离，并联系设备制造商、本单位安全负责人或具备资质的现场人员。
        </p>
      </section>
      <section>
        <h2 className="text-2xl font-semibold">开源许可</h2>
        <p className="mt-4 leading-8 text-[var(--muted)]">
          网站源码以 AGPL-3.0-only
          发布。运行时密钥、用户数据、私有知识原件和备份不进入公开仓库。
        </p>
      </section>
      {publicDetails.length > 0 ? (
        <section>
          <h2 className="text-2xl font-semibold">运营信息</h2>
          <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-[180px_1fr]">
            {publicDetails.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-[var(--muted)]">{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </ContentPage>
  );
}
