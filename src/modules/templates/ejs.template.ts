import { Template, TemplateData } from "./interfaces/template.interface.ts";
import { renderFile } from "https://deno.land/x/dejs/mod.ts";
import { ConfigManager } from "../../utils/config/config-manager.ts";
import { join } from "https://deno.land/std/path/mod.ts";

export class EJSTemplate implements Template {
  name = "EJS";
  private configManager: ConfigManager;

  constructor() {
    this.configManager = ConfigManager.getInstance();
  }

  async render(data: TemplateData): Promise<string> {
    const templatePath = await this.configManager.get<string>("TEMPLATE_PATH");
    const fullPath = join(templatePath, "article.ejs");
    return await renderFile(fullPath, data);
  }
}