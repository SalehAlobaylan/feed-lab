import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { createNitro } from 'nitro/builder'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig(async ({ command }) => {
  const config = { preset: 'node_server' }
  const instance = await createNitro({ ...config, builder: 'vite', dev: command === 'serve' }, { dotenv: false })
  // Start and Nitro each have an environment loader independent of Vite.
  const start = tanstackStart().flat(2).filter(plugin =>
    !plugin || typeof plugin !== 'object' || !('name' in plugin) ||
    plugin.name !== 'tanstack-start-core:load-env',
  )
  return {
    envDir: false as const,
    server: { host: '127.0.0.1', port: 3006, strictPort: true, fs: { strict: true, allow: ['.'] } },
    plugins: [start, nitro({ ...config, _nitro: instance }), react()],
  }
})
