import { ContentPage } from "@/components/content-page";

export default function ComplaintsPage() {
  return (
    <ContentPage
      eyebrow="法律与合规"
      title="法律投诉入口"
      intro="法律投诉与产品问题反馈分别处理。本页不会创建产品问题反馈记录，也不是紧急或现场支持渠道。"
    >
      <section>
        <h2 className="text-2xl font-semibold">上线前公示门禁</h2>
        <p className="mt-4 leading-8 text-[var(--muted)]">
          正式上线前将在此公示运营主体、法律投诉邮箱、处理规则、适用备案信息和必要的监管投诉渠道。上述信息未补齐前，OpenVac
          仅限封闭测试，不对公众正式运营。
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
