const Launchpad = require('./Launchpad.js').default
const SimplexNoise = require('./SimplexNoise.js').default

const pad = new Launchpad()
window.pad = pad
const content = document.getElementById('content')

// Ask MIDI API access
navigator.requestMIDIAccess({ sysex: true }).then(() => {
  setup()
}).catch(e => {
  alert(e.message)
})

// Setup sequence
function setup () {
  pad.accessDevice().then(() => {
    // Listen for user input
    try {
      padReady()
    } catch (e) {
      console.error(e)
    }
  }).catch(e => {
    alert(e.message)
  })
}

function padReady () {
  /*
  pad.setSingleLED(Launchpad.Buttons.Mixer, Launchpad.Colors.Green)
  pad.setSingleLED(Launchpad.Buttons['70'], Launchpad.Colors.Green)
  pad.switchUpdatingBuffer()
  pad.setSingleLED(Launchpad.Buttons.Mixer, Launchpad.Colors.GreenMed)
  pad.setSingleLED(Launchpad.Buttons['70'], Launchpad.Colors.GreenMed)
  pad.switchUpdatingBuffer()
  pad.switchFlash()
  const unbindfb = pad.onButtonPressed(e => {
    unbindfb()
    pad.switchFlash()
    run()
  })
  */
  run()
}

async function run () {
  await pad.setBrightness(5)
  await pad.onLedChanged(updateVisualization)
  updateColors()
}

function updateVisualization () {
  if (content.getElementsByClassName('vis-table').length) {
    Object.keys(pad.ledBuffers).forEach(bufferID => {
      const buffer = pad.ledBuffers[bufferID]
      pad.getOrderedButtons().forEach(button => {
        const td = document.getElementById('td-' + bufferID + '-' + button.name)
        const color = buffer[button.name]
        if (td.dataset.colorName === color.name) return undefined
        td.innerHTML = `<span style="font-size:0.5em">${color.name}</span>`
        td.dataset.colorName = color.name
        td.style.background = color.htmlColorCode
      })
    })
  } else {
    content.innerHTML = ''
    Object.keys(pad.ledBuffers).forEach(bufferID => {
      const buffer = pad.ledBuffers[bufferID]
      const table = document.createElement('table')
      table.className = 'vis-table'
      let currentTr
      let col = 0
      let row = 0
      pad.getOrderedButtons().forEach(button => {
        if (!currentTr) currentTr = document.createElement('tr')
        const color = buffer[button.name]
        const td = document.createElement('td')
        td.id = 'td-' + bufferID + '-' + button.name
        td.innerHTML = `<span style="font-size:0.5em">${color.name}</span>`
        td.style.background = color.htmlColorCode
        td.style.width = '3em'
        td.style.height = '3em'
        if (row === 8 || col === 0) td.style.borderRadius = '50%'
        currentTr.append(td)
        row++
        if (row > (col > 0 ? 8 : 7)) {
          col++
          row = 0
          table.append(currentTr)
          currentTr = null
        }
      })
      table.style.borderSpacing = '0.2em'
      table.style.textAlign = 'center'
      table.style.color = '#fafafa'
      content.append(table)
      content.append(document.createElement('br'))
    })
  }
}

const noise = new SimplexNoise()
let oldButtons = new Set()
let newButtons

async function updateColors () {
  const t = Date.now() / 500
  const rand = (x, y) => noise.noise3d(x, y, t) * 0.5 + 0.5

  newButtons = new Set()

  const noiseMax = 0.2
  for (let n = 1; n < 4; n += 0.5) {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 18) {
      const r = rand(1000 + Math.cos(a) * noiseMax, 1000 + Math.sin(a) * noiseMax)
      const x = Math.floor((Math.cos(a) * r * 0.5 / n + 0.5) * 6 + 1)
      const y = Math.floor((Math.sin(a) * r * 0.5 / n + 0.5) * 6 + 1)
      newButtons.add(Launchpad.Buttons['' + y + x])
    }
  }

  // only update if there are changes
  function eqSet (as, bs) {
    if (as.size !== bs.size) return false
    for (var a of as) if (!bs.has(a)) return false
    return true
  }
  if (!eqSet(newButtons, oldButtons)) {
    await pad.workOnBackgroundBuffer(async () => {
      const common = new Set(Array.from(oldButtons).filter(button => newButtons.has(button)))
      await Array.from(oldButtons).filter(button => !common.has(button)).map(button => pad.setSingleLED(button, Launchpad.Colors.Off))
      await Array.from(newButtons).filter(button => !common.has(button)).map(button => pad.setSingleLED(button, Launchpad.Colors.Green))
    })
  }

  oldButtons = newButtons
  setTimeout(updateColors, 0)
}

window.addEventListener('beforeunload', () => {
  pad.reset()
})
