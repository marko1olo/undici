'use strict'

const { RequestAbortedError } = require('../core/errors')

/**
 * @typedef {import('../../types/dispatcher.d.ts').default.DispatchHandler} DispatchHandler
 */

const DEFAULT_MAX_BUFFER_SIZE = 5 * 1024 * 1024

/**
 * @typedef {Object} WaitingHandler
 * @property {DispatchHandler} handler
 * @property {import('../../types/dispatcher.d.ts').default.DispatchController} controller
 * @property {Buffer[]} bufferedChunks
 * @property {number} bufferedBytes
 * @property {object | null} pendingTrailers
 * @property {boolean} done
 */

/**
 * Handler that forwards response events to multiple waiting handlers.
 * Used for request deduplication.
 *
 * @implements {DispatchHandler}
 */
class DeduplicationHandler {
  /**
   * @type {DispatchHandler}
   */
  #primaryHandler

  /**
   * @type {WaitingHandler[]}
   */
  #waitingHandlers = []

  /**
   * @type {number}
   */
  #maxBufferSize = DEFAULT_MAX_BUFFER_SIZE

  /**
   * @type {number}
   */
  #statusCode = 0

  /**
   * @type {Record<string, string | string[]>}
   */
  #headers = {}

  /**
   * @type {string}
   */
  #statusMessage = ''

  /**
   * @type {boolean}
   */
  #aborted = false

  /**
   * @type {boolean}
   */
  #responseStarted = false

  /**
   * @type {boolean}
   */
  #responseDataStarted = false

  /**
   * @type {boolean}
   */
  #completed = false

  /**
   * @type {import('../../types/dispatcher.d.ts').default.DispatchController | null}
   */
  #controller = null

  /**
   * @type {import('../../types/dispatcher.d.ts').default.DispatchController | null}
   */
  #primaryController = null

  /**
   * @type {boolean}
   */
  #primaryDone = false

  /**
   * @type {(() => void) | null}
   */
  #onComplete = null

  /**
   * @param {DispatchHandler} primaryHandler The primary handler
   * @param {() => void} onComplete Callback when request completes
   * @param {number} [maxBufferSize] Maximum paused buffer size per waiting handler
   */
  constructor (primaryHandler, onComplete, maxBufferSize = DEFAULT_MAX_BUFFER_SIZE) {
    this.#primaryHandler = primaryHandler
    this.#onComplete = onComplete
    this.#maxBufferSize = maxBufferSize
  }

  /**
   * Add a waiting handler that will receive response events.
   * Returns false if deduplication can no longer safely attach this handler.
   *
   * @param {DispatchHandler} handler
   * @returns {boolean}
   */
  addWaitingHandler (handler) {
    if (this.#completed || this.#responseDataStarted) {
      return false
    }

    const waitingHandler = this.#createWaitingHandler(handler)
    const waitingController = waitingHandler.controller

    try {
      handler.onRequestStart?.(waitingController, null)

      if (waitingController.aborted) {
        waitingHandler.done = true
        return true
      }

      if (this.#responseStarted) {
        handler.onResponseStart?.(
          waitingController,
          this.#statusCode,
          this.#headers,
          this.#statusMessage
        )
      }
    } catch {
      // Ignore errors from waiting handlers
      waitingHandler.done = true
      return true
    }

    if (!waitingController.aborted) {
      this.#waitingHandlers.push(waitingHandler)
    }

    return true
  }

  /**
   * @param {import('../../types/dispatcher.d.ts').default.DispatchController} controller
   * @param {any} context
   */
  onRequestStart (controller, context) {
    this.#controller = controller
    this.#primaryController = this.#createPrimaryController(controller)
    this.#primaryHandler.onRequestStart?.(this.#primaryController, context)
  }

  /**
   * @param {import('../../types/dispatcher.d.ts').default.DispatchController} controller
   * @param {number} statusCode
   * @param {import('../../types/header.d.ts').IncomingHttpHeaders} headers
   * @param {Socket} socket
   */
  onRequestUpgrade (controller, statusCode, headers, socket) {
    this.#primaryHandler.onRequestUpgrade?.(this.#primaryController, statusCode, headers, socket)
  }

  /**
   * @param {import('../../types/dispatcher.d.ts').default.DispatchController} controller
   * @param {number} statusCode
   * @param {Record<string, string | string[]>} headers
   * @param {string} statusMessage
   */
  onResponseStart (controller, statusCode, headers, statusMessage) {
    this.#responseStarted = true
    this.#statusCode = statusCode
    this.#headers = headers
    this.#statusMessage = statusMessage

    if (!this.#primaryDone) {
      this.#primaryHandler.onResponseStart?.(this.#primaryController, statusCode, headers, statusMessage)
    }

    for (const waitingHandler of this.#waitingHandlers) {
      const { handler, controller: waitingController } = waitingHandler

      if (waitingHandler.done || waitingController.aborted) {
        waitingHandler.done = true
        continue
      }

      try {
        handler.onResponseStart?.(
          waitingController,
          statusCode,
          headers,
          statusMessage
        )
      } catch {
        // Ignore errors from waiting handlers
      }

      if (waitingController.aborted) {
        waitingHandler.done = true
      }
    }

    this.#pruneDoneWaitingHandlers()
  }

