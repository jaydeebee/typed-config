/*
 * typed-config/index.ts
 *
 * This is a library for managing deploy-time configuration using
 * a configurable set of sources:
 *
 * - JSON file
 * - Environment variables
 * - Command line arguments
 * - Defaults
 *
 * Usage:
 *
 *   import { getConfigGetter } from 'typed-config'
 *   import { z } from 'zod'
 *   const getConfig = getConfigGetter(z.object({
 *     someValue: z.string().default('default value'),
 *     someOtherValue: z.number().default(42),
 *     someObject: z.object({
 *       someNestedValue: z.boolean().default(false),
 *     }),
 *   }))
 *
 * Later...
 *
 *  const someValue = getConfig('someValue')   // type string
 *  const someOtherValue = getConfig('someOtherValue')   // type number
 *  const someNestedValue = getConfig('someObject.someNestedValue')   // type boolean
 */
import { mergeWith } from 'lodash';
import { z } from 'zod'
import fs from 'fs'
import yargsParser from 'yargs-parser'

/**
 * Interface for configuration options.
 * @interface
 * @property {string | null} prefix - An optional prefix to (also) use for the configuration.
 * @property {boolean | string} jsonFile - The JSON file for the configuration, or false to disable reading from a JSON file
 * @property {boolean} commandLine - Whether to process command-line arguments
 * @property {() => Partial<T>} defaultsFn - A function to return default values
 */
export interface ConfigOptions<T> {
  prefix?: string | null
  jsonFile?: boolean | string
  commandLine?: boolean
  defaultsFn?: () => Partial<T>
}

/**
 * Type for a given ConfigKey.
 * @typedef {object} ConfigKey
 * T the Zod schema object
 *
 * This is not commonly used by consumers of this library.
 */
export type ConfigKey<T> =
  T extends object ? {
    [K in keyof T]: K extends string ?
      `${K}` | `${K}.${ConfigKey<T[K]>}` : never;
  }[keyof T] : never;

/**
 * Type for a given ConfigValue.
 * @typedef {object} ConfigValue
 * T the Zod schema object
 *
 * This is not commonly used by consumers of this library.
 */
export type ConfigValue<T, K extends ConfigKey<T>> =
  K extends `${infer P}.${infer R}`
    ? P extends keyof T
      ? R extends ConfigKey<T[P]>
        ? ConfigValue<T[P], R>
        : never
      : never
    : K extends keyof T ? T[K] : never;

/**
 * A helper for ldoash's mergeDeep() to handle conflict resolution
 * @function
 * @param {T | undefined} objValue - The object value.
 * @param {T | undefined} srcValue - The source value.
 * @param {string} key - The key.
 * @returns {T} - The merged configuration.
 */
const deepConfigMerge = <T>(objValue: T | undefined, srcValue: T | undefined, key: string): T => {
  if (objValue === undefined) {
    return srcValue as T;
  } else if (srcValue === undefined) {
    return objValue as T;
  } else if (Array.isArray(objValue)) {
    // We merge arrays
    return objValue.concat(...Array.isArray(srcValue) ? srcValue : [srcValue]) as T;
  } else if (typeof objValue === 'object' && objValue !== null) {
    if (typeof srcValue !== 'object') {
      throw new Error(`Cannot merge ${key} into an object from type ${typeof srcValue}`);
    }
    return mergeWith({}, objValue, srcValue, deepConfigMerge) as T;
  } else {
    return srcValue as T;
  }
}

/**
 * Function to get configuration getter.
 * @function
 * @param {T} schema - The schema.
 * @param {ConfigOptions<z.infer<T>>} options - The options.
 * @returns {<K extends ConfigKey<SchemaType>, V extends ConfigValue<SchemaType, K>>(key: K, defaultValue?: V) => V} - The configuration getter.
 */
export function getConfigGetter<T extends z.ZodType<any, any>>(schema: T, options?: ConfigOptions<z.infer<T>>) {
  options = {
    prefix: null,
    jsonFile: true,
    commandLine: true,
    ...options ?? {},
  }

  type SchemaType = z.infer<T>

  const parsedCommandLine = options.commandLine
    ? yargsParser(process.argv.slice(2), {
      configuration: {
        'dot-notation': true,
      },
    })
    : {} as yargsParser.Arguments

  if (parsedCommandLine._?.length > 0) {
    console.warn(`Unrecognized command line options: ${parsedCommandLine._.join(' ')}`)
  }

  if (parsedCommandLine.help) {
    const command = options.prefix ?? process.argv[1] ?? 'node <script>'
    console.log(`Usage: ${command} [--config-json-file <file>] [--<key> <value>]`)
    console.log('Options:')
    console.log('  --config-json-file <file>  Path to config JSON file')
    console.log('  --print-config             Display parsed config and exit')
    console.log('  --<key> <value>            Override config value')
    process.exit(0)
  }

  const configJsonFile = parsedCommandLine.configJsonFile
    || process.env.CONFIG_JSON_FILE
    || (typeof options.jsonFile === 'string' ? options.jsonFile : null)
    || './config.json'

  const rawData = ((!!options.jsonFile) && fs.existsSync(configJsonFile))
    ? JSON.parse(fs.readFileSync(configJsonFile, 'utf8'))
    : {}

  // Given rawData, prefix, and defaults, merge things together into merged data.
  const defaults = options.defaultsFn?.() ?? {}
  const prefixedRaw = options.prefix && `${options.prefix}`.split('.').reduce((acc, k) => acc?.[k], rawData)
  const merged = mergeWith({}, defaults ?? {}, rawData, prefixedRaw ?? {}, parsedCommandLine, deepConfigMerge)
  const data: z.infer<T> = schema.parse(merged)

  if (parsedCommandLine.printConfig) {
    console.log(JSON.stringify(data, null, 2))
    process.exit(0)
  }

  return <K extends ConfigKey<SchemaType>, V extends ConfigValue<SchemaType, K>>(key: K, defaultValue?: V): V => {
    const value = key.toString().split('.').reduce((acc, k) => acc?.[k], data) as V | undefined
    if (value === undefined) {
      if (defaultValue === undefined) throw new Error(`The config variable '${key.toString()}' is not defined.`)
      else return defaultValue
    }
    return value as V
  }
}
