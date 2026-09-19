import { assertEquals } from "https://deno.land/std@0.207.0/assert/mod.ts";
import { WeixinDataSource } from "./weixin.source.ts";
import { ConfigManager } from "../../../utils/config/config-manager.ts";

Deno.test("微信数据源配置验证", () => {
  const config = ConfigManager.getInstance();
  assertEquals(!!config.get("WEIXIN_APP_ID"), true, "缺少微信应用ID");
  assertEquals(!!config.get("WEIXIN_APP_SECRET"), true, "缺少微信应用密钥");
});

Deno.test("微信AccessToken获取", async () => {
  const ds = new WeixinDataSource();
  const token = await ds['getAccessToken']();
  assertEquals(typeof token, "string", "access_token应为字符串类型");
  assertEquals(token.length > 0, true, "access_token不应为空");
});