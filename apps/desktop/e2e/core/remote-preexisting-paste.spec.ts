/**
 * Remote-backend topology, pre-existing session (#125122): a screenshot
 * pasted into a session that already existed before the app was relaunched
 * must reach the remote backend as bytes (image.attach_bytes), never as the
 * client-side composer-images path the backend cannot resolve.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { expect, type Page, test } from '@playwright/test'

import {
  backendProcesses,
  composer,
  coreAppEnv,
  createCoreSandbox,
  currentSessionId,
  launchCoreApp,
  recordWebSockets,
  send,
  storedSessionForMarker,
  waitForInteractive,
  writeProviderHome
} from './harness'
import { startScriptedProvider } from './provider'
import { remoteEnv, startRemoteBackend, uniquePng } from './remote-helpers'

const nonce = Math.random()
  .toString(36)
  .slice(2, 8)
  .replace(/[^a-z0-9]/g, 'x')
  .padEnd(4, 'q')

const U = (n: number) => `U${n}-${nonce}`
const A = (n: number) => `A${n}-${nonce}`

function viewport(page: Page) {
  return page.locator('[data-slot="aui_thread-viewport"]').filter({ visible: true }).first()
}

const dataUrlBytes = (url: string) => Buffer.from(/;base64,(.*)$/s.exec(url)?.[1] ?? '', 'base64')

function imageParts(body: any): string[] {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : []
  const user = [...messages].reverse().find(m => m?.role === 'user')
  const content = Array.isArray(user?.content) ? user.content : []

  return content
    .filter((part: any) => part?.type === 'image_url')
    .map((part: any) => String(part.image_url?.url ?? part.image_url ?? ''))
}

test('remote backend: a screenshot pasted into a pre-existing session after a relaunch uploads bytes (#125122)', async () => {
  const provider = await startScriptedProvider()
  const backendBox = createCoreSandbox('remote-backend-paste')
  const clientBox = createCoreSandbox('remote-client-paste')
  writeProviderHome(backendBox.hermesHome, provider.url, 'agent:\n  image_input_mode: native\n')
  const backend = await startRemoteBackend(backendBox)
  const env = coreAppEnv(clientBox, remoteEnv(backend))
  let { app, page } = await launchCoreApp(env)

  const finished = (marker: string) =>
    expect
      .poll(() => provider.completions.some(c => c.marker === marker && c.finished), {
        timeout: 120_000,
        message: `provider finished ${marker}`
      })
      .toBe(true)

  let sessionId = ''

  try {
    await waitForInteractive(app, page)

    await test.step('a session already exists on the remote backend from an earlier run', async () => {
      provider.script(U(1), [{ text: [`${A(1)} `, 'remote ', 'hello'] }])
      await send(page, `${U(1)} hi remote`, 'Enter')
      await finished(U(1))
      await expect(viewport(page)).toContainText(A(1))
      await expect.poll(() => storedSessionForMarker(backendBox, 'default', U(1))).not.toBeNull()
      sessionId = await currentSessionId(page)
      expect(sessionId).not.toBe('')
      await app.close()
    })

    let ws = recordWebSockets(page)

    await test.step('the app relaunches and reopens that session', async () => {
      ;({ app, page } = await launchCoreApp(env))
      ws = recordWebSockets(page)
      await waitForInteractive(app, page)
      await page.evaluate(id => {
        window.location.hash = `#/${encodeURIComponent(id)}`
      }, sessionId)
      await expect(viewport(page)).toContainText(A(1), { timeout: 60_000 })
      await expect.poll(() => currentSessionId(page)).toBe(sessionId)
    })

    const png = uniquePng(`pasted-${nonce}`)
    const stagingDir = path.join(clientBox.userDataDir, 'composer-images')
    let stagedName = ''

    await test.step('a pasted screenshot is staged under composer-images', async () => {
      const box = composer(page)
      await box.click()
      await box.evaluate((el, b64) => {
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
        const clipboardData = new DataTransfer()
        clipboardData.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }))
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
      }, png.toString('base64'))

      await expect
        .poll(() => (fs.existsSync(stagingDir) ? fs.readdirSync(stagingDir).filter(f => f.endsWith('.png')) : []), {
          message: 'the composer wrote a staged copy'
        })
        .toHaveLength(1)
      stagedName = fs.readdirSync(stagingDir).find(f => f.endsWith('.png'))!
      expect(fs.readFileSync(path.join(stagingDir, stagedName)).equals(png), 'staged copy is byte-identical').toBe(true)
      await expect(page.locator('[data-slot="composer-root"]').getByText(stagedName).first()).toBeVisible()
    })

    await test.step('the send ships bytes to the remote owner, never the staged client path', async () => {
      provider.script(U(2), [{ text: [`${A(2)} `, 'saw ', 'it'] }])
      await send(page, `${U(2)} what is in this picture`, 'Enter', ws)
      await finished(U(2))
      await expect(viewport(page)).toContainText(A(2))
      await expect(page.getByText(/image not found/i)).toHaveCount(0)

      const attaches = ws.sent.filter(f => f.method === 'image.attach' || f.method === 'image.attach_bytes')
      expect(
        attaches.map(f => f.method),
        'one byte upload, no path attach'
      ).toEqual(['image.attach_bytes'])
      expect(
        Buffer.from(String(attaches[0]!.params.content_base64), 'base64').equals(png),
        'uploaded bytes == pasted bytes'
      ).toBe(true)
      expect(JSON.stringify(ws.sent).includes(stagingDir), 'the staged client path never went on the wire').toBe(false)

      const seen = provider.completions.flatMap(c => imageParts(c.body)).map(dataUrlBytes)
      expect(
        seen.some(bytes => bytes.equals(png)),
        'the model received the pasted bytes'
      ).toBe(true)
      await expect
        .poll(() => storedSessionForMarker(backendBox, 'default', U(2)), {
          message: 'turn persisted in the same remote session'
        })
        .toBe(sessionId)
      expect(backendProcesses(clientBox), 'the client spawned no backend of its own').toEqual([])
    })
  } finally {
    await app.close().catch(() => undefined)
    await backend.kill()
    await provider.close()
    clientBox.cleanup()
    backendBox.cleanup()
  }
})
