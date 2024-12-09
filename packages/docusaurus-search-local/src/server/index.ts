import fs from "fs";
import path from "path";
import util from "util";
import type {
  LoadContext,
  LoadedPlugin,
  OptionValidationContext,
  Plugin,
} from "@docusaurus/types";
import type { LoadedContent as DocsLoadedContent } from "@docusaurus/plugin-content-docs";
import type { PluginOptions as DocsOptions } from "@docusaurus/plugin-content-docs";
import type { BlogContent as BlogLoadedContent } from "@docusaurus/plugin-content-blog";
import type { PluginOptions as BlogOptions } from "@docusaurus/plugin-content-blog";
import type { LoadedContent as PagesLoadedContent } from "@docusaurus/plugin-content-pages";
import type { PluginOptions as PagesOptions } from "@docusaurus/plugin-content-pages";
import { Joi } from "@docusaurus/utils-validation";
import type { DSLAPluginData, MyDocument } from "../types";
import { html2text, getDocusaurusTag } from "./parse";
import logger from "./logger";

const lunr = require("../lunr.js") as (
  config: import("lunr").ConfigFunction,
) => import("lunr").Index;

const readFileAsync = util.promisify(fs.readFile);
const writeFileAsync = util.promisify(fs.writeFile);

function urlMatchesPrefix(url: string, prefix: string) {
  if (prefix.startsWith("/")) {
    throw new Error(
      `prefix must not start with a /. This is a bug (url: "${url}", prefix: ${prefix}).`,
    );
  }
  if (prefix.endsWith("/")) {
    throw new Error(
      `prefix must not end with a /. This is a bug (url: "${url}", prefix: ${prefix}).`,
    );
  }
  return prefix === "" || url === prefix || url.startsWith(`${prefix}/`);
}

function trimLeadingSlash(path: string) {
  if (!path || !path.startsWith("/")) {
    return path;
  }
  return path.slice(1);
}

function trimTrailingSlash(path: string) {
  if (!path || !path.endsWith("/")) {
    return path;
  }
  return path.slice(0, -1);
}

// Copied from Docusaurus, licensed under the MIT License.
// https://github.com/facebook/docusaurus/blob/63bd6b9025be282b50adbc65176598c96fd4f7e9/packages/docusaurus-theme-translations/src/index.ts#L20-L36
function codeTranslationLocalesToTry(locale: string): string[] {
  const intlLocale = Intl.Locale ? new Intl.Locale(locale) : undefined;
  if (!intlLocale) {
    return [locale];
  }
  // if locale is just a simple language like "pt", we want to fallback to pt-BR (not pt-PT!)
  // see https://github.com/facebook/docusaurus/pull/4536#issuecomment-810088783
  if (intlLocale.language === locale) {
    const maximizedLocale = intlLocale.maximize(); // pt-Latn-BR`
    // ["pt","pt-BR"]
    return [locale, `${maximizedLocale.language}-${maximizedLocale.region}`];
  }
  // if locale is like "pt-BR", we want to fallback to "pt"
  else {
    return [locale, intlLocale.language!];
  }
}

type MyOptions = {
  indexDocs: boolean;
  indexDocSidebarParentCategories: number;
  includeParentCategoriesInPageTitle: boolean;
  indexBlog: boolean;
  indexPages: boolean;
  language: string | string[];
  style?: "none";
  maxSearchResults: number;
  filterByPathName: boolean;
  subPath: number;
  lunr: {
    tokenizerSeparator?: string;
    k1: number;
    b: number;
    titleBoost: number;
    contentBoost: number;
    tagsBoost: number;
    parentCategoriesBoost: number;
  };
};

const languageSchema = Joi.string().valid(
  "ar",
  "da",
  "de",
  "en",
  "es",
  "fi",
  "fr",
  "hi",
  "hu",
  "it",
  "ja",
  "nl",
  "no",
  "pt",
  "ro",
  "ru",
  "sv",
  "th",
  "tr",
  "vi",
  "zh",
);

const optionsSchema = Joi.object({
  indexDocs: Joi.boolean().default(true),
  indexDocSidebarParentCategories: Joi.number()
    .integer()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(0),

  includeParentCategoriesInPageTitle: Joi.boolean().default(false),

  indexBlog: Joi.boolean().default(true),

  indexPages: Joi.boolean().default(false),

  language: Joi.alternatives(
    languageSchema,
    Joi.array().items(languageSchema),
  ).default("en"),

  style: Joi.string().valid("none"),

  maxSearchResults: Joi.number().integer().min(1).default(8),

  filterByPathName: Joi.boolean().default(false),

  subPath: Joi.number().integer().min(-1).default(-1),

  lunr: Joi.object({
    tokenizerSeparator: Joi.object().regex(),
    b: Joi.number().min(0).max(1).default(0.75),
    k1: Joi.number().min(0).default(1.2),
    titleBoost: Joi.number().min(0).default(5),
    contentBoost: Joi.number().min(0).default(1),
    tagsBoost: Joi.number().min(0).default(3),
    parentCategoriesBoost: Joi.number().min(0).default(2),
  }).default(),
});