  /**
   * @param {import('../../types/dispatcher.d.ts').default.DispatchController} controller
   * @param {Buffer} chunk
   */
  onResponseData (controller, chunk) {
    if (this.#aborted || this.#completed) {
      return
    }

    this.#responseDataStarted = true

    if (!this.#primaryDone) {
      this.#primaryHandler.onResponseData?.(this.#primaryController, chunk)
    }

    for (const waitingHandler of this.#waitingHandlers) {
      const { handler, controller: waitingController } = waitingHandler

      if (waitingHandler.done || waitingController.aborted) {
        waitingHandler.done = true
        continue
      }

      if (waitingController.paused) {
        this.#bufferWaitingChunk(waitingHandler, chunk)
        continue
      }

      try {
        handler.onResponseData?.(waitingController, chunk)
      } catch {
        // Ignore errors from waiting handlers
      }

      if (waitingController.aborted) {
        waitingHandler.done = true
        waitingHandler.bufferedChunks = []
        waitingHandler.bufferedBytes = 0
      }
    }

    this.#pruneDoneWaitingHandlers()
  }

  /**
   * @param {import('../../types/dispatcher.d.ts').default.DispatchController} controller
   * @param {object} trailers
   */
  onResponseEnd (controller, trailers) {
    if (this.#aborted || this.#completed) {
      return
    }

    this.#completed = true

    if (!this.#primaryDone) {
      this.#primaryHandler.onResponseEnd?.(this.#primaryController, trailers)
    }

    for (const waitingHandler of this.#waitingHandlers) {
      if (waitingHandler.done || waitingHandler.controller.aborted) {
        waitingHandler.done = true
        continue
      }

      this.#flushWaitingHandler(waitingHandler)

      if (waitingHandler.done || waitingHandler.controller.aborted) {
        waitingHandler.done = true
        continue
      }

      if (waitingHandler.controller.paused && waitingHandler.bufferedChunks.length > 0) {
        waitingHandler.pendingTrailers = trailers
        continue
      }

      try {
        waitingHandler.handler.onResponseEnd?.(waitingHandler.controller, trailers)
      } catch {
        // Ignore errors from waiting handlers
      }

      waitingHandler.done = true
    }

    this.#pruneDoneWaitingHandlers()
    this.#onComplete?.()
  }

  /**
   * @param {import('../../types/dispatcher.d.ts').default.DispatchController} controller
   * @param {Error} err
   */
  onResponseError (controller, err) {
    if (this.#completed) {
      return
    }

    this.#aborted = true
    this.#completed = true

    this.#errorPrimaryHandler(err)

    for (const waitingHandler of this.#waitingHandlers) {
      this.#errorWaitingHandler(waitingHandler, err)
    }

    this.#waitingHandlers = []
    this.#onComplete?.()
  }

  /**
   * The primary handler is one consumer of the shared request among many, so it
   * must not be able to abort the upstream request while other handlers are
   * still consuming it. Pause and resume are forwarded because the primary
   * handler is the only one reading directly from the connection.
   *
   * @param {import('../../types/dispatcher.d.ts').default.DispatchController} controller
   * @returns {import('../../types/dispatcher.d.ts').default.DispatchController}
   */
  #createPrimaryController (controller) {
    const state = {
      aborted: false,
      reason: null
    }

