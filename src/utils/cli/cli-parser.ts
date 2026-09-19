import { parse } from "https://deno.land/std/flags/mod.ts";

export interface CLIOptions {
  source: string;
  publisher: string;
  title?: string;
  template?: string;
  dryRun?: boolean;
}

export class CLIParser {
  static parse(): CLIOptions {
    const args = parse(Deno.args, {
      string: ["source", "publisher", "title", "template"],
      boolean: ["dry-run"],
      default: {
        source: "FIRECRAWL",
        publisher: "WECHAT",
        template: "EJS",
      },
    });

    return {
      source: args.source,
      publisher: args.publisher,
      title: args.title,
      template: args.template,
      dryRun: args["dry-run"],
    };
  }
}