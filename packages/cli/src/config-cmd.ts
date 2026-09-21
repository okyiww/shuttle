import { loadConfig, maskConfig } from '@shuttle/config'

export function dumpConfig(cwd: string = process.cwd()): void {
  const { config, layers } = loadConfig(cwd)
  // Read paths never leak apiKeys: everything goes out masked.
  const masked = maskConfig(config)
  if (layers.length === 0) {
    console.log('# no config files found (expected ./shuttle.config.yml and/or ~/.shuttle/config.yml)')
  }
  for (const layer of layers) {
    console.log(`# layer: ${layer.path} (${layer.writable ? 'writable' : 'read-only'})`)
    console.log(JSON.stringify(maskConfig(layer.config), null, 2))
  }
  console.log('# merged')
  console.log(JSON.stringify(masked, null, 2))
}
