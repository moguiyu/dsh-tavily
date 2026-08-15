/**
 * Package-owned invariant companion for `@moguiyu/dsh-tool-tavily-search`.
 */
const PACKAGE_NAME = '@moguiyu/dsh-tool-tavily-search'

/** Cordis companion plugin name. */
const name = 'tool-tavily-search-invariant'

/** Service required before the companion can reserve package ownership. */
const inject = ['invariants']

/** No runtime invariant: this tool has no independent lifecycle stream. */
const install = () => {}

/** Register this package's invariant companion. */
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

export { apply, inject, name }
