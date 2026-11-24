/** Read sRGB bytes for a CSS fill regardless of how Chromium serializes the color. */
export function backgroundPixel(element: Element): number[] {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d')!
  context.fillStyle = getComputedStyle(element).backgroundColor
  context.fillRect(0, 0, 1, 1)
  return Array.from(context.getImageData(0, 0, 1, 1).data)
}
