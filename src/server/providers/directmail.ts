import { ProviderResponseError } from "./errors";
import {
  asRecord,
  loadOptionalModule,
  optionalString,
  pickString,
  requireConstructor,
  requireMethod,
  requireString,
  unwrapSdkBody
} from "./runtime";
import type {
  EmailProvider,
  EmailSendResult,
  TransactionalEmail
} from "./types";

const PROVIDER_ID = "alibaba-directmail";

export interface DirectMailOptions {
  accessKeyId?: string;
  accessKeySecret?: string;
  securityToken?: string;
  accountName?: string;
  region?: string;
  endpoint?: string;
}

export class AlibabaDirectMailProvider implements EmailProvider {
  readonly id = PROVIDER_ID;

  private readonly accessKeyId?: string;
  private readonly accessKeySecret?: string;
  private readonly securityToken?: string;
  private readonly accountName?: string;
  private readonly region: string;
  private readonly endpoint: string;

  constructor(options: DirectMailOptions = {}) {
    this.accessKeyId =
      options.accessKeyId ??
      process.env.ALIBABA_DIRECTMAIL_ACCESS_KEY_ID ??
      process.env.ALIBABA_ACCESS_KEY_ID;
    this.accessKeySecret =
      options.accessKeySecret ??
      process.env.ALIBABA_DIRECTMAIL_ACCESS_KEY_SECRET ??
      process.env.ALIBABA_ACCESS_KEY_SECRET;
    this.securityToken =
      options.securityToken ??
      process.env.ALIBABA_DIRECTMAIL_SECURITY_TOKEN ??
      process.env.ALIBABA_SECURITY_TOKEN;
    this.accountName =
      options.accountName ?? process.env.ALIBABA_DIRECTMAIL_ACCOUNT_NAME;
    this.region =
      optionalString(options.region ?? process.env.ALIBABA_DIRECTMAIL_REGION) ??
      "cn-hangzhou";
    this.endpoint =
      optionalString(
        options.endpoint ?? process.env.ALIBABA_DIRECTMAIL_ENDPOINT
      ) ?? "dm.aliyuncs.com";
  }

  async sendTransactional(
    message: TransactionalEmail
  ): Promise<EmailSendResult> {
    const recipients = (Array.isArray(message.to) ? message.to : [message.to])
      .map((address) => address.trim())
      .filter(Boolean);
    if (
      recipients.length === 0 ||
      !message.subject.trim() ||
      (!message.html && !message.text)
    ) {
      throw new ProviderResponseError(
        PROVIDER_ID,
        "Transactional email requires a recipient, subject, and HTML or text body."
      );
    }

    const sdk = loadOptionalModule(PROVIDER_ID, "@alicloud/dm20151123");
    const Client = requireConstructor(PROVIDER_ID, sdk, ["default"]);
    const Request = requireConstructor(PROVIDER_ID, sdk, [
      "SingleSendMailRequest"
    ]);
    const accessKeyId = requireString(
      PROVIDER_ID,
      "ALIBABA_DIRECTMAIL_ACCESS_KEY_ID",
      this.accessKeyId
    );
    const accessKeySecret = requireString(
      PROVIDER_ID,
      "ALIBABA_DIRECTMAIL_ACCESS_KEY_SECRET",
      this.accessKeySecret
    );
    const accountName = requireString(
      PROVIDER_ID,
      "ALIBABA_DIRECTMAIL_ACCOUNT_NAME",
      this.accountName
    );
    const client = new Client({
      accessKeyId,
      accessKeySecret,
      securityToken: this.securityToken,
      endpoint: this.endpoint,
      regionId: this.region,
      type: this.securityToken ? "sts" : "access_key"
    });
    const request = new Request({
      accountName,
      addressType: 1,
      replyToAddress: false,
      toAddress: recipients.join(","),
      subject: message.subject,
      htmlBody: message.html,
      textBody: message.text,
      tagName: message.tag
    });
    const response = await requireMethod(
      PROVIDER_ID,
      client,
      "singleSendMail"
    )(request);
    const body = unwrapSdkBody(response);
    const data = asRecord(body.data);
    const messageId =
      pickString(body, ["envId", "messageId"]) ??
      pickString(data, ["envId", "messageId"]);

    if (!messageId) {
      throw new ProviderResponseError(
        PROVIDER_ID,
        "DirectMail did not return an EnvId.",
        { retryable: true }
      );
    }
    return {
      messageId,
      requestId: pickString(body, ["requestId", "request_id"])
    };
  }
}

let singleton: EmailProvider | undefined;

export function getEmailProvider(): EmailProvider {
  singleton ??= new AlibabaDirectMailProvider();
  return singleton;
}
