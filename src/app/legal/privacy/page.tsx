import { ContentPage } from "@/components/content-page";

export default function PrivacyPage() {
  return (
    <ContentPage
      eyebrow="法律与合规"
      title="OpenVac 隐私政策"
      intro="我们只收集运行账户、保存对话、执行安全审计和处理问题反馈所必要的数据。该草案须在公开上线前补齐运营主体与联系方式。"
    >
      <section>
        <h2 className="text-2xl font-semibold">收集的数据</h2>
        <p className="mt-4 leading-8 text-[var(--muted)]">
          包括邮箱、密码哈希、验证状态、会话设备信息、对话内容、引用、反馈、额度账本和安全审计记录。问题反馈默认不附带对话上下文；只有用户明确勾选时才保存必要快照。联系方式完全可选，只有用户填写并明确同意可能的后续联系时才收集。
        </p>
      </section>
      <section>
        <h2 className="text-2xl font-semibold">保存与删除</h2>
        <p className="mt-4 leading-8 text-[var(--muted)]">
          对话保存至用户删除，在线删除立即从产品界面和在线主库生效。问题反馈的目标最长保存期为
          180 天，反馈关闭 30
          天后清除可选联系方式；当前封闭测试环境的定时清理任务尚待部署验收。注销账户时会删除反馈中的可选联系方式和账户关联，只可能保留无法再识别个人的匿名汇总统计。用户可在设置中撤销会话、清空对话或注销账户。
        </p>
      </section>
      <section>
        <h2 className="text-2xl font-semibold">数据边界</h2>
        <p className="mt-4 leading-8 text-[var(--muted)]">
          当前封闭测试环境的运行数据和密钥保存在阿里云 ECS 及其隔离的 PostgreSQL
          中，不写入 GitHub 仓库。私有 OSS 备份上传和不超过 30
          天的自动过期仍是公开试用前必须完成并验证的上线门禁，不能视为当前已启用；服务器上的受限运维备份可能延迟反映在线删除。我们不要求终端用户上传图片或
          PDF。
        </p>
      </section>
    </ContentPage>
  );
}
