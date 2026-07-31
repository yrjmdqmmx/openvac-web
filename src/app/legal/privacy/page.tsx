import { ContentPage } from "@/components/content-page";

export default function PrivacyPage() {
  return (
    <ContentPage
      eyebrow="法律与合规"
      title="OpenVac 隐私政策"
      intro="我们只收集运行账户、保存对话、执行安全审计和处理人工咨询所必要的数据。该草案须在公开上线前补齐运营主体与联系方式。"
    >
      <section>
        <h2 className="text-2xl font-semibold">收集的数据</h2>
        <p className="mt-4 leading-8 text-[var(--muted)]">
          包括邮箱、密码哈希、验证状态、会话设备信息、对话内容、引用、反馈、额度账本和安全审计记录。只有用户确认提交咨询时，才收集联系人、公司和联系方式。
        </p>
      </section>
      <section>
        <h2 className="text-2xl font-semibold">保存与删除</h2>
        <p className="mt-4 leading-8 text-[var(--muted)]">
          对话保存至用户删除。在线删除立即从产品界面生效；加密备份按 30
          天轮转过期。用户可在设置中撤销会话、清空对话或注销账户。
        </p>
      </section>
      <section>
        <h2 className="text-2xl font-semibold">数据边界</h2>
        <p className="mt-4 leading-8 text-[var(--muted)]">
          运行数据与密钥位于阿里云 ECS、PostgreSQL 和私有 OSS，不写入 GitHub
          仓库。我们不要求终端用户上传图片或 PDF。
        </p>
      </section>
    </ContentPage>
  );
}
