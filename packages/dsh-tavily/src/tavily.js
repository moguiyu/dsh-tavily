/**
 * Shared Tavily API transport for the web-search provider and direct tools.
 */

export const TAVILY_BASE_URL = 'https://api.tavily.com'

/** Error raised when a Tavily operation cannot produce a successful response. */
export class TavilyApiError extends Error {
  constructor(message, code, cause) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'TavilyApiError'
    this.code = code
  }
}

function errorMessage(payload, status) {
  if (payload !== null && typeof payload === 'object') {
    const candidates = [
      payload.error,
      payload.message,
      payload.detail,
      payload.detail !== null && typeof payload.detail === 'object' ? payload.detail.error : undefined,
      payload.detail !== null && typeof payload.detail === 'object' ? payload.detail.message : undefined,
    ]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.length > 0) return candidate
    }
  }
  return 'Tavily API error (HTTP ' + status + ')'
}

function isAborted(error, signal) {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
}

function abortedError(cause) {
  return new TavilyApiError('Tavily request was aborted', 'aborted', cause)
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) throw abortedError(signal.reason)
}

/**
 * A request client that resolves the key list on every operation and retries a
 * different key after Tavily rejects or rate-limits the selected one.
 */
export class TavilyApiClient {
  constructor({ resolveKeys, baseURL = TAVILY_BASE_URL }) {
    this.resolveKeys = resolveKeys
    this.baseURL = baseURL.replace(/\/+$/, '')
    this.rotation = 0
  }

  available() {
    return URL.canParse(this.baseURL)
  }

  async request(operation, body, signal) {
    throwIfAborted(signal)
    let keys
    try {
      keys = await this.resolveKeys()
    } catch (error) {
      if (isAborted(error, signal)) throw abortedError(error)
      throw new TavilyApiError('Tavily credentials could not be resolved', 'credential_error', error)
    }
    throwIfAborted(signal)
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new TavilyApiError('Tavily API key is not configured', 'missing_credential')
    }

    let lastStatus = 0
    const start = this.rotation
    for (let attempt = 0; attempt < keys.length; attempt++) {
      throwIfAborted(signal)
      const index = (start + attempt) % keys.length
      const key = keys[index]
      let response
      try {
        response = await fetch(this.baseURL + '/' + operation, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: 'Bearer ' + key,
            'user-agent': 'dsh-tavily/0.2.0',
          },
          body: JSON.stringify(body),
          ...(signal === undefined ? {} : { signal }),
        })
      } catch (error) {
        if (isAborted(error, signal)) throw abortedError(error)
        throw new TavilyApiError('Tavily request failed: ' + String(error), 'request_failed', error)
      }

      throwIfAborted(signal)

      if (response.status === 401 || response.status === 429) {
        lastStatus = response.status
        this.rotation = (index + 1) % keys.length
        continue
      }
      if (!response.ok) {
        let payload
        try {
          payload = await response.json()
        } catch (error) {
          if (isAborted(error, signal)) throw abortedError(error)
        }
        throwIfAborted(signal)
        throw new TavilyApiError(errorMessage(payload, response.status), 'provider_error')
      }

      try {
        const payload = await response.json()
        throwIfAborted(signal)
        this.rotation = (index + 1) % keys.length
        return payload
      } catch (error) {
        if (error instanceof TavilyApiError && error.code === 'aborted') throw error
        if (isAborted(error, signal)) throw abortedError(error)
        throw new TavilyApiError('Tavily returned an unprocessable response body: ' + String(error), 'provider_error', error)
      }
    }

    throw new TavilyApiError('All configured Tavily API keys failed with HTTP ' + lastStatus, 'all_keys_failed')
  }
}
