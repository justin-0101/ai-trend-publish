import { Template } from "./interfaces/template.interface.ts";
import { EJSTemplate } from "./ejs.template.ts";

export class TemplateFactory {
  private static instance: TemplateFactory;
  private templates: Map<string, Template> = new Map();

  private constructor() {}

  public static getInstance(): TemplateFactory {
    if (!TemplateFactory.instance) {
      TemplateFactory.instance = new TemplateFactory();
    }
    return TemplateFactory.instance;
  }

  public getTemplate(templateName: string): Template {
    if (this.templates.has(templateName)) {
      return this.templates.get(templateName)!;
    }

    const template = this.createTemplate(templateName);
    this.templates.set(templateName, template);
    return template;
  }

  private createTemplate(templateName: string): Template {
    switch (templateName.toUpperCase()) {
      case "EJS":
        return new EJSTemplate();
      default:
        throw new Error(`不支持的模板引擎: ${templateName}`);
    }
  }
}