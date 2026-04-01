import { useEffect } from 'react'
import { uiRouter } from './UIRouter'
import type { UIObject } from './types'

/**
 * Register a UIObject instance with UIRouter on mount, unregister on unmount.
 * Pass null to skip registration (e.g., when object isn't ready yet).
 *
 * IMPORTANT: The object MUST be created with useMemo() in the component,
 * keyed on stable identifiers (tabId). If the object reference changes
 * (e.g., new adapter instance), re-registration happens automatically.
 */
export function useUIObjectRegistry(object: UIObject | null) {
  useEffect(() => {
    if (!object) return
    uiRouter.registerInstance(object.objectId, object)
    return () => uiRouter.unregisterInstance(object.objectId)
  }, [object])
}
