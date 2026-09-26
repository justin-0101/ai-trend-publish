import { Media } from "../../../modules/interfaces/scraper.interface.ts";

export interface GeneratedTemplate {
  id: string;
  title: string;
  /** 深度文用的副标题/导语；摘要合集类模板不用，缺省不渲染 */
  subtitle?: string;
  /** 刊头名，模板里用 <%= brand %> 取值 */
  brand?: string;
  /** 刊头副标，模板里用 <%= tagline %> 取值 */
  tagline?: string;
  content: string;
  url: string;
  publishDate: string;
  metadata: Record<string, any>;
}

export interface WeixinTemplate extends GeneratedTemplate {
  keywords: string[];
  media?: Media[];
}
