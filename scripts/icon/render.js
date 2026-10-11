// Renders every icon variant in scripts/icon/icon.html with offscreen Electron.
// Writes <outDir>/<variant>.png (2048px on Retina, 1024px otherwise) and
// <outDir>/<variant>.svg (the exact markup that was rendered).
// Run via scripts/icon/build-icons.sh, which sizes them into build/.
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

app.disableHardwareAcceleration()
process.on('unhandledRejection', (err) => {
  console.error('render failed:', err && err.message)
  app.exit(1)
})

const outDir = process.argv[2] || path.join(__dirname, 'out')
const VARIANTS = ['full', 'compact', 'tiny']

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true })
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true }
  })

  for (const variant of VARIANTS) {
    await win.loadFile(path.join(__dirname, 'icon.html'), { query: { v: variant } })
    for (let i = 0; i < 50 && win.webContents.getTitle() !== 'ready'; i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    await new Promise((r) => setTimeout(r, 300))

    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(outDir, `${variant}.png`), img.toPNG())
    const svg = await win.webContents.executeJavaScript('document.getElementById("c").outerHTML')
    fs.writeFileSync(path.join(outDir, `${variant}.svg`), `${svg.replace(' id="c"', '')}\n`)
    console.log('rendered', variant, img.getSize())
  }
  app.quit()
})