export default function cmfcmfDocusaurusSearchLocal(
  context: LoadContext,
  options: MyOptions,
): Plugin<unknown> {
  let {
    indexDocSidebarParentCategories,
    includeParentCategoriesInPageTitle,
    indexBlog,
    indexDocs,
    indexPages,
    language,
    style,
    maxSearchResults,
    filterByPathName,
    subPath,
    lunr: {
      tokenizerSeparator: lunrTokenizerSeparator,
      k1,
      b,
      titleBoost,
      contentBoost,
      tagsBoost,
      parentCategoriesBoost,
    },
  } = options;

  if (lunrTokenizerSeparator) {
    // @ts-expect-error
    lunr.tokenizer.separator = lunrTokenizerSeparator;
  }

  if (Array.isArray(language) && language.length === 1) {
    language = language[0]!;
  }

  let generated =
    "// THIS FILE IS AUTOGENERATED\n" + "// DO NOT EDIT THIS FILE!\n\n";

  if (style !== "none") {
    generated += 'import "@algolia/autocomplete-theme-classic";\n';
    generated += 'import "./index.css";\n';
  }

  generated += 'const lunr = require("../../../lunr.js");\n';

  function handleLangCode(code: string) {
    let generated = "";

    if (code === "jp") {
      throw new Error(`Language "jp" is deprecated, please use "ja".`);
    }

    if (code === "ja") {
      require("lunr-languages/tinyseg")(lunr);
      generated += `require("lunr-languages/tinyseg")(lunr);\n`;
    } else if (code === "th" || code === "hi") {
      // @ts-expect-error see
      // https://github.com/MihaiValentin/lunr-languages/blob/a62fec97fb1a62bb4581c9b69a5ddedf62f8f62f/test/VersionsAndLanguagesTest.js#L110-L112
      lunr.wordcut = require("lunr-languages/wordcut");
      generated += `lunr.wordcut = require("lunr-languages/wordcut");\n`;
    }
    require(`lunr-languages/lunr.${code}`)(lunr);
    generated += `require("lunr-languages/lunr.${code}")(lunr);\n`;

    return generated;
  }

  if (language !== "en") {
    require("lunr-languages/lunr.stemmer.support")(lunr);
    generated += 'require("lunr-languages/lunr.stemmer.support")(lunr);\n';
    if (Array.isArray(language)) {
      language
        .filter((code) => code !== "en")
        .forEach((code) => {
          generated += handleLangCode(code);
        });
      require("lunr-languages/lunr.multi")(lunr);
      generated += `require("lunr-languages/lunr.multi")(lunr);\n`;
    } else {
      generated += handleLangCode(language);
    }
  }
  if (language === "zh") {
    // nodejieba does not run in the browser, so we need to use a custom tokenizer here.
    // FIXME: We should look into compiling nodejieba to WebAssembly and use that instead.
    generated += `\
export const tokenize = (input) => input.trim().toLowerCase()
  .split(${(lunrTokenizerSeparator
    ? lunrTokenizerSeparator
    : /[\s\-]+/
  ).toString()})
  .filter(each => !!each);\n`;
  } else if (language === "ja" || language === "th") {
    if (lunrTokenizerSeparator) {
      throw new Error(
        "The lunr.tokenizerSeparator option is not supported for 'ja' and 'th'",
      );
    }
    generated += `\
export const tokenize = (input) => lunr[${JSON.stringify(
      language,
    )}].tokenizer(input)
  .map(token => token${language === "th" ? "" : ".str"});\n`;
  } else {
    if (lunrTokenizerSeparator) {
      generated += `\
lunr.tokenizer.separator = ${lunrTokenizerSeparator.toString()};\n`;
    }
    generated += `\
export const tokenize = (input) => lunr.tokenizer(input)
  .map(token => token.str);\n`;
  }
  generated += `export const mylunr = lunr;\n`;

  return {
    name: "@cmfcmf/docusaurus-search-local",
    getThemePath() {
      return path.resolve(__dirname, "..", "..", "lib", "client", "theme");
    },
    getTypeScriptThemePath() {
      return path.resolve(__dirname, "..", "..", "src", "client", "theme");
    },
    getDefaultCodeTranslationMessages: async () => {
      const translationsDir = path.resolve(
        __dirname,
        "..",
        "..",
        "codeTranslations",
      );
      const localesToTry = codeTranslationLocalesToTry(
        context.i18n.currentLocale,
      );
      for (const locale of localesToTry) {
        const translationPath = path.join(translationsDir, `${locale}.json`);
        if (fs.existsSync(translationPath)) {
          return JSON.parse(
            await fs.promises.readFile(translationPath, "utf8"),
          );
        }
      }

      return {};
    },
    async contentLoaded({ actions: { setGlobalData } }) {
      const data: DSLAPluginData = {
        titleBoost,
        contentBoost,
        tagsBoost,
        parentCategoriesBoost,
        indexDocSidebarParentCategories,
        maxSearchResults,
        filterByPathName,
        subPath,
      };
      setGlobalData(data);
    },
    async postBuild({
      routesPaths = [],
      outDir,
      baseUrl,
      siteConfig: { trailingSlash },
      plugins,
    }) {
      logger.info("Gathering documents");

      function buildPluginMap<Options, Content>(name: string) {
        return new Map(
          plugins
            .filter((plugin) => plugin.name === name)
            .map((plugin) => [plugin.options.id, plugin]) as Array<
            [string, LoadedPlugin & { content: Content; options: Options }]
          >,
        );
      }

      const docsPlugins = buildPluginMap<DocsOptions, DocsLoadedContent>(
        "docusaurus-plugin-content-docs",
      );
      const blogPlugins = buildPluginMap<BlogOptions, BlogLoadedContent>(
        "docusaurus-plugin-content-blog",
      );
      const pagesPlugins = buildPluginMap<PagesOptions, PagesLoadedContent>(
        "docusaurus-plugin-content-pages",
      );

      if (indexDocs && docsPlugins.size === 0) {
        throw new Error(
          'The "indexDocs" option is enabled but no docs plugin has been found.',
        );
      }
      if (indexBlog && blogPlugins.size === 0) {
        throw new Error(
          'The "indexBlog" option is enabled but no blog plugin has been found.',
        );
      }
      if (indexPages && pagesPlugins.size === 0) {
        throw new Error(
          'The "indexPages" option is enabled but no pages plugin has been found.',
        );
      }

      const data = routesPaths
        .flatMap((url) => {
          // baseUrl includes the language prefix, thus `route` will be language-agnostic.
          const route = url.substring(baseUrl.length);
          if (!url.startsWith(baseUrl)) {
            throw new Error(
              `The route must start with the baseUrl ${baseUrl}, but was ${route}. This is a bug, please report it.`,
            );
          }
          if (route === "404.html") {
            // Do not index error page.
            return [];
          }
          if (indexDocs) {
            for (const docsPlugin of docsPlugins.values()) {
              const docsBasePath = trimLeadingSlash(
                trimTrailingSlash(docsPlugin.options.routeBasePath),
              );
              const docsTagsPath = trimLeadingSlash(
                trimTrailingSlash(docsPlugin.options.tagsBasePath),
              );

              if (urlMatchesPrefix(route, docsBasePath)) {
                if (
                  urlMatchesPrefix(
                    route,
                    trimLeadingSlash(`${docsBasePath}/${docsTagsPath}`),
                  ) ||
                  urlMatchesPrefix(
                    route,
                    trimLeadingSlash(`${docsBasePath}/__docusaurus`),
                  )
                ) {
                  // Do not index tags filter pages and pages generated by the debug plugin
                  return [];
                }
                return {
                  route,
                  url,
                  type: "docs" as const,
                };
              }
            }
          }
          if (indexBlog) {
            for (const blogPlugin of blogPlugins.values()) {
              const blogBasePath = trimLeadingSlash(
                trimTrailingSlash(blogPlugin.options.routeBasePath),
              );
              const blogTagsPath = trimLeadingSlash(
                trimTrailingSlash(blogPlugin.options.tagsBasePath),
              );

              if (urlMatchesPrefix(route, blogBasePath)) {
                if (
                  route === blogBasePath ||
                  urlMatchesPrefix(
                    route,
                    trimLeadingSlash(`${blogBasePath}/${blogTagsPath}`),
                  ) ||
                  urlMatchesPrefix(
                    route,
                    trimLeadingSlash(`${blogBasePath}/__docusaurus`),
                  )
                ) {
                  // Do not index list of blog posts, tags filter pages, and pages generated by the debug plugin
                  return [];
                }
                return {
                  route,
                  url,
                  type: "blog" as const,
                };
              }
            }
          }
          if (indexPages) {
            for (const pagesPlugin of pagesPlugins.values()) {
              const pagesBasePath = trimLeadingSlash(
                trimTrailingSlash(pagesPlugin.options.routeBasePath),
              );

              if (urlMatchesPrefix(route, pagesBasePath)) {
                if (
                  urlMatchesPrefix(
                    route,
                    trimLeadingSlash(`${pagesBasePath}/__docusaurus`),
                  )
                ) {
                  // Do not index pages generated by the debug plugin
                  return [];
                }
                return {
                  route,
                  url,
                  type: "page" as const,
                };
              }
            }
          }

          return [];
        })
        .map(({ route, url, type }) => {
          const file =
            trailingSlash === false
              ? path.join(outDir, `${route === "" ? "index" : route}.html`)
              : path.join(outDir, route, "index.html");
          return {
            file,
            url,
            type,
          };
        });

      logger.info("Parsing documents");

      // Give every index entry a unique id so that the index does not need to store long URLs.
      let nextDocId = 1;
      const documents = (
        await Promise.all(
          data.map(async ({ file, url, type }) => {
            logger.debug(`Parsing ${type} file ${file}`, { url });
            const html = await readFileAsync(file, { encoding: "utf8" });
            const { pageTitle, sections, docSidebarParentCategories } =
              html2text(html, type, url);
            const docusaurusTag = getDocusaurusTag(html);

            return sections.map((section) => ({
              id: nextDocId++,
              pageTitle,
              pageRoute: url,
              sectionRoute: url + section.hash,
              sectionTitle: section.title,
              sectionContent: section.content,
              sectionTags: section.tags,
              docusaurusTag,
              docSidebarParentCategories,
              type,
            }));
          }),
        )
      ).flat();

      const documentsByDocusaurusTag = documents.reduce(
        (acc, doc) => {
          acc[doc.docusaurusTag] = acc[doc.docusaurusTag] ?? [];
          acc[doc.docusaurusTag]!.push(doc);
          return acc;
        },
        {} as Record<string, typeof documents>,
      );

      logger.info(
        `${
          Object.keys(documentsByDocusaurusTag).length
        } indexes will be created.`,
      );

      await Promise.all(
        Object.entries(documentsByDocusaurusTag).map(
          async ([docusaurusTag, documents]) => {
            logger.info(
              `Building index ${docusaurusTag} (${documents.length} documents)`,
            );

            const index = lunr(function () {
              if (language !== "en") {
                if (Array.isArray(language)) {
                  // @ts-expect-error
                  this.use(lunr.multiLanguage(...language));
                } else {
                  // @ts-expect-error
                  this.use(lunr[language]);
                }
              }

              this.k1(k1);
              this.b(b);

              this.ref("id");
              this.field("title");
              this.field("content");
              this.field("tags");

              if (indexDocSidebarParentCategories > 0) {
                this.field("sidebarParentCategories");
              }
              const that = this;
              documents.forEach(
                ({
                  id,
                  sectionTitle,
                  sectionContent,
                  sectionTags,
                  docSidebarParentCategories,
                }) => {
                  let sidebarParentCategories;
                  if (
                    indexDocSidebarParentCategories > 0 &&
                    docSidebarParentCategories
                  ) {
                    sidebarParentCategories = [...docSidebarParentCategories]
                      .reverse()
                      .slice(0, indexDocSidebarParentCategories)
                      .join(" ");
                  }

                  that.add({
                    id: id.toString(), // the ref must be a string
                    title: sectionTitle,
                    content: sectionContent,
                    tags: sectionTags,
                    sidebarParentCategories,
                  });
                },
              );
            });

            await writeFileAsync(
              path.join(outDir, `search-index-${docusaurusTag}.json`),
              JSON.stringify({
                documents: documents.map(
                  ({
                    id,
                    pageTitle,
                    sectionTitle,
                    sectionRoute,
                    type,
                    docSidebarParentCategories,
                  }): MyDocument => {
                    let fullTitle = pageTitle;

                    if (
                      includeParentCategoriesInPageTitle &&
                      docSidebarParentCategories &&
                      docSidebarParentCategories.length > 0
                    ) {
                      fullTitle = [
                        ...docSidebarParentCategories,
                        pageTitle,
                      ].join(" > ");
                    }

                    return {
                      id,
                      pageTitle: fullTitle,
                      sectionTitle,
                      sectionRoute,
                      type,
                    };
                  },
                ),
                index,
              }),
              { encoding: "utf8" },
            );

            logger.info(`Index ${docusaurusTag} written to disk`);
          },
        ),
      );
    },
    configureWebpack: (_config, isServer, utils) => {
      const { getJSLoader } = utils;
      return {
        mergeStrategy: { "module.rules": "prepend" },
        module: {
          rules: [
            {
              test: /client[\\\/]theme[\\\/]SearchBar[\\\/]d-s-l-a-generated\.js$/,
              use: [
                getJSLoader({ isServer }),
                {
                  loader: path.join(__dirname, "lunr-generator.js"),
                  options: { generated },
                },
              ],
            },
          ],
        },
      };
    },
  };
}

export function validateOptions({
  options,
  validate,
}: OptionValidationContext<MyOptions, MyOptions>) {
  return validate(optionsSchema, options);
}
