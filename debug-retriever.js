// 调试检索器 - 测试匹配逻辑
const SmartKnowledgeRetriever = require('./knowledge-retriever.js')
const fs = require('fs')
const path = require('path')

const KNOWLEDGE_FILE = path.join(__dirname, 'knowledge.json')
const knowledgeBase = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf-8'))

const retriever = new SmartKnowledgeRetriever(knowledgeBase)

console.log('🔍 调试检索器')
console.log('================================\n')

const testDesc = "中国古代江南美景"

console.log('📝 用户描述：', testDesc)

// 手动模拟关键词提取（和检索器一样的逻辑）
const userKeywords = [
  ...(testDesc.match(/[\u4e00-\u9fa5]{2,}/g) || []),
  ...(testDesc.match(/[a-zA-Z]{3,}/g) || [])
]
console.log('🔑 提取的用户关键词：', userKeywords)
console.log()

// 查找江南水乡类别
const jiangnanCategory = knowledgeBase.categories.find(cat => cat.category.includes('江南'))

if (jiangnanCategory) {
  console.log('🎯 找到江南水乡类别：')
  console.log('   类别名：', jiangnanCategory.category)
  console.log('   提取的关键词：', retriever.index.find(cat => cat.category === jiangnanCategory.category)?.keywords)
  console.log()

  console.log('🔬 匹配测试：')
  console.log('   类别名包含用户关键词？')
  userKeywords.forEach(keyword => {
    const matched = jiangnanCategory.category.includes(keyword)
    console.log(`      "${keyword}" → ${matched ? '✅' : '❌'}`)
  })
  console.log()

  // 实际运行检索
  console.log('🎲 实际检索结果：')
  const matches = retriever.retrieve(testDesc, 5)
  console.log(`   匹配数量：${matches.length}`)
  if (matches.length > 0) {
    matches.forEach((m, idx) => {
      console.log(`   ${idx + 1}. ${m.category}（分数：${m.score}）`)
    })
  } else {
    console.log('   ❌ 没有匹配')
  }
} else {
  console.log('❌ 未找到江南水乡类别！')
}

console.log('\n================================')
