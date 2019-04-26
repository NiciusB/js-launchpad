/**
 * Launchpad class
 * Manage access and interact with the Launchpad
 *
 * It wraps all of the launchpad available MIDI functionalities in a neat js API
 * https://d2xhy469pqj8rc.cloudfront.net/sites/default/files/novation/downloads/4080/launchpad-programmers-reference.pdf
 */
class Launchpad {
  /**
   * Constructor
   * @param  {String|RegExp} deviceName Name to match the MIDI device
   */
  constructor (deviceName = /Launchpad( \w+)?/) {
    this.deviceName = deviceName
    this.input = null
    this.output = null
    this.listeners = {
      pressed: [],
      released: [],
      led_changed: []
    }
    this._pressedButtons = new Set()
    this.leds = {}
  }

  /* Public commands **********************************/

  /**
   * All LEDs are turned off, and the mapping mode, buffer settings,
   * and duty cycle are reset to their default values.
   */
  async reset () {
    await this._midiSend(0xB0, 0, 0)
    this.flashingBuffers = 0
    this.displayingBuffer = 0
    this.updatingBuffer = 0
    this.ledBuffers = {
      0: {},
      1: {}
    }
    Object.keys(Launchpad.Buttons).forEach(buttonName => {
      this.ledBuffers[0][buttonName] = this.ledBuffers[1][buttonName] = Launchpad.Colors.Off
    })
    this._dispatchListener('led_changed')
  }

  /**
   * Set all LEDs on, in both buffers.
   * @param  {string} brightness Brightness level ('low'/'medium'/'high'). Defaults to medium
   */
  async allLEDsOn (brightness = 'medium') {
    const brightnessMap = {
      low: 0x7D,
      medium: 0x7E,
      high: 0x7F
    }
    if (!brightnessMap[brightness]) brightness = 'medium'

    await this._midiSend(0xB0, 0x00, brightnessMap[brightness])
    Object.keys(Launchpad.Buttons).forEach(buttonName => {
      const color = Launchpad.Colors[brightness === 'low' ? 'AmberLow' : (brightness === 'medium' ? 'AmberMed' : 'Amber')]
      this.ledBuffers[0][buttonName] = this.ledBuffers[1][buttonName] = color
    })
    this._dispatchListener('led_changed')
  }

  /**
   * Set the color value for a button in the `updating` buffer
   * @param {Object} button Button to set
   * @param {number} color Color value to set
   * @param {Boolean} changeInBothBuffers If true, change value on the other buffer as well. Defaults to false. Overrides turnOffInOtherBuffer if true
   * @param {Boolean} turnOffInOtherBuffer If true, clear the other buffer's copy of this LED. Defaults to false.
   */
  async setSingleLED (button, color, changeInBothBuffers, turnOffInOtherBuffer) {
    if (!button || typeof button !== 'object' || (button._note_key === undefined && button._automap_key === undefined)) throw new Error('Invalid button')
    const velocity = this._colorToMIDIVelocity(color, changeInBothBuffers, turnOffInOtherBuffer)

    const ledID = button._note_key !== undefined ? button._note_key : button._automap_key
    await this._midiSend(button._note_key !== undefined ? 0x90 : 0xB0, ledID, velocity)
    this.ledBuffers[this.updatingBuffer][button.name] = color
    this._dispatchListener('led_changed')
  }

  /**
   * Switch buffer being displayed
   */
  async switchDisplayingBuffer () {
    if (!this.displayingBuffer) this.displayingBuffer = 0
    this.displayingBuffer = this.displayingBuffer === 1 ? 0 : 1
    await this._updateBufferStatus()
  }

  /**
   * Switch working buffer where led updates are pushed to
   * @param {Boolean} copy If true, copy the LED states from the new buffer to the old buffer
   */
  async switchUpdatingBuffer (copy) {
    if (!this.updatingBuffer) this.updatingBuffer = 0
    this.updatingBuffer = this.updatingBuffer === 1 ? 0 : 1
    await this._updateBufferStatus(copy)
  }