    return {
      resume: () => {
        if (!state.aborted) {
          controller.resume()
        }
      },
      pause: () => {
        if (!state.aborted) {
          controller.pause()
        }
      },
      get paused () { return controller.paused },
      get aborted () { return state.aborted },
      get reason () { return state.reason },
      // Writable, not just readable: an interceptor composed outside this one receives this
      // object as its controller and may rewrite the raw headers, as decompress() does when it
      // strips content-encoding. A getter on its own makes that a TypeError under strict mode.
      get rawHeaders () { return controller.rawHeaders },
      set rawHeaders (value) { controller.rawHeaders = value },
      get rawTrailers () { return controller.rawTrailers },
      set rawTrailers (value) { controller.rawTrailers = value },
      abort: (reason) => {
        if (state.aborted) {
          return
        }

        state.aborted = true
        state.reason = reason ?? null

        this.#errorPrimaryHandler(reason ?? new RequestAbortedError())

        if (this.#hasLiveWaitingHandler()) {
          // Other handlers still need the response to keep flowing.
          if (controller.paused) {
            controller.resume()
          }
        } else if (!this.#completed) {
          controller.abort(reason)
        }
      }
    }
  }

  /**
   * @param {Error} err
   */
  #errorPrimaryHandler (err) {
    if (this.#primaryDone) {
      return
    }

    this.#primaryDone = true

    try {
      this.#primaryHandler.onResponseError?.(this.#primaryController, err)
    } catch {
      // Ignore errors from the primary handler
    }
  }

  /**
   * @returns {boolean}
   */
  #hasLiveWaitingHandler () {
    return this.#waitingHandlers.some(waitingHandler => waitingHandler.done === false)
  }

  /**
   * @param {DispatchHandler} handler
   * @returns {WaitingHandler}
   */
  #createWaitingHandler (handler) {
    /** @type {WaitingHandler} */
    const waitingHandler = {
      handler,
      controller: null,
      bufferedChunks: [],
      bufferedBytes: 0,
      pendingTrailers: null,
      done: false
    }

    const state = {
      aborted: false,
      paused: false,
      reason: null
    }

    waitingHandler.controller = {
      resume: () => {
        if (state.aborted) {
          return
        }

        state.paused = false
        this.#flushWaitingHandler(waitingHandler)

        if (
          this.#completed &&
          waitingHandler.pendingTrailers &&
          waitingHandler.bufferedChunks.length === 0 &&
          !state.paused &&
          !state.aborted
        ) {
          try {
            waitingHandler.handler.onResponseEnd?.(waitingHandler.controller, waitingHandler.pendingTrailers)
          } catch {
            // Ignore errors from waiting handlers
          }

          waitingHandler.pendingTrailers = null
          waitingHandler.done = true
        }

        this.#pruneDoneWaitingHandlers()
      },
      pause: () => {
        if (!state.aborted) {
          state.paused = true
        }
      },
      get paused () { return state.paused },
      get aborted () { return state.aborted },
      get reason () { return state.reason },
      abort: (reason) => {
        state.aborted = true
        state.reason = reason ?? null
        waitingHandler.done = true
        waitingHandler.pendingTrailers = null
        waitingHandler.bufferedChunks = []
        waitingHandler.bufferedBytes = 0

        if (this.#primaryDone && !this.#completed && !this.#hasLiveWaitingHandler()) {
          this.#controller.abort(reason)
        }
      }
    }

    return waitingHandler
  }

  /**
   * @param {WaitingHandler} waitingHandler
   * @param {Buffer} chunk
   */
  #bufferWaitingChunk (waitingHandler, chunk) {
    if (waitingHandler.done || waitingHandler.controller.aborted) {
      waitingHandler.done = true
      waitingHandler.bufferedChunks = []
      waitingHandler.bufferedBytes = 0
      return
    }

    const bufferedChunk = Buffer.from(chunk)
    waitingHandler.bufferedChunks.push(bufferedChunk)
    waitingHandler.bufferedBytes += bufferedChunk.length

    if (waitingHandler.bufferedBytes > this.#maxBufferSize) {
      const err = new RequestAbortedError(`Deduplicated waiting handler exceeded maxBufferSize (${this.#maxBufferSize} bytes) while paused`)
      this.#errorWaitingHandler(waitingHandler, err)
    }
  }

  /**
   * @param {WaitingHandler} waitingHandler
   */
  #flushWaitingHandler (waitingHandler) {
    const { handler, controller } = waitingHandler

    while (
      !waitingHandler.done &&
      !controller.aborted &&
      !controller.paused &&
      waitingHandler.bufferedChunks.length > 0
    ) {
      const bufferedChunk = waitingHandler.bufferedChunks.shift()
      waitingHandler.bufferedBytes -= bufferedChunk.length

      try {
        handler.onResponseData?.(controller, bufferedChunk)
      } catch {
        // Ignore errors from waiting handlers
      }

      if (controller.aborted) {
        waitingHandler.done = true
        waitingHandler.pendingTrailers = null
        waitingHandler.bufferedChunks = []
        waitingHandler.bufferedBytes = 0
        break
      }
    }
  }

  /**
   * @param {WaitingHandler} waitingHandler
   * @param {Error} err
   */
  #errorWaitingHandler (waitingHandler, err) {
    if (waitingHandler.done) {
      return
    }

    waitingHandler.done = true
    waitingHandler.pendingTrailers = null
    waitingHandler.bufferedChunks = []
    waitingHandler.bufferedBytes = 0

    try {
      waitingHandler.controller.abort(err)
      waitingHandler.handler.onResponseError?.(waitingHandler.controller, err)
    } catch {
      // Ignore errors from waiting handlers
    }
  }

  #pruneDoneWaitingHandlers () {
    this.#waitingHandlers = this.#waitingHandlers.filter(waitingHandler => waitingHandler.done === false)
  }
}

module.exports = DeduplicationHandler
