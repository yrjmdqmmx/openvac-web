import Link from "next/link";
import { ContentPage } from "@/components/content-page";

export default function ConsultPage() {
  return (
    <ContentPage
      eyebrow="人工支持与投诉"
      title="需要人工判断时，交给真空专家"
      intro="请先登录并在相关对话下提交咨询单，这样你可以明确确认要分享的联系方式和问题摘要。"
    >
      <section>
        <h2 className="text-2xl font-semibold">提交咨询</h2>
        <p className="mt-4 leading-8 text-[var(--muted)]">
          在回答下方点击“咨询真空专家”，填写联系人、公司和一种联系方式，并勾选确认。支持人员只能看到你确认提交的内容。
        </p>
        <Link
          href="/sign-in?returnTo=%2Fchat"
          className="mt-6 inline-flex h-11 items-center rounded-lg bg-[var(--ink)] px-5 text-sm font-medium text-white"
        >
          登录并开始对话
        </Link>
      </section>
      <section>
        <h2 className="text-2xl font-semibold">投诉入口</h2>
        <p className="mt-4 leading-8 text-[var(--muted)]">
          正式上线前将在此公示运营主体、投诉邮箱、处理时限与生成式 AI
          服务备案信息。当前页面仅作为上线门禁，不代表已经公开运营。
        </p>
      </section>
    </ContentPage>
  );
}
