/**
 * Same-origin, bounded requests; mutations are never automatically retried. A request with data
 * is a PUT unless another method is named; a DELETE may carry no data at all.
 */
export async function marketRequest(path, data, method = data === undefined ? 'GET' : 'PUT') {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25000)
  try {
    const mutation = data !== undefined
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
      headers: mutation ? { 'content-type': 'application/json' } : {},
      ...(mutation ? { body: JSON.stringify(data) } : {}),
    })
    let value
    try {
      value = await response.json()
    } catch {
      const error = new Error('服务返回了无效响应，请稍后刷新重试。')
      error.status = response.status
      throw error
    }
    if (!response.ok) {
      const error = new Error(
        typeof value?.error === 'string'
          ? value.error
          : '请求失败，请稍后重试。',
      )
      error.status = response.status
      error.retryAfter = Number(response.headers.get('retry-after')) || null
      throw error
    }
    return value
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error(
        '请求超时。若刚才正在保存，请先刷新核对结果，再决定是否重试。',
      )
    if (error instanceof TypeError)
      throw new Error('网络连接失败，请检查网络后重试。')
    throw error
  } finally {
    clearTimeout(timer)
  }
}
