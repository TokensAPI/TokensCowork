/** staging 和隔离插件副本使用自己的依赖树，不继承外层 Yarn PnP loader。 */
export function withoutPnpLoader(environment) {
  const env = { ...environment }
  if (env.NODE_OPTIONS) {
    env.NODE_OPTIONS = env.NODE_OPTIONS.replace(/(?:--require(?:=|\s+)|-r\s+|--experimental-loader(?:=|\s+)|--loader(?:=|\s+)|--import(?:=|\s+))(?:(?:"[^"]*\.pnp\.(?:cjs|loader\.mjs)")|(?:'[^']*\.pnp\.(?:cjs|loader\.mjs)')|(?:[^\s]*\.pnp\.(?:cjs|loader\.mjs)))(?=\s|$)/gu, '').trim()
    if (!env.NODE_OPTIONS) delete env.NODE_OPTIONS
  }
  return env
}