  /**
   * Switch flashing between buffers
   */
  async switchFlash () {
    this.flashingBuffers = !this.flashingBuffers
    await this._updateBufferStatus()
  }

  /**
   * A more powerful version of changePadBrightness.
   * Launchpad controls the brightness of its LEDs by continually switching them on and off faster than the eye can see: a technique known as multiplexing.
   * This command provides a way of altering the proportion of time for which the LEDs are on while they are in low and medium brightness modes.
   * This proportion is known as the duty cycle.
   * Manipulating this is useful for fade effects, for adjusting contrast, and for creating custom palettes.
   * @param  {number} numerator Numerator (1-16)
   * @param  {number} denominator Denominator (3-18)
   */
  async setDutyCycle (numerator, denominator) {
    if (numerator < 1 || numerator > 16) throw new Error('Invalid numerator')
    if (denominator < 3 || denominator > 18) throw new Error('Invalid denominator')
    if (numerator < 9) {
      await this._midiSend(0xB0, 0x1E, 16 * (numerator - 1) + (denominator - 3))
    } else {
      await this._midiSend(0xB0, 0x1F, 16 * (numerator - 9) + (denominator - 3))
    }
  }

  /**
   * Change LEDs brightness of the dimmer colors. The higher the brightness, the more similar the colors. It also affects flicker on cameras
   * At level 5, there are basically only 3 colors: amber, red, and green
   * @param  {number} brightness Brightness level (1-5). Defaults to 1.
   */
  async setBrightness (brightness = 1) {
    switch (brightness) {
      case 1: await this.setDutyCycle(1, 5); break
      case 2: await this.setDutyCycle(2, 5); break
      case 3: await this.setDutyCycle(3, 5); break
      case 4: await this.setDutyCycle(4, 5); break
      case 5: await this.setDutyCycle(5, 5); break
      default: throw new Error('Invalid brightness')
    }
  }

  /**
   * Set the color value for all the buttons in the `updating` buffer by providing all the values in a array
   * It's about twice as fast as updating every single one, but it's still noticeable
   *
   * This will update the 8x8 grid in left-to-right, top-to-bottom order,
   * then the eight scene launch buttons in top-to-bottom order,
   * and finally the eight Automap/Live buttons in left-to-right order
   * @param  {array} colors Array of 80 color values
   */
  async setMultipleLED (colors) {
    if (!colors || typeof colors !== 'object') throw new Error('Invalid argument type. Must be array of colors')
    if (!colors.length) throw new Error('Invalid colors array: Can not be empty')
    if (colors.length > 80) throw new Error('Invalid colors array: Can not have more than 80 elements')

    const listOfButtons = this.getOrderedButtons('forBatch')

    const velocities = colors.map(color => this._colorToMIDIVelocity(color))
    for (var i = 0; i < velocities.length; i += 2) {
      await this._midiSend(0x92, velocities[i], velocities[i + 1])
      this.ledBuffers[this.updatingBuffer][listOfButtons[i].name] = colors[i]
      if (colors[i + 1]) this.ledBuffers[this.updatingBuffer][listOfButtons[i + 1].name] = colors[i + 1]
    }

    // Send useless command to clear MIDI state and allow another setMultipleLED inmediatly
    await this.setSingleLED(Launchpad.Buttons['00'], colors[0])
    this._dispatchListener('led_changed')
  }

  /**
   * Check whether a buttton is pressed
   * @param  {Object} button Button to check
   * @return {Boolean} Whether it is pressed
   */
  isButtonPressed (button) {
    return this._pressedButtons.has(button)
  }

