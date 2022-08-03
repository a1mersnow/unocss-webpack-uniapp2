import type { UserConfig, UserConfigDefaults } from '@unocss/core'
import type { ResolvedUnpluginOptions, UnpluginOptions } from 'unplugin'
import { createUnplugin } from 'unplugin'
import WebpackSources from 'webpack-sources'
import { createContext } from './shared-integration/context'
import { getHash } from './shared-integration/hash'
import { HASH_PLACEHOLDER_RE, LAYER_MARK_ALL, LAYER_PLACEHOLDER_RE, getHashPlaceholder, getLayerPlaceholder, resolveId, resolveLayer } from './shared-integration/layers'
import { applyTransformers } from './shared-integration/transformers'
import { getPath } from './shared-integration/utils'

export interface WebpackPluginOptions<Theme extends {} = {}> extends UserConfig<Theme> {
  cssMode?: 'import' | 'style'
}

const PLUGIN_NAME = 'unocss-webpack-uniapp2'
const UPDATE_DEBOUNCE = 10

export function defineConfig<Theme extends {}>(config: WebpackPluginOptions<Theme>) {
  return config
}

const styleCssRegExp = /\/\*\s*unocss-start\s*\*\/[\s\S]*\/\*\s*unocss-end\s*\*\//

export default function WebpackPlugin<Theme extends {}>(
  configOrPath?: WebpackPluginOptions<Theme> | string,
  defaults?: UserConfigDefaults,
) {
  return createUnplugin(() => {
    const ctx = createContext<WebpackPluginOptions>(configOrPath as any, defaults)
    const { uno, tokens, filter, extract, onInvalidate } = ctx
    let cssMode = 'import'

    if (typeof configOrPath === 'object')
      cssMode = configOrPath.cssMode || 'import'

    let timer: any
    onInvalidate(() => {
      clearTimeout(timer)
      timer = setTimeout(updateModules, UPDATE_DEBOUNCE)
    })

    const nonPreTransformers = ctx.uno.config.transformers?.filter(i => i.enforce !== 'pre')
    if (nonPreTransformers?.length) {
      console.warn(
        // eslint-disable-next-line prefer-template
        '[unocss] webpack integration only supports "pre" enforce transformers currently.'
        + 'the following transformers will be ignored\n'
        + nonPreTransformers.map(i => ` - ${i.name}`).join('\n'),
      )
    }

    const tasks: Promise<any>[] = []
    const entries = new Set<string>()
    const hashes = new Map<string, string>()

    const plugin = <UnpluginOptions>{
      name: PLUGIN_NAME,
      enforce: 'pre',
      transformInclude(id) {
        return filter('', id) && !id.match(/\.html$/)
      },
      async transform(code, id) {
        const result = await applyTransformers(ctx, code, id, 'pre')
        if (result == null)
          tasks.push(extract(code, id))
        else
          tasks.push(extract(result.code, id))
        return result
      },
      resolveId(id) {
        const entry = resolveId(id)
        if (entry) {
          let query = ''
          const queryIndex = id.indexOf('?')
          if (queryIndex >= 0)
            query = id.slice(queryIndex)
          entries.add(entry)
          // preserve the input query
          return entry + query
        }
      },
      // serve the placeholders in virtual module
      load(id) {
        // 取消占位符
        if (cssMode === 'style')
          return

        let layer = resolveLayer(getPath(id))
        if (!layer) {
          const entry = resolveId(id)
          if (entry)
            layer = resolveLayer(entry)
        }
        const hash = hashes.get(id)

        if (layer)
          return (hash ? getHashPlaceholder(hash) : '') + getLayerPlaceholder(layer)
      },
      webpack(compiler) {
        // replace the placeholders
        compiler.hooks.compilation.tap(PLUGIN_NAME, (compilation) => {
          compilation.hooks.optimizeAssets.tapPromise(PLUGIN_NAME, async () => {
            const files = Object.keys(compilation.assets)
            await Promise.all(tasks)

            const result = await uno.generate(tokens, { minify: true })

            for (const file of files) {
              let code = compilation.assets[file].source().toString()
              let replaced = false

              if (cssMode === 'import') {
                code = code.replace(HASH_PLACEHOLDER_RE, '')
                code = code.replace(LAYER_PLACEHOLDER_RE, (_, quote, layer) => {
                  replaced = true

                  const css = layer === LAYER_MARK_ALL
                    ? result.getLayers(undefined, Array.from(entries)
                      .map(i => resolveLayer(i)).filter((i): i is string => !!i))
                    : result.getLayer(layer) || ''

                  if (!quote)
                    return css

                  // the css is in a js file, escaping
                  let escaped = JSON.stringify(css).slice(1, -1)
                  // in `eval()`, escaping twice
                  if (quote === '\\"')
                    escaped = JSON.stringify(escaped).slice(1, -1)
                  return quote + escaped
                })
              }
              else {
                if (styleCssRegExp.test(code)) {
                  replaced = true
                  let css
                    = result.getLayers(undefined, Array.from(entries)
                      .map(i => resolveLayer(i)).filter((i): i is string => !!i))

                  if (process.env.UNI_PLATFORM === 'app-plus')
                    css = css.replace('page', 'body')

                  code = code.replace(styleCssRegExp, `/* unocss-start */${css}/* unocss-end */`)
                }
              }
              if (replaced)
                compilation.assets[file] = new WebpackSources.RawSource(code) as any
            }
          })
        })
      },
    } as Required<ResolvedUnpluginOptions>

    async function updateModules() {
      if (!plugin.__vfsModules)
        return

      const result = await uno.generate(tokens)

      Array.from(plugin.__vfsModules)
        .forEach((id) => {
          const path = id.slice(plugin.__virtualModulePrefix.length).replace(/\\/g, '/')
          const layer = resolveLayer(path)
          if (!layer)
            return
          const code = layer === LAYER_MARK_ALL
            ? result.getLayers(undefined, Array.from(entries)
              .map(i => resolveLayer(i)).filter((i): i is string => !!i))
            : result.getLayer(layer) || ''

          const hash = getHash(code)
          hashes.set(path, hash)

          plugin.__vfs.writeModule(id, code)
        })
    }

    return plugin
  }).webpack()
}
