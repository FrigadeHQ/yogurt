function wireDialog(dialog, initialFocus) {
  let opener
  const root = document.documentElement
  const close = () => dialog.close()
  dialog.querySelector('[data-dialog-close]').addEventListener('click', close)
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    close()
  })
  dialog.addEventListener('close', () => {
    if (dialog.open) return
    root.classList.remove('modal-open')
    opener?.focus({ preventScroll: true })
  })
  const outside = (event) => {
    const bounds = dialog.getBoundingClientRect()
    return (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
  }
  let backdropPress = false
  dialog.addEventListener('pointerdown', (event) => {
    backdropPress = outside(event)
  })
  dialog.addEventListener('click', (event) => {
    if (backdropPress && outside(event)) close()
    backdropPress = false
  })
  return (trigger) => {
    if (dialog.open) return
    opener = trigger
    // Keep the document in place instead of fixing the body and restoring its scroll offset.
    root.classList.add('modal-open')
    dialog.showModal()
    initialFocus.focus({ preventScroll: true })
  }
}

const video = document.querySelector('#demo-video')
const dialog = document.querySelector('#demo-dialog')
const button = document.querySelector('.demo-play')
const status = document.querySelector('#demo-video-status')
const retry = document.querySelector('#demo-retry')
const openDialog = wireDialog(dialog, dialog.querySelector('[data-dialog-close]'))

function failed() {
  if (!dialog.open) return
  status.textContent = 'The video could not play.'
  retry.hidden = false
}
async function play() {
  status.textContent = ''
  retry.hidden = true
  video.muted = false
  if (!video.src) {
    video.poster = video.dataset.poster
    video.src = video.dataset.src
  }
  try {
    await video.play()
    if (!dialog.open) video.pause()
  } catch {
    failed()
  }
}
button.addEventListener('click', () => {
  openDialog(button)
  play()
})
retry.addEventListener('click', () => {
  video.load()
  play()
})
video.addEventListener('error', failed)
dialog.addEventListener('close', () => {
  video.pause()
})
