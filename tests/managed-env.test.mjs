import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { setTimeout as wait } from 'node:timers/promises'

test('managed Vite startup ignores independent dotenv loaders', async () => {
  const mode = 'feed-lab-isolation-' + process.pid
  const file = '.env.' + mode + '.local'
  await writeFile(file, 'WAHB_ENVIRONMENT_ID=unmanaged-sentinel\nCONSOLE_BASE_URL=http://unmanaged-sentinel\n', { flag: 'wx', mode: 0o600 })
  let app
  let output = ''
  try {
    const port = await new Promise((resolve, reject) => {
      const server = createServer()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        server.close(() => resolve(address.port))
      })
    })
    app = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'dev', '--mode', mode, '--port', String(port)], {
      env: { PATH: process.env.PATH, WAHB_MANAGED_ENV: '1', WAHB_RUNTIME_ID: 'isolation-launch', WAHB_ENVIRONMENT_ID: 'managed' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    app.stdout.on('data', value => { output += value })
    app.stderr.on('data', value => { output += value })
    for (let attempt = 0; attempt < 120; attempt++) {
      if (app.exitCode !== null) break
      const response = await fetch('http://127.0.0.1:' + port + '/api/health').catch(() => null)
      if (response?.ok) {
        assert.equal((await response.json()).console_url, '')
        return
      }
      await wait(100)
    }
    assert.fail('Managed Vite failed to start: ' + output)
  } finally {
    if (app && app.exitCode === null) {
      const exited = once(app, 'exit')
      app.kill()
      await exited
    }
    await rm(file)
  }
})
