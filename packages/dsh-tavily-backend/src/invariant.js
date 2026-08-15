/**
 * Package-owned invariant companion for `@moguiyu/dsh-tavily-backend`.
 */
const PACKAGE_NAME = '@moguiyu/dsh-tavily-backend'

/** Cordis companion plugin name. */
const name = 'tavily-backend-invariant'

/** Service required before the companion can reserve package ownership. */
const inject = ['invariants']

/** No runtime invariant: this backend has no independent lifecycle stream. */
const install = () => {}

/** Register this package's invariant companion. */
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

export { apply, inject, name }
