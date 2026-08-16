/**
 * Package-owned invariant companion for `@moguiyu/dsh-tavily`.
 */
const PACKAGE_NAME = '@moguiyu/dsh-tavily'

/** Cordis companion plugin name. */
const name = 'dsh-tavily-invariant'

/** Service required before the companion can reserve package ownership. */
const inject = ['invariants']

/** No runtime invariant: this tool has no independent lifecycle stream. */
const install = () => {}

/** Register this package's invariant companion. */
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

export { apply, inject, name }
