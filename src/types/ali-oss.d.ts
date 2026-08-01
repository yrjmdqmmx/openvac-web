declare module "ali-oss" {
  const AlibabaOssClient: new (options: Record<string, unknown>) => unknown;

  export default AlibabaOssClient;
}
