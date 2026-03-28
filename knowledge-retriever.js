// 改进版：智能知识库检索
// 不再全量注入所有80个类别，而是根据用户描述匹配最相关的3-5个类别

class SmartKnowledgeRetriever {
  constructor(knowledgeBase) {
    this.categories = knowledgeBase.categories || []
    // 为每个类别构建关键词索引
    this.buildIndex()
  }

  // 构建关键词索引（从类别名称和核心规则中提取关键词）
  buildIndex() {
    this.index = this.categories.map(cat => {
      const keywords = [
        cat.category.split('·')[0], // 主类别
        cat.category.split('·')[1] || '', // 子类别
        ...cat.core_rules.map(rule => {
          // 从规则中提取中文关键词（2-4字）
          return (rule.match(/[\u4e00-\u9fa5]{2,4}/g) || [])
        }),
        // 从提示词模板中提取英文关键词
        ...(cat.prompt_template.match(/[a-z]{3,}/gi) || [])
      ]

      return {
        ...cat,
        keywords: [...new Set(keywords)] // 去重
      }
    })
  }

  // 根据用户描述检索最相关的类别
  retrieve(description, topK = 5) {
    // 提取用户描述中的关键词
    // 策略1：提取连续的2-20字符（避免整句被提取）
    let chineseWords = []
    const chineseRaw = description.match(/[\u4e00-\u9fa5]{2,}/g) || []
    chineseRaw.forEach(word => {
      const maxLen = 20
      if (word.length > maxLen) {
        for (let i = 0; i < word.length; i += maxLen) {
          chineseWords.push(word.slice(i, i + maxLen))
        }
      } else {
        chineseWords.push(word)
      }
    })

    // 策略2：提取所有2-4字子串（提高匹配覆盖率）
    const chineseSubstrings = []
    const allChineseText = description.replace(/[^\u4e00-\u9fa5]/g, '')
    for (let len = 2; len <= Math.min(4, allChineseText.length); len++) {
      for (let i = 0; i <= allChineseText.length - len; i++) {
        const substr = allChineseText.slice(i, i + len)
        if (!chineseSubstrings.includes(substr)) {
          chineseSubstrings.push(substr)
        }
      }
    }

    const userKeywords = [
      ...chineseWords, // 中等长度词
      ...chineseSubstrings, // 2-4字子串
      ...(description.match(/[a-zA-Z]{3,}/g) || []) // 英文词（3字以上）
    ]

    // 计算每个类别的匹配分数
    const scores = this.index.map(cat => {
      let score = 0

      // 类别名称完整包含用户词（超高分）
      const categoryText = cat.category.toLowerCase()
      userKeywords.forEach(userKeyword => {
        if (categoryText.includes(userKeyword.toLowerCase())) {
          score += 5
        }
      })

      // 用户词完整包含类别名（高分）
      const descriptionLower = description.toLowerCase()
      const categoryWords = cat.category.split(/[·\s]+/)
      categoryWords.forEach(catWord => {
        if (descriptionLower.includes(catWord.toLowerCase())) {
          score += 3
        }
      })

      // 关键词匹配（中分）
      cat.keywords.forEach(keyword => {
        if (typeof keyword !== 'string') return
        userKeywords.forEach(userKeyword => {
          if (typeof userKeyword !== 'string') return

          const keywordLower = keyword.toLowerCase()
          const userKeywordLower = userKeyword.toLowerCase()

          // 完整匹配
          if (keywordLower === userKeywordLower) {
            score += 3
          }
          // 包含匹配
          else if (userKeywordLower.includes(keywordLower) || keywordLower.includes(userKeywordLower)) {
            score += 1
          }
        })
      })

      // 核心规则内容匹配（低分）
      cat.core_rules.forEach(rule => {
        userKeywords.forEach(userKeyword => {
          if (rule.includes(userKeyword)) {
            score += 0.5
          }
        })
      })

      return { ...cat, score }
    })

    // 按分数排序，取 topK
    return scores
      .filter(cat => cat.score > 0) // 必须有至少1分
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
  }

  // 格式化匹配的类别为 system prompt
  formatPrompt(matchedCategories) {
    if (matchedCategories.length === 0) {
      return '// 没有匹配的知识库类别，使用通用规则'
    }

    return `
=== 匹配的知识库类别（${matchedCategories.length}个，按相关度排序） ===

${matchedCategories.map((cat, idx) => `
【匹配 ${idx + 1}】${cat.category}（相关度：${cat.score}）
核心规则：
${cat.core_rules.map(rule => `  - ${rule}`).join('\n')}

正向模板：
${cat.prompt_template}

负向模板：
${cat.negative_prompt}
`).join('\n---\n')}

=== 知识库结束 ===`
  }
}

// 测试示例
if (require.main === module) {
  const fs = require('fs')
  const path = require('path')

  const KNOWLEDGE_FILE = path.join(__dirname, 'knowledge.json')
  const knowledgeBase = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf-8'))

  const retriever = new SmartKnowledgeRetriever(knowledgeBase)

  console.log('🔍 测试智能检索\n')

  const testQueries = [
    '一个写实风格的人像',
    '江南水乡的风景',
    '赛博朋克动漫风格',
    '古风汉服美女',
    '海边日出'
  ]

  testQueries.forEach(query => {
    console.log(`📝 查询：${query}`)
    const matches = retriever.retrieve(query, 3)
    console.log(`   匹配结果：${matches.length} 个`)
    matches.forEach((m, i) => {
      console.log(`     ${i + 1}. ${m.category}（分数：${m.score}）`)
    })
    console.log()
  })
}

module.exports = SmartKnowledgeRetriever
