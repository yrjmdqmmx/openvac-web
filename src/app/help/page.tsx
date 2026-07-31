import { ContentPage } from "@/components/content-page";

export default function HelpPage() {
  return (
    <ContentPage
      eyebrow="使用帮助"
      title="把工况说清楚，答案会更可靠"
      intro="一个好问题通常包含泵型、介质、入口压力、目标压力、抽速、温度、运行时间和可观察的故障现象。"
    >
      <section>
        <h2 className="text-2xl font-semibold">推荐提问方式</h2>
        <p className="mt-4 leading-8 text-[var(--muted)]">
          例如：“某旋片泵运行 20 分钟后温度升高并伴随尖锐噪声，入口压力约 10
          mbar，油位正常，应该先检查什么？”
        </p>
      </section>
      <section>
        <h2 className="text-2xl font-semibold">不要省略的风险信息</h2>
        <p className="mt-4 leading-8 text-[var(--muted)]">
          如果涉及氧气、易燃、有毒、腐蚀、高温、电气拆修或联锁，请在第一句话写明。OpenVac
          会先给安全级停机建议，再要求型号、介质和工况并转人工。
        </p>
      </section>
    </ContentPage>
  );
}
