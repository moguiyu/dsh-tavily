/** Tavily implementation of DSH's `ctx.web` search-provider seam. */
import { WebError } from '@deepseek-ai/dsh-web'
import { TavilyApiError } from './tavily.js'

export const TAVILY_PROVIDER_ID = 'tavily'

/** Map a Tavily search envelope into DSH's portable citation result. */
export function mapTavilySearchResponse(response) {
  const sources = Array.isArray(response?.results)
    ? response.results.flatMap((result) => {
      if (result === null || typeof result !== 'object' || typeof result.url !== 'string' || result.url.length === 0) return []
      const snippet = typeof result.content === 'string' ? result.content.trim() : ''
      if (snippet.length === 0) return []
      return [{
        url: result.url,
        ...(typeof result.title === 'string' && result.title.length > 0 ? { title: result.title } : {}),
        snippet,
        ...(typeof result.published_date === 'string' && result.published_date.length > 0 ? { publishedAt: result.published_date } : {}),
      }]
    })
    : []
  const answer = typeof response?.answer === 'string' ? response.answer.trim() : ''
  return {
    ...(answer.length > 0 ? { content: answer } : {}),
    sources,
    truncated: false,
  }
}

function asWebError(error) {
  if (error instanceof TavilyApiError) {
    if (error.code === 'aborted') return new WebError(error.message, 'WEB_ABORTED', { cause: error })
    if (error.code === 'missing_credential' || error.code === 'credential_error') {
      return new WebError(error.message, 'WEB_MISSING_CREDENTIAL', { cause: error })
    }
  }
  return new WebError(error instanceof Error ? error.message : String(error), 'WEB_PROVIDER_ERROR', { cause: error })
}

/** A Tavily search provider registered under the stable `tavily` id. */
export class TavilySearchProvider {
  constructor(client) {
    this.client = client
  }

  id = TAVILY_PROVIDER_ID

  available() {
    return this.client.available()
  }

  async search(request, signal) {
    try {
      const response = await this.client.request('search', {
        query: request.query,
        ...(request.maxResults === undefined ? {} : { max_results: request.maxResults }),
        include_answer: true,
        search_depth: 'basic',
      }, signal)
      return mapTavilySearchResponse(response)
    } catch (error) {
      throw asWebError(error)
    }
  }
}
