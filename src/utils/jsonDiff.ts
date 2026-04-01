/**
 * Recursively diff two JSON-serializable objects and return changed leaf paths.
 *
 * Example:
 *   diffJsonPaths({ env: { parallelism: 6 } }, { env: { parallelism: 2 } })
 *   // → ['env.parallelism']
 *
 * Returns ['*'] (wildcard = everything changed) when inputs are incompatible types.
 */
export function diffJsonPaths(
  oldObj: unknown,
  newObj: unknown,
  prefix = '',
): string[] {
  // Both null/undefined and equal → no diff
  if (oldObj === newObj) return []

  // Type mismatch or either is a primitive → the whole subtree changed
  if (
    typeof oldObj !== typeof newObj ||
    oldObj === null || newObj === null ||
    typeof oldObj !== 'object' || typeof newObj !== 'object'
  ) {
    return prefix ? [prefix] : ['*']
  }

  // Array vs non-array mismatch
  if (Array.isArray(oldObj) !== Array.isArray(newObj)) {
    return prefix ? [prefix] : ['*']
  }

  const paths: string[] = []

  if (Array.isArray(oldObj) && Array.isArray(newObj)) {
    const maxLen = Math.max(oldObj.length, newObj.length)
    for (let i = 0; i < maxLen; i++) {
      const p = prefix ? `${prefix}.${i}` : String(i)
      if (i >= oldObj.length) {
        paths.push(p)
      } else if (i >= newObj.length) {
        paths.push(p)
      } else {
        paths.push(...diffJsonPaths(oldObj[i], newObj[i], p))
      }
    }
  } else {
    // Plain objects
    const oldRec = oldObj as Record<string, unknown>
    const newRec = newObj as Record<string, unknown>
    const allKeys = new Set([...Object.keys(oldRec), ...Object.keys(newRec)])
    for (const key of allKeys) {
      const p = prefix ? `${prefix}.${key}` : key
      if (!(key in oldRec)) {
        paths.push(p)
      } else if (!(key in newRec)) {
        paths.push(p)
      } else {
        paths.push(...diffJsonPaths(oldRec[key], newRec[key], p))
      }
    }
  }

  return paths
}

/**
 * Safely diff two JSON strings. Returns changed paths, or ['*'] on parse failure.
 */
export function diffJsonStringPaths(oldJson: string, newJson: string): string[] {
  try {
    const oldObj = JSON.parse(oldJson)
    const newObj = JSON.parse(newJson)
    return diffJsonPaths(oldObj, newObj)
  } catch {
    return ['*']
  }
}
