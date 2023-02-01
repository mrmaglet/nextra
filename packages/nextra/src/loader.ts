import type { LoaderOptions, MdxPath, PageOpts } from './types'
import type { LoaderContext } from 'webpack'

import path from 'node:path'
import slash from 'slash'

import { hashFnv32a, pageTitleFromFilename, parseFileName } from './utils'
import { compileMdx } from './compile'
import { resolvePageMap } from './page-map'
import { collectFiles, collectMdx } from './collect-files'
import {
  IS_PRODUCTION,
  OFFICIAL_THEMES,
  MARKDOWN_EXTENSION_REGEX,
  CWD
} from './constants'
import { HAS_UNDERSCORE_APP_MDX_FILE, PAGES_DIR } from './file-system'

const IS_WEB_CONTAINER = !!process.versions.webcontainer

const initGitRepo = (async () => {
  if (!IS_WEB_CONTAINER) {
    const { Repository } = await import('@napi-rs/simple-git')
    try {
      const repository = Repository.discover(CWD)
      if (repository.isShallow()) {
        if (process.env.VERCEL) {
          console.warn(
            '[nextra] The repository is shallow cloned, so the latest modified time will not be presented. Set the VERCEL_DEEP_CLONE=true environment variable to enable deep cloning.'
          )
        } else if (process.env.GITHUB_ACTION) {
          console.warn(
            '[nextra] The repository is shallow cloned, so the latest modified time will not be presented. See https://github.com/actions/checkout#fetch-all-history-for-all-tags-and-branches to fetch all the history.'
          )
        } else {
          console.warn(
            '[nextra] The repository is shallow cloned, so the latest modified time will not be presented.'
          )
        }
      }
      // repository.path() returns the `/path/to/repo/.git`, we need the parent directory of it
      const gitRoot = path.join(repository.path(), '..')
      return { repository, gitRoot }
    } catch (e) {
      console.warn('[nextra] Init git repository failed', e)
    }
  }
  return {}
})()