  /**
   * Returns list of buttons in order
   * @param {*} order Order: physical or forBatch
   */
  getOrderedButtons (order = 'physical') {
    if (!this._cachedOrderedButtons) this._cachedOrderedButtons = {}
    if (!this._cachedOrderedButtons[order]) {
      if (order === 'physical') {
        // Prepare button list in the same order as the launchpad uses to update internal LED buffer copy
        const listOfButtons = []
        listOfButtons.push('Up', 'Down', 'Left', 'Right', 'Session', 'User1', 'User2', 'Mixer')
        const sideBar = ['Vol', 'Pan', 'SendA', 'SendB', 'Stop', 'TrackOn', 'Solo', 'Arm']
        for (let y = 0; y <= 7; y++) {
          for (let x = 0; x <= 7; x++) {
            listOfButtons.push(`${x}${y}`)
          }
          listOfButtons.push(sideBar[y])
        }
        this._cachedOrderedButtons[order] = listOfButtons.map(name => Launchpad.Buttons[name])
      } else if (order === 'forBatch') {
        // Prepare button list in the same order as the launchpad uses to update internal LED buffer copy
        const listOfButtons = []
        for (let y = 0; y <= 7; y++) {
          for (let x = 0; x <= 7; x++) {
            listOfButtons.push(`${x}${y}`)
          }
        }
        listOfButtons.push('Vol', 'Pan', 'SendA', 'SendB', 'Stop', 'TrackOn', 'Solo', 'Arm', 'Up', 'Down', 'Left', 'Right', 'Session', 'User1', 'User2', 'Mixer')
        this._cachedOrderedButtons[order] = listOfButtons.map(name => Launchpad.Buttons[name])
      }
    }
    return this._cachedOrderedButtons[order]
  }

  /**
   * Events
   */

  /**
   * Add a listener for button presses
   * @param  {function} callback Listener to call
   * @return {function}          Function to stop listening
   */
  onButtonPressed (callback) {
    if (!callback || typeof callback !== 'function') throw new Error('Invalid callback function')

    const listenerIndex = this.listeners.pressed.push({
      callback
    }) - 1
    return () => {
      this.listeners.pressed.splice(listenerIndex, 1)
    }
  }

  /**
   * Add a listener for button releases
   * @param  {function} callback Listener to call
   * @return {function}          Function to stop listening
   */
  onButtonReleased (callback) {
    if (!callback || typeof callback !== 'function') throw new Error('Invalid callback function')

    const listenerIndex = this.listeners.released.push({
      callback
    }) - 1
    return () => {
      this.listeners.released.splice(listenerIndex, 1)
    }
  }

  /**
   * Add a listener for LED changes
   * @param  {function} callback Listener to call
   * @return {function}          Function to stop listening
   */
  onLedChanged (callback) {
    if (!callback || typeof callback !== 'function') throw new Error('Invalid callback function')

    const listenerIndex = this.listeners.led_changed.push({
      callback
    }) - 1
    return () => {
      this.listeners.led_changed.splice(listenerIndex, 1)
    }
  }

  /**
   * Fake a button being pressed
   * @param {Object} button Button
   */
  dispatchButtonPressed (button) {
    this._dispatchListener('pressed', button)
  }

  /**
   * Fake a button being released
   * @param {Object} button Button
   */
  dispatchButtonReleased (button) {
    this._dispatchListener('released', button)
  }
  /**
   * Helper function to modify current buffer without the changes happening in real time
   * It copies the current content to the other buffer, shows the copy while it executes the work, and goes back to the updated buffer once finished
   * @param {Promise} promise Work to be done
   */
  async workOnBackgroundBuffer (promise) {
    await this.switchUpdatingBuffer(true)
    await this.switchUpdatingBuffer()
    await this.switchDisplayingBuffer()
    if (typeof promise === 'function') await promise()
    else await promise
    await this.switchDisplayingBuffer()
  }

  /**
   * Lifecycle stuff
   */

  /**
   * Get the accessed device.
   * If null, please call `accessDevice` first.
   * @return {[type]} [description]
   */
  isConnected () {
    return this.input && this.output
  }

