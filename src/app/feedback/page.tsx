import Link from "next/link";

import { ContentPage } from "@/components/content-page";

export default function FeedbackPage() {
  return (
    <ContentPage
      eyebrow="产品问题反馈"
      title="告诉我们哪里需要改进"
      intro="请先登录并在相关回答下提交问题反馈。反馈不承诺回复或处理时限，也不提供实时、紧急或现场支持。"
    >
      <section>
        <h2 className="text-2xl font-semibold">提交问题反馈</h2>
        <p className="mt-4 leading-8 text-[var(--muted)]">
          在回答下方点击“问题反馈”，选择类型并描述问题。对话上下文默认不附带；只有你明确勾选后，服务端才会生成必要快照。联系方式完全可选，不会自动填入注册邮箱。
        </p>
        <Link
          href="/sign-in?returnTo=%2Fchat"
          className="mt-6 inline-flex h-11 items-center rounded-lg bg-[var(--ink)] px-5 text-sm font-medium text-white"
        >
          登录并开始对话
        </Link>
      </section>
      <section>
        <h2 className="text-2xl font-semibold">这不是支持渠道</h2>
        <p className="mt-4 leading-8 text-[var(--muted)]">
          此入口只用于报告回答错误、引用问题、系统故障和产品建议。涉及人身、设备或环境风险时，请执行现场应急程序，并联系设备厂家、本单位安全负责人或具备资质的现场人员。
        </p>
      </section>
    </ContentPage>
  );
}
