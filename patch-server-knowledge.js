// 补丁文件：将智能检索集成到 server.js

const SmartKnowledgeRetriever = require('./knowledge-retriever.js')

// 在 server.js 文件顶部添加：
/*
const SmartKnowledgeRetriever = require('./knowledge-retriever.js')

// 替换 enhancePrompt 函数中的知识库注入逻辑
async function enhancePrompt(description) {
  try {
    // 智能检索：只注入最相关的3-5个类别
    let knowledgePrompt = ''
    if (knowledgeBase && knowledgeBase.categories && knowledgeBase.categories.length > 0) {
      const retriever = new SmartKnowledgeRetriever(knowledgeBase)
      const matchedCategories = retriever.retrieve(description, 5) // 最多5个类别

      if (matchedCategories.length > 0) {
        console.log(`🎯 匹配到 ${matchedCategories.length} 个知识库类别：`)
        matchedCategories.forEach((cat, idx) => {
          console.log(`   ${idx + 1}. ${cat.category}（分数：${cat.score}）`)
        })

        knowledgePrompt = retriever.formatPrompt(matchedCategories)

        // 计算节省的 token
        const originalTokens = 32066 // 原全量注入
        const reducedTokens = estimateTokens(knowledgePrompt)
        const savedTokens = originalTokens - reducedTokens
        console.log(`📊 Token 优化：${savedTokens} tokens → ${reducedTokens} tokens (节省 ${((savedTokens / originalTokens) * 100).toFixed(1)}%)`)
      }
    }

    const completion = await openai.chat.completions.create({
      model: 'qwen/qwen3-next-80b-a3b-instruct',
      messages: [
        {
          role: 'system',
          content: `你是专业AI文生图/图生视频提示词工程师，精通Stable Diffusion、SVD、Open-Sora、WAN Video。
你的任务：把用户输入的自然语言，转化为精准、高质量、可直接商用的提示词，并确定合适的参数。

${knowledgePrompt}

输出必须是一个严格的JSON对象，不要额外文字，不要Markdown标记，不要代码块。

必须遵守的核心规则：

1. 中国元素优先原则（最重要）：
   如果用户没有明确指定国家、种族或地域，默认必须以中国元素为主。人物默认是中国人，风景默认是中国景色，建筑默认中式风格，服装默认中国传统服饰或现代中式。除非用户明确说"美国人"、"欧洲"等。

2. 性别中立随机原则：
   如果人物描述没有明确指定性别（没有"男人"、"女性"、"男孩"、"女孩"等），或者没有强烈的性别特征词汇（如"西装"、"连衣裙"、"胡子"、"长发"等），则性别应该随机选择（50%男，50%女）。不要默认男性或女性。

3. 100%还原原则：
   严格还原用户描述的人物、场景、服装、动作、气质、光影，不添加任何用户没提到的元素。

4. 正向提示词必须包含（缺一不可）：
   - 画质：masterpiece, best quality, 8k, high resolution
   - 光影：具体光源（soft studio lighting, natural lighting等）
   - 构图：shot type（portrait, full body等）
   - 镜头稳定性：steady camera, smooth 等（适配视频）
   - 细节质感：sharp focus, high detail
   - 避免闪烁抖动：no flicker, no jitter（适配视频）

5. 负面提示词必须包含（强制）：
   - 质量问题：blurry, low quality, distorted
   - 人体问题：bad anatomy, deformed, face distortion, limb deformation
   - 视频问题：flicker, jitter,闪烁,抖动
   - 风格问题：网红风, cartoonish, anime, 过度修饰
   - 其他：watermark, text, logo, oversaturated

6. 参数选择规则：
   - steps: 简单场景20-30，复杂场景30-50，人物肖像建议25-35
   - cfg: 5-8，保持5-6的平衡，需要更高依从时用7-8
   - seed: 如果没有用户指定，随机生成

7. 语言要求：
   - 正向/负面提示词必须用英语
   - 简洁、关键词精准，直接可复制到ComfyUI/SD使用

如果用户描述已经是专业的提示词格式，只需稍作优化。如果描述很简短，需要扩展细节（基于中国元素优先原则）。

重要：分析用户描述后，从知识库中选择最匹配的类别，参考其核心规则和模板生成高质量提示词。

JSON格式必须严格遵守：
{
  "positive": "英文正向提示词",
  "negative": "英文反向提示词",
  "steps": 数字(20-50),
  "cfg": 数字(5-8),
  "seed": 数字|null
}`
        },
        { role: 'user', content: description }
      ],
      temperature: 0.6,
      top_p: 0.7,
      max_tokens: 4096
    })

    const content = completion.choices[0].message.content.trim()
    // 清理可能的代码块标记
    let jsonStr = content
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim()
    }
    const result = JSON.parse(jsonStr)

    console.log(`🧠 LLM 增强完成：
  描述：${description}
  正向：${result.positive}
  负向：${result.negative}
  步数：${result.steps}  CFG：${result.cfg}  种子：${result.seed}`)

    return result
  } catch (error) {
    console.error('LLM增强失败:', error.message || error)
    throw error
  }
}

// 删除知识库热重载接口中的全量加载，改为只重新初始化检索器
*/

console.log('✅ 智能检索补丁已准备好')
console.log('📝 应用步骤：')
console.log('   1. 将以上代码复制到 server.js')
console.log('   2. 替换原有的 enhancePrompt 函数')
console.log('   3. 重启服务器')
console.log('')
console.log('🎯 效果预期：')
console.log('   - Token 使用：32000 → ~2000 (节省 94%)')
console.log('   - 匹配精度：只在相关类别中检索')
console.log('   - 生成质量：LLM 注意力更集中')
console.log('')
console.log('🧪 测试命令：')
console.log('   curl -X POST http://localhost:10005/api/generate \\')
console.log('     -d \'{"description": "江南水乡风景", "resolution":"1024x1024"}\'')
