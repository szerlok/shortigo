/** Re-resolve DNS for every connection, but avoid an endpoint that just broke
 * a transfer. TCP connection success alone does not make an endpoint healthy.
 */
const ROUTE_TTL_MS = 10 * 60_000
const routes = new Map<string, { good: string | null; failed: Set<string>; updatedAt: number }>()

export function selectUploadAddress(host: string, addresses: string[]): string {
  const route = routes.get(host)
  if (!route || Date.now() - route.updatedAt > ROUTE_TTL_MS) {
    routes.delete(host)
    return addresses[0]
  }
  const available = addresses.filter(address => !route.failed.has(address))
  if (route.good && available.includes(route.good)) return route.good
  if (available.length) return available[0]
  // After trying every current address, allow a fresh round in DNS order.
  route.failed.clear()
  return addresses[0]
}

export function recordUploadRoute(host: string, address: string, succeeded: boolean): void {
  if (!routes.has(host) && routes.size >= 64) routes.delete(routes.keys().next().value!)
  const route = routes.get(host) ?? { good: null, failed: new Set<string>(), updatedAt: 0 }
  route.updatedAt = Date.now()
  if (succeeded) { route.good = address; route.failed.delete(address) }
  else { route.failed.add(address); if (route.good === address) route.good = null }
  routes.set(host, route)
}
