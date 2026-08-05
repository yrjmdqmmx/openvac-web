import { ContentPage } from "@/components/content-page";
import { getPublicOperationsDetails } from "@/lib/public-operations";

export const dynamic = "force-dynamic";

export default function ComplaintsPage() {
  const operations = getPublicOperationsDetails();

  return (
    <ContentPage
      eyebrow="法律与合规"
      title="法律投诉入口"
      intro="法律投诉与产品问题反馈分别处理。本页不会创建产品问题反馈记录，也不是紧急或现场支持渠道。"
    >
      {operations.legalComplaintEmail ? (
        <section>
          <h2 className="text-2xl font-semibold">提交法律投诉</h2>
          <p className="mt-4 leading-8 text-[var(--muted)]">
            请将权利依据、涉及页面、必要的身份证明或授权材料发送至
            <a
              href={`mailto:${operations.legalComplaintEmail}`}
              className="mx-1 text-[var(--ink)] underline decoration-[var(--border-strong)] underline-offset-4"
            >
              {operations.legalComplaintEmail}
            </a>
            。请勿提交与投诉无关的完整对话、工况数据或其他敏感信息。
          </p>
        </section>
      ) : null}
      <section>
        <h2 className="text-2xl font-semibold">处理范围</h2>
        <p className="mt-4 leading-8 text-[var(--muted)]">
          本入口用于知识产权、隐私权、名誉权及其他法律权利相关投诉。材料将仅用于核验、处置和必要的审计记录；我们可能要求补充能够证明权利基础的最少信息。
        </p>
      </section>
      <section>
        <h2 className="text-2xl font-semibold">产品问题请走反馈入口</h2>
        <p className="mt-4 leading-8 text-[var(--muted)]">
          回答不正确、引用异常、系统故障和产品建议，请在相关回答下使用“提交问题反馈”；不要在法律投诉中附带不必要的完整对话或敏感工况数据。
        </p>
      </section>
    </ContentPage>
  );
}
