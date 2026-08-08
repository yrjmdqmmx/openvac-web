import { AuthShell } from "@/components/auth/auth-shell";
import { TwoFactorChallenge } from "@/components/auth/two-factor-challenge";

export default function TwoFactorPage() {
  return (
    <AuthShell
      title="两步验证"
      description="输入验证器中的动态验证码，或使用一枚尚未使用的备用码。"
    >
      <TwoFactorChallenge />
    </AuthShell>
  );
}
