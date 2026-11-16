import { BrowserError } from './errors.ts'

export function assertAllowedUrl(input: string, domains: readonly string[] = []): URL {
  let url: URL
  try { url = new URL(input) } catch {
    throw new BrowserError('URL_NOT_ALLOWED', 'Enter an absolute HTTP(S) URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrowserError('URL_NOT_ALLOWED', 'Only HTTP(S) URLs can be opened.')
  }
  if (url.username || url.password) throw new BrowserError('URL_NOT_ALLOWED', 'URLs with credentials are disabled.')
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (domains.length && !domains.some(domain => host === domain || host.endsWith('.' + domain))) {
    throw new BrowserError('URL_NOT_ALLOWED', 'This host is outside allowedDomains.')
  }
  return url
}
