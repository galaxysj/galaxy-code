import { access, chmod } from 'node:fs/promises'
import { constants } from 'node:fs'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  const root = new URL('../node_modules/node-pty/', import.meta.url)
  for (const relative of [`prebuilds/${process.platform}-${process.arch}/spawn-helper`, 'build/Release/spawn-helper']) {
    const path = fileURLToPath(new URL(relative, root))
    if (await access(path, constants.F_OK).then(() => true, () => false)) await chmod(path, 0o755)
  }
}
