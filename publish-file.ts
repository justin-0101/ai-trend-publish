#!/usr/bin/env -S deno run --allow-all
/**
 * 直接发布文章到微信公众号
 * 用法：deno run --allow-all publish-file.ts --file <文章文件路径> --title <标题> --cover <封面图 URL>
 */

import { WeixinPublisher } from "./src/modules/publishers/weixin.publisher.ts";
import { ConfigManager } from "./src/utils/config/config-manager.ts";

// 简单的命令行参数解析
const args = Deno.args;
let filePath = "";
let title = "AI 趋势观察";
let coverUrl = "";
let author = "AI 春长";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--file" && args[i + 1]) {
    filePath = args[i + 1];
    i++;
  } else if (args[i] === "--title" && args[i + 1]) {
    title = args[i + 1];
    i++;
  } else if (args[i] === "--cover" && args[i + 1]) {
    coverUrl = args[i + 1];
    i++;
  } else if (args[i] === "--author" && args[i + 1]) {
    author = args[i + 1];
    i++;
  }
}

if (!filePath) {
  console.error("用法：deno run --allow-all publish-file.ts --file <文章文件路径> --title <标题> --cover <封面图 URL> --author <作者>");
  Deno.exit(1);
}

async function main() {
  console.log("📝 初始化配置...");
  await ConfigManager.getInstance().initialize();
  
  // 读取文章内容
  console.log("📖 读取文章文件:", filePath);
  const content = await Deno.readTextFile(filePath);
  
  // 创建发布器
  console.log("🔧 创建微信发布器...");
  const publisher = new WeixinPublisher();
  
  // 验证配置
  try {
    await publisher.validateConfig();
  } catch (error) {
    console.error("❌ 配置验证失败:", error.message);
    Deno.exit(1);
  }
  
  // 先上传封面图
  console.log("🖼️ 上传封面图...");
  let thumbMediaId = "";
  try {
    // 获取 access_token
    const token = await (publisher as any).ensureAccessToken();
    
    // 使用本地封面图
    const coverPath = "/tmp/cover.png";
    const coverData = await Deno.readFile(coverPath);
    
    const form = new FormData();
    form.append("media", new File([coverData], "cover.png", { type: "image/png" }));
    
    const uploadResp = await fetch(
      `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${token}&type=image`,
      { method: "POST", body: form }
    );
    
    const uploadData = await uploadResp.json();
    
    if (uploadData.errcode && uploadData.errcode !== 0) {
      console.log("⚠️ 封面上传失败:", uploadData.errmsg);
    } else {
      thumbMediaId = uploadData.media_id;
      console.log("✅ 封面上传成功，media_id:", thumbMediaId);
    }
  } catch (error) {
    console.log("⚠️ 封面上传失败:", error.message);
  }
  
  // 发布文章
  console.log("🚀 开始发布到微信公众号...");
  
  const result = await publisher.publish(content, {
    title: title,
    author: author,
    thumbMediaId: thumbMediaId
  });
  
  if (result.success) {
    console.log("✅ 发布成功!");
    console.log("📋 草稿 ID:", result.publishId);
    console.log("📌 状态:", result.status);
  } else {
    console.error("❌ 发布失败:", result.error);
    Deno.exit(1);
  }
}

main();
