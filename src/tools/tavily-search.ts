/**
 * Tavily 搜索工具
 * 专为 AI 智能体优化的搜索引擎
 * 返回经过清洗的纯文本摘要，可直接作为大模型上下文
 */

export interface SearchResult {
  title: string // 文章标题
  url: string // 来源 URL
  content: string // 纯文本摘要
  score: number // 相关性分数（0-1）
}

export class TavilySearch {
  private apiKey: string
  private baseUrl = 'https://api.tavily.com/search'

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  /**
   * 执行搜索
   * @param query 搜索关键词
   * @param maxResults 最大返回结果数，默认 5
   * @returns 搜索结果数组
   */
  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    console.log(`[TavilySearch] 搜索：${query}`)

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          query,
          max_results: maxResults,
          search_depth: 'basic',
          include_answer: false,
          include_raw_content: false,
        }),
      })

      if (!response.ok) {
        throw new Error(
          `Tavily API 错误：${response.status} ${response.statusText}`,
        )
      }

      const data = (await response.json()) as {
        results: Array<{
          title: string
          url: string
          content: string
          score: number
        }>
      }

      console.log(`[TavilySearch] 获取到 ${data.results.length} 条结果`)

      return data.results.map((r) => ({
        title: r.title,
        url: r.url,
        // 截取前 800 字，控制单条结果的 Token 消耗
        // 5 条 × 800 字 ≈ 4000 字，加上其他内容不超过模型上下文限制
        content: r.content.slice(0, 800),
        score: r.score,
      }))
    } catch (err) {
      console.error('[TavilySearch] 搜索失败：', err)
      return []
    }
  }
}
