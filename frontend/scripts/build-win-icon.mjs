import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = PNG.sync.read(fs.readFileSync(path.join(root, 'electron/assets/twill-icon.png')))
if (source.width !== source.height || source.width < 256) throw new Error('Twill icon must be square and at least 256px.')

// Area resampling uses premultiplied alpha to keep transparent edge pixels
// from producing black fringes in Explorer's small icons.
function resize(size) {
  const result = new PNG({ width: size, height: size })
  const scale = source.width / size
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let alpha = 0
      const rgb = [0, 0, 0]
      for (let sy = Math.floor(y * scale); sy < Math.ceil((y + 1) * scale); sy++) {
        const wy = Math.min(sy + 1, (y + 1) * scale) - Math.max(sy, y * scale)
        for (let sx = Math.floor(x * scale); sx < Math.ceil((x + 1) * scale); sx++) {
          const weight = wy * (Math.min(sx + 1, (x + 1) * scale) - Math.max(sx, x * scale))
          const position = (sy * source.width + sx) * 4
          const a = source.data[position + 3] * weight
          alpha += a
          for (let channel = 0; channel < 3; channel++) rgb[channel] += source.data[position + channel] * a
        }
      }
      const position = (y * size + x) * 4
      for (let channel = 0; channel < 3; channel++) result.data[position + channel] = alpha ? Math.round(rgb[channel] / alpha) : 0
      result.data[position + 3] = Math.round(alpha / (scale * scale))
    }
  }
  return result
}

// Small Explorer/taskbar frames use standard 32-bit DIBs with alpha and AND
// masks. The 256px frame uses PNG, as supported by Windows Vista and later.
const sizes = [16, 24, 32, 48, 64, 128, 256]
const frames = sizes.map((size) => {
  const image = resize(size)
  if (size === 256) return PNG.sync.write(image)
  const bitmap = Buffer.from(image.data)
  for (let position = 0; position < bitmap.length; position += 4) {
    const red = bitmap[position]
    bitmap[position] = bitmap[position + 2]
    bitmap[position + 2] = red
  }
  const maskStride = Math.ceil(size / 32) * 4
  const pixels = Buffer.alloc(size * size * 4)
  const mask = Buffer.alloc(maskStride * size)
  for (let y = 0; y < size; y++) {
    bitmap.copy(pixels, (size - 1 - y) * size * 4, y * size * 4, (y + 1) * size * 4)
    for (let x = 0; x < size; x++) {
      if (bitmap[(y * size + x) * 4 + 3] === 0) {
        mask[(size - 1 - y) * maskStride + (x >> 3)] |= 1 << (7 - (x % 8))
      }
    }
  }
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(pixels.length + mask.length, 20)
  return Buffer.concat([header, pixels, mask])
})
const header = Buffer.alloc(6 + sizes.length * 16)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
let offset = header.length
for (let index = 0; index < sizes.length; index++) {
  const position = 6 + index * 16
  header[position] = sizes[index] % 256
  header[position + 1] = sizes[index] % 256
  header.writeUInt16LE(1, position + 4)
  header.writeUInt16LE(32, position + 6)
  header.writeUInt32LE(frames[index].length, position + 8)
  header.writeUInt32LE(offset, position + 12)
  offset += frames[index].length
}
fs.writeFileSync(path.join(root, 'electron/assets/twill-icon.ico'), Buffer.concat([header, ...frames]))
fs.copyFileSync(path.join(root, 'electron/assets/twill-icon.ico'), path.join(root, 'public/twill-icon.ico'))
console.log('[icon] Generated Windows ICO: 16, 24, 32, 48, 64, 128, 256px')
