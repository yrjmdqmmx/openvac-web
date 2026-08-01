import { ContentPage } from "@/components/content-page";

export default function TermsPage() {
  return (
    <ContentPage
      eyebrow="法律与合规"
      title="OpenVac 服务协议"
      intro="以下为公开试用前的 V1 协议草案。正式上线前应由产品负责人和法律顾问完成主体、地址、争议解决和备案信息复核。"
    >
      <section>
        <h2 className="text-2xl font-semibold">服务性质</h2>
        <p className="mt-4 leading-8 text-[var(--muted)]">
          OpenVac 提供 AI
          辅助的信息检索、排查建议和来源引用。内容不能替代设备制造商要求、适用标准、现场风险评估或持证人员判断。
        </p>
      </section>
      <section>
        <h2 className="text-2xl font-semibold">使用限制</h2>
        <p className="mt-4 leading-8 text-[var(--muted)]">
          不得使用本服务绕过安全联锁、实施危险介质带压作业、攻击系统、批量滥用接口或提交无权处理的商业秘密与个人信息。
        </p>
      </section>
      <section>
        <h2 className="text-2xl font-semibold">账户与额度</h2>
        <p className="mt-4 leading-8 text-[var(--muted)]">
          普通账户每日最多获得 20
          个成功回答，按北京时间恢复。模型或检索失败会归还预占额度。异常滥用账户可能被限流或封禁。
        </p>
      </section>
      <section>
        <h2 className="text-2xl font-semibold">问题反馈</h2>
        <p className="mt-4 leading-8 text-[var(--muted)]">
          问题反馈用于改进回答、引用和产品，不构成人工咨询、紧急支持或服务工单，也不承诺回复或处理时限。涉及人身、设备或环境紧急风险时，请立即执行现场应急程序并联系有资质的专业人员。
        </p>
      </section>
    </ContentPage>
  );
}
