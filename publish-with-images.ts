#!/usr/bin/env -S deno run --allow-all
/**
 * 处理文章图片并发布到微信公众号
 */

import { WeixinPublisher } from "./src/modules/publishers/weixin.publisher.ts";
import { ConfigManager } from "./src/utils/config/config-manager.ts";

// 命令行参数
const args = Deno.args;
let filePath = "";
let title = "AI趋势观察";
let author = "AI春长";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--file" && args[i + 1]) filePath = args[++i];
  else if (args[i] === "--title" && args[i + 1]) title = args[++i];
  else if (args[i] === "--author" && args[i + 1]) author = args[++i];
}

async function uploadImageToWeixin(imageUrl: string, token: string): Promise<string | null> {
  try {
    const resp = await fetch(imageUrl);
    if (!resp.ok) return null;
    
    const buffer = await resp.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const contentType = resp.headers.get("content-type") || "";
    
    const isPng = contentType.includes("png");
    const filename = isPng ? "img.png" : "img.jpg";
    const fileType = isPng ? "image/png" : "image/jpeg";
    
    const form = new FormData();
    form.append("media", new File([bytes], filename, { type: fileType }));
    
    const uploadResp = await fetch(
      `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${token}&type=image`,
      { method: "POST", body: form }
    );
    
    const data = await uploadResp.json();
    if (data.url) {
      return data.url;
    }
    return null;
  } catch (e) {
    console.log("上传图片失败:", e.message);
    return null;
  }
}

async function main() {
  await ConfigManager.getInstance().initialize();
  
  // 读取文章
  const content = await Deno.readTextFile(filePath);
  
  // 获取 token
  const publisher = new WeixinPublisher();
  const token = await (publisher as any).ensureAccessToken();
  
  // 找出所有图片 URL
  const imgRegex = /<img[^>]+src="([^"]+)"/g;
  const imgUrls = new Set<string>();
  let match;
  while ((match = imgRegex.exec(content)) !== null) {
    const url = match[1];
    if (!url.startsWith("http")) continue;
    // 跳过已经是微信的图片
    if (url.includes("mmbiz.qpic.cn")) continue;
    imgUrls.add(url);
  }
  
  console.log(`找到 ${imgUrls.size} 张图片需要处理`);
  
  // 上传图片并替换
  let newContent = content;
  for (const url of imgUrls) {
    console.log(`上传图片: ${url}`);
    const weixinUrl = await uploadImageToWeixin(url, token);
    if (weixinUrl) {
      console.log(`  -> 成功: ${weixinUrl}`);
      newContent = newContent.replace(url, weixinUrl);
    } else {
      console.log(`  -> 失败，保留原链接`);
    }
  }
  
  // 上传封面
  console.log("上传封面...");
  const coverResp = await fetch("https://i.img402.dev/rthjeuujkr.png");
  const coverBuffer = await coverResp.arrayBuffer();
  const coverForm = new FormData();
  coverForm.append("media", new File([new Uint8Array(coverBuffer)], "cover.png", { type: "image/png" }));
  const coverResp2 = await fetch(
    `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${token}&type=thumb`,
    { method: "POST", body: coverForm }
  );
  const coverData = await coverResp2.json();
  const thumbMediaId = coverData.media_id;
  console.log(`封面上传成功: ${thumbMediaId}`);
  
  // 发布
  console.log("发布文章...");
  const result = await publisher.publish(newContent, { title, author, thumbMediaId });
  
  if (result.success) {
    console.log("✅ 发布成功!");
    console.log("📋 草稿ID:", result.publishId);
  } else {
    console.error("❌ 发布失败:", result.error);
  }
}

main();
