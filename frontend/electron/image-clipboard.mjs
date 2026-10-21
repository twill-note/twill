import { BrowserWindow, clipboard, ipcMain, nativeImage } from 'electron'

/** Only the app's main frame may write renderer-rasterized PNG data. */
export function registerImageClipboard(appUrl) {
  const origin = new URL(appUrl).origin
  ipcMain.handle('desktop:copy-image', (event, png) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window.isDestroyed() || event.senderFrame !== event.sender.mainFrame || new URL(event.senderFrame.url).origin !== origin) {
      throw new Error('앱 창에서만 이미지를 복사할 수 있습니다.')
    }
    if (typeof png !== 'string' || !png.startsWith('data:image/png;base64,') || png.length > 64 * 1024 * 1024) {
      throw new Error('복사할 PNG 이미지가 올바르지 않거나 너무 큽니다.')
    }
    const image = nativeImage.createFromDataURL(png)
    if (image.isEmpty()) throw new Error('복사할 이미지를 읽을 수 없습니다.')
    clipboard.writeImage(image)
  })
}