  /**
   * Start to load all the required assets from the
   * list provided to the constructor
   *
   * @return {promise} Is the load a success?
   */
  accessDevice () {
    return window.navigator
      .requestMIDIAccess()
      .then(access => {
        // Test deprecated browsers
        if (typeof access.inputs === 'function' || !access.inputs) {
          throw new Error('Your browser is deprecated and use an old Midi API.')
        }

        // Get MIDI devices
        const inputs = Array.from(access.inputs.values())
        for (let i = 0; i < inputs.length; i++) {
          const input = inputs[i]
          if (input.type === 'input' && input.name.match(this.deviceName)) {
            this.input = input
            this.input.onmidimessage = e => {
              this._midiMessageListener(e.data)
            }
          }
        }

        const outputs = Array.from(access.outputs.values())
        for (let i = 0; i < outputs.length; i++) {
          const output = outputs[i]
          if (output.type === 'output' && output.name.match(this.deviceName)) {
            this.output = output
          }
        }

        if (this.input && this.output) {
          // Reset state, just in case there was any
          this.reset()
          return this
        }

        // No device found
        throw new Error(`Device ${this.deviceName} not found.`)
      })
  }

  /* Private functions **********************************/

  _dispatchListener (listener, data) {
    this.listeners[listener].forEach(listener => {
      listener.callback(data)
    })
  }

  async _midiSend () {
    this.output.send(new Uint8Array(arguments))
  }

  async _updateBufferStatus (copy) {
    /**
     * Protocol:
     *  Display: Set buffer 0 or buffer 1 as the new ‘displaying’ buffer.
     *  Update: Set buffer 0 or buffer 1 as the new ‘updating’ buffer.
     *  Flash: If 1: continually flip ‘displayed’ buffers to make selected LEDs flash.
     *  Copy: If 1: copy the LED states from the new ‘displayed’ buffer to the new ‘updating’ buffer.
     */
    const display = this.displayingBuffer
    const update = this.updatingBuffer
    const flash = this.flashingBuffers ? 1 : 0
    copy = copy ? 1 : 0
    await this._midiSend(0xB0, 0x00, 32 + display + update * 4 + flash * 8 + copy * 16)
    if (copy) this._dispatchListener('led_changed')
  }

  _colorToMIDIVelocity (color, changeInBothBuffers = false, turnOffInOtherBuffer = false) {
    if (!color || typeof color !== 'object' || (color.r === undefined && color.g === undefined)) throw new Error('Invalid color')
    turnOffInOtherBuffer = turnOffInOtherBuffer ? 8 : 0
    changeInBothBuffers = changeInBothBuffers ? 12 : 0
    return turnOffInOtherBuffer + changeInBothBuffers + color.r + color.g * 16
  }

  _midiMessageListener (data) {
    if (data.length !== 3) return false // Unknown packet
    // Parse if it's pressed or released
    let type
    switch (data[2]) {
      case 0x7F: type = 'pressed'; break
      case 0x0: type = 'released'; break
    }
    if (!type) return false

    let button
    for (let i of Object.keys(Launchpad.Buttons)) {
      const keyToSearch = data[0] === 0x90 ? '_note_key' : '_automap_key'
      if (Launchpad.Buttons[i][keyToSearch] === data[1]) {
        button = Launchpad.Buttons[i]
        break
      }
    }
    if (!button) return false

    if (type === 'pressed') this._pressedButtons.add(button)
    else if (type === 'released') this._pressedButtons.delete(button)

    this._dispatchListener(type, button)
  }
}

/**
 * Button color constants
 * @type {Object}
 */
