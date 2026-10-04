import type { DeviceData } from './db.js';

export interface ConfigValidationResult {
  valid: boolean;
  error?: string;
  sanitized?: Record<string, Partial<DeviceData>>;
}

/**
 * Validates a device configuration import object against schema and inventory constraints.
 * Protects against prototype pollution, unexpected fields, oversized values, and nonexistent devices.
 */
export function validateDeviceConfigImport(
  rawJson: unknown,
  existingDeviceIds: Set<string>
): ConfigValidationResult {
  if (typeof rawJson !== 'object' || rawJson === null || Array.isArray(rawJson)) {
    return { valid: false, error: 'Import rejected: Configuration root must be a JSON object mapping device IDs to configuration.' };
  }

  const sanitized: Record<string, Partial<DeviceData>> = {};
  const entries = Object.entries(rawJson);

  if (entries.length === 0) {
    return { valid: false, error: 'Import rejected: Configuration file contains no devices.' };
  }

  for (const [id, patch] of entries) {
    if (id === '__proto__' || id === 'constructor' || id === 'prototype') {
      return { valid: false, error: `Import rejected: Prohibited property name '${id}'.` };
    }

    if (typeof id !== 'string' || id.trim().length === 0 || id.length > 128) {
      return { valid: false, error: `Import rejected: Invalid device ID '${id}'.` };
    }

    if (!existingDeviceIds.has(id)) {
      return { valid: false, error: `Import rejected: Device '${id}' does not exist in the current device inventory.` };
    }

    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      return { valid: false, error: `Import rejected: Config for device '${id}' must be an object.` };
    }

    const cleanPatch: Partial<DeviceData> = {};
    const allowedFields = new Set(['customName', 'notes', 'tags', 'isBareBoard']);

    for (const [key, value] of Object.entries(patch)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return { valid: false, error: `Import rejected: Prohibited property name '${key}' in device '${id}'.` };
      }

      if (!allowedFields.has(key)) {
        return {
          valid: false,
          error: `Import rejected: Unauthorized or unknown field '${key}' in device '${id}'. Only user configuration (customName, notes, tags, isBareBoard) may be imported.`
        };
      }

      if (key === 'customName') {
        if (value !== undefined && typeof value !== 'string') {
          return { valid: false, error: `Import rejected: 'customName' for '${id}' must be a string.` };
        }
        if (typeof value === 'string' && value.length > 100) {
          return { valid: false, error: `Import rejected: 'customName' for '${id}' exceeds 100 characters.` };
        }
        cleanPatch.customName = value;
      } else if (key === 'notes') {
        if (value !== undefined && typeof value !== 'string') {
          return { valid: false, error: `Import rejected: 'notes' for '${id}' must be a string.` };
        }
        if (typeof value === 'string' && value.length > 2000) {
          return { valid: false, error: `Import rejected: 'notes' for '${id}' exceeds 2000 characters.` };
        }
        cleanPatch.notes = value;
      } else if (key === 'tags') {
        if (value !== undefined && !Array.isArray(value)) {
          return { valid: false, error: `Import rejected: 'tags' for '${id}' must be an array of strings.` };
        }
        if (Array.isArray(value)) {
          if (value.length > 30) {
            return { valid: false, error: `Import rejected: 'tags' for '${id}' exceeds maximum of 30 tags.` };
          }
          for (const tag of value) {
            if (typeof tag !== 'string' || tag.length > 50) {
              return { valid: false, error: `Import rejected: Each tag for '${id}' must be a string <= 50 characters.` };
            }
          }
          cleanPatch.tags = value;
        }
      } else if (key === 'isBareBoard') {
        if (value !== undefined && typeof value !== 'boolean') {
          return { valid: false, error: `Import rejected: 'isBareBoard' for '${id}' must be a boolean.` };
        }
        if (typeof value === 'boolean') {
          cleanPatch.isBareBoard = value;
        }
      }
    }

    sanitized[id] = cleanPatch;
  }

  return { valid: true, sanitized };
}
