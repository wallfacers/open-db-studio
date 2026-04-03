// ── Path Segment ──────────────────────────────────────────

export interface PathSegment {
  /** Field name, e.g. "tables", "columns", "name". Empty string for context-only segments. */
  field: string
  /** Address filters, e.g. { id: "5" } or { name: "users" } */
  filters?: Record<string, string>
  /** True for "-" (array append) */
  isAppend?: boolean
}

// ── Regex for [key=value] ─────────────────────────────────

// Matches: [key=value] — no spaces, value can contain letters/digits/underscore/hyphen
const FILTER_RE = /\[(\w+)=([^\]]+)\]/g

/**
 * Parse unified path syntax into segments.
 *
 * Supported formats:
 *   /tables/[id=5]/name            — ERCanvas style (filter as separate segment)
 *   /columns[name=email]/dataType  — TableForm style (filter attached to field)
 *   /tables/[id=5]/columns/-       — Array append
 *   /columns/[id=10]/[tableId=5]   — Remove with context
 *   /content                       — Simple field
 */
export function parsePath(path: string): PathSegment[] {
  const raw = path.replace(/^\//, '')
  if (!raw) return []

  const tokens = raw.split('/')
  const segments: PathSegment[] = []

  for (const token of tokens) {
    if (token === '-') {
      // Array append — mark previous segment
      if (segments.length > 0) {
        segments[segments.length - 1].isAppend = true
      }
      continue
    }

    // Check if token is purely a filter: [key=value]
    if (token.startsWith('[')) {
      const filters: Record<string, string> = {}
      let m: RegExpExecArray | null
      FILTER_RE.lastIndex = 0
      while ((m = FILTER_RE.exec(token)) !== null) {
        filters[m[1]] = m[2]
      }
      if (Object.keys(filters).length > 0) {
        // Standalone filter — attach to previous segment if possible, else create empty-field segment
        if (segments.length > 0 && !segments[segments.length - 1].filters) {
          segments[segments.length - 1].filters = filters
        } else {
          segments.push({ field: '', filters })
        }
      }
      continue
    }

    // Check if token has inline filters: field[key=value]
    FILTER_RE.lastIndex = 0
    const inlineMatch = token.match(/^([^[]+)/)
    const fieldName = inlineMatch ? inlineMatch[1] : token

    const filters: Record<string, string> = {}
    let m: RegExpExecArray | null
    FILTER_RE.lastIndex = 0
    while ((m = FILTER_RE.exec(token)) !== null) {
      filters[m[1]] = m[2]
    }

    const segment: PathSegment = { field: fieldName }
    if (Object.keys(filters).length > 0) {
      segment.filters = filters
    }
    segments.push(segment)
  }

  return segments
}

// ── Pattern matching ──────────────────────────────────────

/**
 * Check if a concrete path matches a capability pattern.
 *
 * Pattern placeholders:
 *   <n>     — matches any number
 *   <s>     — matches any string
 *   <val>   — matches any value
 *   <key>   — matches any key name
 *   <field> — matches one or more remaining path segments
 *
 * Example: matchPathPattern('/tables/[id=5]/name', '/tables/[<key>=<val>]/<field>') → true
 */
export function matchPathPattern(path: string, pattern: string): boolean {
  const pathParts = path.replace(/^\//, '').split('/')
  const patternParts = pattern.replace(/^\//, '').split('/')

  let pi = 0
  let pp = 0

  while (pi < pathParts.length && pp < patternParts.length) {
    const pathToken = pathParts[pi]
    const patternToken = patternParts[pp]

    // <field> matches all remaining segments
    if (patternToken === '<field>') return true

    // Both are filter tokens: [key=value] vs [<key>=<val>] or [id=<n>]
    if (patternToken.includes('[') && pathToken.includes('[')) {
      // Normalize: extract field parts and filter parts
      const pathField = pathToken.replace(/\[.*/, '')
      const patternField = patternToken.replace(/\[.*/, '')

      // Field names must match (or pattern field is empty for pure filter tokens)
      if (pathField !== patternField && patternField !== '' && pathField !== '') {
        return false
      }

      // Filters: pattern has placeholders, path has concrete values — always match
      pi++
      pp++
      continue
    }

    // Plain tokens must match exactly
    if (pathToken !== patternToken && patternToken !== '<field>') {
      return false
    }

    pi++
    pp++
  }

  // <field> at end of pattern consumes remaining
  if (pp < patternParts.length && patternParts[pp] === '<field>') return true

  return pi === pathParts.length && pp === patternParts.length
}