Launchpad.Colors = {}
Launchpad.Colors.Off = colorGenerator('Off', 0, 0, '#555555')
Launchpad.Colors.GreenLow = colorGenerator('GreenLow', 0, 1, '#687b49')
Launchpad.Colors.GreenMed = colorGenerator('GreenMed', 0, 2, '#8a9f47')
Launchpad.Colors.Green = colorGenerator('Green', 0, 3, '#a8cc36')
Launchpad.Colors.RedLow = colorGenerator('RedLow', 1, 0, '#8a4b4b')
Launchpad.Colors.RedMed = colorGenerator('RedMed', 2, 0, '#a14e4e')
Launchpad.Colors.Red = colorGenerator('Red', 3, 0, '#e02323')
Launchpad.Colors.OrangeMed = colorGenerator('OrangeMed', 2, 1, '#ca6919')
Launchpad.Colors.Orange = colorGenerator('Orange', 3, 2, '#db7018')
Launchpad.Colors.YellowMed = colorGenerator('YellowMed', 1, 2, '#bbad25')
Launchpad.Colors.Yellow = colorGenerator('Yellow', 2, 3, '#dbc708')
Launchpad.Colors.AmberLow = colorGenerator('AmberLow', 1, 1, '#9f721a')
Launchpad.Colors.AmberMed = colorGenerator('AmberMed', 2, 2, '#c18819')
Launchpad.Colors.Amber = colorGenerator('Amber', 3, 3, '#ffba32')
Launchpad.Colors.Lime = colorGenerator('Lime', 1, 3, '#d0e021')
Launchpad.Colors.OrangeRed = colorGenerator('OrangeRed', 3, 1, '#f3581f')

function colorGenerator (name, r, g, htmlColorCode) {
  const color = {}
  Object.defineProperty(color, 'name', {
    value: name,
    enumerable: true,
    writable: false
  })
  Object.defineProperty(color, 'r', {
    value: r,
    enumerable: false,
    writable: false
  })
  Object.defineProperty(color, 'g', {
    value: g,
    enumerable: false,
    writable: false
  })
  Object.defineProperty(color, 'htmlColorCode', {
    value: htmlColorCode,
    enumerable: true,
    writable: false
  })
  return color
}

/**
 * Button constants
 * @type {Number}
 */
Launchpad.Buttons = {}
for (let y = 0; y <= 7; y++) {
  for (let x = 0; x <= 7; x++) {
    Launchpad.Buttons[`${x}${y}`] = buttonGenerator({ name: `${x}${y}`, x, y, _note_key: x + y * 16 })
  }
}
Launchpad.Buttons.Vol = buttonGenerator({ name: 'Vol', _note_key: 8 })
Launchpad.Buttons.Pan = buttonGenerator({ name: 'Pan', _note_key: 24 })
Launchpad.Buttons.SendA = buttonGenerator({ name: 'SendA', _note_key: 40 })
Launchpad.Buttons.SendB = buttonGenerator({ name: 'SendB', _note_key: 56 })
Launchpad.Buttons.Stop = buttonGenerator({ name: 'Stop', _note_key: 72 })
Launchpad.Buttons.TrackOn = buttonGenerator({ name: 'TrackOn', _note_key: 88 })
Launchpad.Buttons.Solo = buttonGenerator({ name: 'Solo', _note_key: 104 })
Launchpad.Buttons.Arm = buttonGenerator({ name: 'Arm', _note_key: 120 })
Launchpad.Buttons.Up = buttonGenerator({ name: 'Up', _automap_key: 104 })
Launchpad.Buttons.Down = buttonGenerator({ name: 'Down', _automap_key: 105 })
Launchpad.Buttons.Left = buttonGenerator({ name: 'Left', _automap_key: 106 })
Launchpad.Buttons.Right = buttonGenerator({ name: 'Right', _automap_key: 107 })
Launchpad.Buttons.Session = buttonGenerator({ name: 'Session', _automap_key: 108 })
Launchpad.Buttons.User1 = buttonGenerator({ name: 'User1', _automap_key: 109 })
Launchpad.Buttons.User2 = buttonGenerator({ name: 'User2', _automap_key: 110 })
Launchpad.Buttons.Mixer = buttonGenerator({ name: 'Mixer', _automap_key: 111 })

function buttonGenerator (data) {
  const button = {}
  for (let key in data) {
    Object.defineProperty(button, key, {
      value: data[key],
      enumerable: key.charAt(0) !== '_',
      writable: false
    })
  }
  return button
}

module.exports.default = Launchpad