async function loader(
  context: LoaderContext<LoaderOptions>,
  source: string
): Promise<string> {
  const {
    isMetaImport = false,
    isPageImport = false,
    theme,
    themeConfig,
    locales,
    defaultLocale,
    defaultShowCopyCode,
    flexsearch,
    latex,
    staticImage,
    readingTime: _readingTime,
    mdxOptions,
    pageMapCache,
    newNextLinkBehavior,
    transform,
    transformPageOpts,
    codeHighlight
  } = context.getOptions()

  context.cacheable(true)

  // _meta.js used as a page.
  if (isMetaImport) {
    return 'export default () => null'
  }

  const mdxPath = context.resourcePath as MdxPath

  if (mdxPath.includes('/pages/api/')) {
    console.warn(
      `[nextra] Ignoring ${mdxPath} because it is located in the "pages/api" folder.`
    )
    return ''
  }

  const { items, fileMap } = IS_PRODUCTION
    ? pageMapCache.get()!
    : await collectFiles(PAGES_DIR, locales)

  // mdx is imported but is outside the `pages` directory
  if (!fileMap[mdxPath]) {
    fileMap[mdxPath] = await collectMdx(mdxPath)
    if (!IS_PRODUCTION) {
      context.addMissingDependency(mdxPath)
    }
  }

  const { locale } = parseFileName(mdxPath)
  const isLocalTheme = theme.startsWith('.') || theme.startsWith('/')
  const pageNextRoute =
    '/' +
    slash(path.relative(PAGES_DIR, mdxPath))
      // Remove the `mdx?` extension
      .replace(MARKDOWN_EXTENSION_REGEX, '')
      // Remove the `*/index` suffix
      .replace(/\/index$/, '')
      // Remove the only `index` route
      .replace(/^index$/, '')

  if (!IS_PRODUCTION) {
    for (const [filePath, file] of Object.entries(fileMap)) {
      if (file.kind === 'Meta' && (!locale || file.locale === locale)) {
        context.addDependency(filePath)
      }
    }
    // Add the entire directory `pages` as the dependency,
    // so we can generate the correct page map.
    context.addContextDependency(PAGES_DIR)

    // Add local theme as a dependency
    if (isLocalTheme) {
      context.addDependency(path.resolve(theme))
    }
    // Add theme config as a dependency
    if (themeConfig) {
      context.addDependency(path.resolve(themeConfig))
    }
  }

  const {
    result,
    headings,
    title,
    frontMatter,
    structurizedData,
    searchIndexKey,
    hasJsxInH1,
    readingTime
  } = await compileMdx(
    source,
    {
      mdxOptions: {
        ...mdxOptions,
        jsx: true,
        outputFormat: 'program',
        format: 'detect'
      },
      readingTime: _readingTime,
      defaultShowCopyCode,
      staticImage,
      flexsearch,
      latex,
      codeHighlight,
      route: pageNextRoute,
      locale
    },
    {
      filePath: mdxPath,
      useCachedCompiler: false, // TODO: produce hydration errors or error - Create a new processor first, by calling it: use `processor()` instead of `processor`.
      isPageImport
    }
  )

  // Imported as a normal component, no need to add the layout.
  if (!isPageImport) {
    return result
  }

  const { route, pageMap, dynamicMetaItems } = resolvePageMap({
    filePath: mdxPath,
    fileMap,
    defaultLocale,
    items
  })

  // Logic for resolving the page title (used for search and as fallback):
  // 1. If the frontMatter has a title, use it.
  // 2. Use the first h1 heading if it exists.
  // 3. Use the fallback, title-cased file name.
  const fallbackTitle =
    frontMatter.title || title || pageTitleFromFilename(fileMap[mdxPath].name)

  if (searchIndexKey) {
    if (frontMatter.searchable !== false) {
      // Store all the things in buildInfo.
      const { buildInfo } = context._module as any
      buildInfo.nextraSearch = {
        indexKey: searchIndexKey,
        title: fallbackTitle,
        data: structurizedData,
        route: pageNextRoute
      }
    }
  }

  let timestamp: PageOpts['timestamp']
  const { repository, gitRoot } = await initGitRepo
  if (repository && gitRoot) {
    try {
      timestamp = await repository.getFileLatestModifiedDateAsync(
        path.relative(gitRoot, mdxPath)
      )
    } catch {
      // Failed to get timestamp for this file. Silently ignore it.
    }
  }

  // Relative path instead of a package name
  const layout = isLocalTheme ? path.resolve(theme) : theme

  let pageOpts: PageOpts = {
    filePath: slash(path.relative(CWD, mdxPath)),
    route,
    frontMatter,
    pageMap,
    headings,
    hasJsxInH1,
    timestamp,
    flexsearch, // todo: can be injected only in _app file
    newNextLinkBehavior, // todo: remove in v3
    readingTime,
    title: fallbackTitle
  }
  if (transformPageOpts) {
    // It is possible that a theme wants to attach customized data, or modify
    // some fields of `pageOpts`. One example is that the theme doesn't need
    // to access the full pageMap or frontMatter of other pages, and it's not
    // necessary to include them in the bundle.
    pageOpts = transformPageOpts(pageOpts)
  }
  if (HAS_UNDERSCORE_APP_MDX_FILE) {
    // @ts-expect-error `pageMap` will be injected in `setupAppPage` and not in each route
    delete pageOpts.pageMap
  }
  const finalResult = (
    transform ? await transform(result, { route }) : result
  ).replace('export default MDXContent;', '')

  if (route === '/_app') {
    return `import { setupUnderscoreApp } from 'nextra/setup-underscore-app'
${finalResult}
export default setupUnderscoreApp({
  MDXContent,
  pageMap: ${JSON.stringify(pageMap)}
})`
  }

  const themeConfigImport = themeConfig
    ? `import __nextra_themeConfig from '${slash(path.resolve(themeConfig))}'`
    : ''
  const katexCssImport = latex ? "import 'katex/dist/katex.min.css'" : ''
  const cssImport = OFFICIAL_THEMES.includes(theme)
    ? `import '${theme}/style.css'`
    : ''
  const stringifiedPageOpts = JSON.stringify(pageOpts)
  const pageOptsChecksum = IS_PRODUCTION
    ? "''"
    : JSON.stringify(hashFnv32a(stringifiedPageOpts))
  const dynamicMetaModules = dynamicMetaItems
    .map(
      descriptor =>
        `[import(${JSON.stringify(descriptor.metaFilePath)}), ${JSON.stringify(
          descriptor
        )}]`
    )
    .join(',')

  return `import { setupNextraPage } from 'nextra/setup-page'
import __nextra_layout from '${layout}'
${themeConfigImport}
${katexCssImport}
${cssImport}
${finalResult}

setupNextraPage({
  MDXContent,
  nextraLayout: __nextra_layout,
  hot: module.hot,
  pageOpts: ${stringifiedPageOpts},
  themeConfig: ${themeConfigImport ? '__nextra_themeConfig' : 'null'},
  pageNextRoute: ${JSON.stringify(pageNextRoute)},
  pageOptsChecksum: ${pageOptsChecksum},
  dynamicMetaModules: typeof window === 'undefined' ? [${dynamicMetaModules}] : []
})

export { default } from 'nextra/layout'`
}

export default function syncLoader(
  this: LoaderContext<LoaderOptions>,
  source: string,
  callback: (err?: null | Error, content?: string | Buffer) => void
): void {
  loader(this, source)
    .then(result => callback(null, result))
    .catch(err => callback(err))
}
