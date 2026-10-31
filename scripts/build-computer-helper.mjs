import { execFile } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

if (process.platform === 'darwin') {
  const source = fileURLToPath(new URL('./computer-helper.swift', import.meta.url))
  const output = fileURLToPath(new URL('../resources/bin/computer-helper', import.meta.url))
  const built = await stat(output).then((file) => file.mtimeMs, () => 0)
  if (built < (await stat(source)).mtimeMs) {
    await mkdir(fileURLToPath(new URL('../resources/bin/', import.meta.url)), { recursive: true })
    try {
      await promisify(execFile)('swiftc', ['-O', source, '-o', output])
    } catch (error) {
      // Everything but computer use still works without the helper.
      console.warn(`Could not build the computer use helper: ${error.message}`)
    }
  }
}
