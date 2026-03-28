const fs = require('fs')
const path = require('path')

// 计算知识库的 token 估算（粗略：中文字符按 1.5 tokens，英文按 1 token）
function estimateTokens(text) {
  const chineseCount = (text.match(/[\u4e00-\u9fa5]/g) || []).length
  const englishCount = text.length - chineseCount
  return Math.ceil(chineseCount * 1.5 + englishCount * 1)
}

const KNOWLEDGE_FILE = path.join(__dirname, 'knowledge.json')

console.log('🔍 知识库诊断分析\n')

try {
  const data = fs.readFileSync(KNOWLEDGE_FILE, 'utf-8')
  const knowledgeBase = JSON.parse(data)

  console.log(`📚 基本信息`)
  console.log(`   类别数量：${knowledgeBase.categories?.length || 0}`)
  console.log(`   文件大小：${(data.length / 1024).toFixed(2)} KB`)

  if (knowledgeBase.categories && knowledgeBase.categories.length > 0) {
    console.log(`\n📊 Token 估算`)

    // 统计每个类别的 token
    let totalTokens = 0
    knowledgeBase.categories.forEach((cat, idx) => {
      const categoryText = `
【类别 ${idx + 1}】${cat.category}
核心规则：
${cat.core_rules.map(rule => `  - ${rule}`).join('\n')}

正向模板：
${cat.prompt_template}

负向模板：
${cat.negative_prompt}
`
      const tokens = estimateTokens(categoryText)
      totalTokens += tokens

      console.log(`   类别 ${idx + 1}（${cat.category}）：${tokens} tokens`)
    })

    console.log(`\n   知识库总 token：${totalTokens}`)
    console.log(`   ⚠️  加上 system 提示词前缀约 800 tokens`)
    console.log(`   ⚠️  加上用户描述和任务指令约 200 tokens`)
    console.log(`   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    console.log(`   总上下文需求：${totalTokens + 800 + 200} tokens`)

    // 检测是否有超长类别
    console.log(`\n❗ 发现问题：`)
    knowledgeBase.categories.forEach((cat, idx) => {
      const categoryText = `${cat.core_rules.join('\n')}${cat.prompt_template}${cat.negative_prompt}`
      const tokens = estimateTokens(categoryText)

      if (tokens > 500) {
        console.log(`   类别 ${idx + 1}（${cat.category}）：${tokens} tokens ⚠️ 超长`)
      }
    })

    // 模拟注入后的 system prompt
    console.log(`\n📋 注入后的 System Prompt 长度：`)
    const systemPrompt = `你是专业AI文生图/图生视频提示词工程师，精通Stable Diffusion、SVD、Open-Sora、WAN Video。
你的任务：把用户输入的自然语言，转化为精准、高质量、可直接商用的提示词，并确定合适的参数。

${knowledgeBase.categories.map((cat, idx) => `
【类别 ${idx + 1}】${cat.category}
核心规则：
${cat.core_rules.map(rule => `  - ${rule}`).join('\n')}

正向模板：
${cat.prompt_template}

负向模板：
${cat.negative_prompt}
`).join('\n---\n')}

=== 知识库结束 ===
输出必须是一个严格的JSON对象，不要额外文字，不要Markdown标记，不要代码块。`
    const systemPromptTokens = estimateTokens(systemPrompt)
    console.log(`   System Prompt：${systemPromptTokens} tokens`)

    // 给出建议
    console.log(`\n💡 诊断建议：`)
    if (systemPromptTokens > 4000) {
      console.log(`   🔴 严重问题：System Prompt 超过 4000 tokens！`)
      console.log(`      这会导致：`)
      console.log(`      1. LLM 无法记住核心指令（输出 JSON 格式）`)
      console.log(`      2. 上下文截断，知识库信息不完整`)
      console.log(`      3. 生成质量下降`)
      console.log(`   处理方案：改为向量检索，只注入最相关的类别`)
    } else if (systemPromptTokens > 2000) {
      console.log(`   🟡 中等问题：System Prompt 较长`)
      console.log(`      可能导致注意力分散，核心指令权重降低`)
      console.log(`   处理方案：精简知识库内容，或启用 RAG 检索`)
    } else {
      console.log(`   🟢 长度正常，但建议检查 LLM 是否真的使用了知识库内容`)
    }

    console.log(`\n🧪 测试方案：`)
    console.log(`   1. 添加临时测试类别（如"紫色天空"）`)
    console.log(`   2. 发送测试请求，查看最终提示词`)
    console.log(`   3. 对比禁用知识库时的差异`)

  }

} catch (err) {
  console.error('❌ 诊断失败：', err.message)
}
