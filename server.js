const express = require('express')
const cors = require('cors')
const http = require('http')
const https = require('https')
const { OpenAI } = require('openai')
const app = express()

const COMFYUI_SERVER = 'https://workflow.423513.tech'
const fs = require('fs')
const path = require('path')

const LEARNING_FILE = path.join(__dirname, 'learning.json')
const KNOWLEDGE_FILE = path.join(__dirname, 'knowledge.json')
const FLUX_RESULTS_FILE = path.join(__dirname, 'flux-results.json')

// Flux 比例到尺寸的映射
const FLUX_ASPECT_RATIO_MAP = {
  '1:1': '1024x1024',
  '16:9': '1328x800',
  '9:16': '800x1328',
  '5:4': '1104x944',
  '4:5': '944x1104',
  '3:2': '1248x832',
  '2:3': '832x1248'
}

// 将比例转换为尺寸
function convertAspectRatioToSize(aspectRatio) {
  return FLUX_ASPECT_RATIO_MAP[aspectRatio] || '1024x1024'
}

const SmartKnowledgeRetriever = require('./knowledge-retriever.js')

// Flux 结果存储和加载函数
function loadFluxResults() {
  try {
    if (fs.existsSync(FLUX_RESULTS_FILE)) {
      const data = fs.readFileSync(FLUX_RESULTS_FILE, 'utf8')
      return JSON.parse(data)
    }
  } catch (err) {
    console.error('❌ 加载 Flux 结果失败：', err.message)
  }
  return {}
}

function saveFluxResults(results) {
  try {
    fs.writeFileSync(FLUX_RESULTS_FILE, JSON.stringify(results, null, 2))
  } catch (err) {
    console.error('❌ 保存 Flux 结果失败：', err.message)
  }
}

// 加载知识库（全量）
let knowledgeBase = null
try {
  if (fs.existsSync(KNOWLEDGE_FILE)) {
    const data = fs.readFileSync(KNOWLEDGE_FILE, 'utf-8')
    knowledgeBase = JSON.parse(data)
    console.log(`📚 知识库加载成功：${knowledgeBase.categories?.length || 0} 个类别`)
  } else {
    console.warn('⚠️ 知识库文件不存在：', KNOWLEDGE_FILE)
    knowledgeBase = { categories: [] }
  }
} catch (err) {
  console.error('❌ 知识库加载失败：', err.message)
  knowledgeBase = { categories: [] }
}

app.use(cors())
app.use(express.json())

// 进度时间学习系统（按尺寸分类记录平均生成时长）
class ProgressLearner {
  constructor() {
    // 尺寸记录：key = "宽x高"，value = { average: 平均秒数, count: 记录次数 }
    this.records = {}
    // 任务元数据：prompt_id -> { width, height, startTime }
    this.taskMeta = {}
    // 支持的标准尺寸组（避免数据过多）
    this.standardSizes = [
      // 1:1
      { width: 512, height: 512 },
      { width: 1024, height: 1024 },
      // 4:3
      { width: 768, height: 1024 },
      { width: 1024, height: 768 },
      // 16:9
      { width: 768, height: 432 },
      { width: 1024, height: 576 },
      { width: 1920, height: 1080 }
    ]

    // 启动时从文件加载记录
    this.loadFromFile()
  }

  // 从文件加载学习记录
  loadFromFile() {
    try {
      if (fs.existsSync(LEARNING_FILE)) {
        const data = fs.readFileSync(LEARNING_FILE, 'utf8')
        this.records = JSON.parse(data)
        console.log(`📂 已加载学习记录：${Object.keys(this.records).length} 个尺寸`)
      }
    } catch (err) {
      console.error('❌ 加载学习记录失败：', err.message)
      this.records = {}
    }
  }

  // 保存学习记录到文件
  saveToFile() {
    try {
      fs.writeFileSync(LEARNING_FILE, JSON.stringify(this.records, null, 2))
    } catch (err) {
      console.error('❌ 保存学习记录失败：', err.message)
    }
  }

  // 标准化尺寸（匹配到标准尺寸组，找不到则使用实际尺寸）
  normalizeSize(width, height) {
    const exact = `${width}x${height}`
    // 检查是否完全匹配标准尺寸
    for (const size of this.standardSizes) {
      if (size.width === width && size.height === height) {
        return exact
      }
    }
    // 检查反转尺寸（如 768x1024 和 1024x768 视为同组）
    for (const size of this.standardSizes) {
      if (size.width === height && size.height === width) {
        return exact // 仍然使用实际尺寸，但可以关联学习
      }
    }
    return exact
  }

  // 开始新任务
  startTask(prompt_id, width, height) {
    this.taskMeta[prompt_id] = {
      width,
      height,
      startTime: Date.now(),
      sizeKey: this.normalizeSize(width, height)
    }
  }

  // 获取预估总时长（秒）
  getEstimatedDuration(width, height) {
    const sizeKey = this.normalizeSize(width, height)
    if (this.records[sizeKey]) {
      return this.records[sizeKey]
    }
    // 默认3分钟
    return 180
  }

  // 计算当前进度（0-99.9），返回浮点数让前端更平滑
  getProgress(prompt_id) {
    const meta = this.taskMeta[prompt_id]
    if (!meta) return 0

    const elapsed = (Date.now() - meta.startTime) / 1000 // 秒
    const total = this.getEstimatedDuration(meta.width, meta.height)
    return Math.min(Number(((elapsed / total) * 100).toFixed(1)), 99.9)
  }

  // 完成任务，更新记录
  completeTask(prompt_id) {
    const meta = this.taskMeta[prompt_id]
    if (!meta) return

    const duration = (Date.now() - meta.startTime) / 1000 // 秒
    const sizeKey = meta.sizeKey

    // 更新平均时间（简单的移动平均）
    if (this.records[sizeKey]) {
      // 新旧各50%权重
      this.records[sizeKey] = (this.records[sizeKey] + duration) / 2
    } else {
      this.records[sizeKey] = duration
    }

    // 持久化到文件
    this.saveToFile()

    // 清理任务元数据
    delete this.taskMeta[prompt_id]

    console.log(`📊 学习记录：尺寸 ${meta.width}x${meta.height} 生成耗时 ${duration.toFixed(1)}秒，平均 ${this.records[sizeKey].toFixed(1)}秒`)
  }
}

const progressLearner = new ProgressLearner()

// 星澜智能绘图工作流模板 (SDXL - 快速模式)
const SDXL_WORKFLOW = {
  "3": {
    "inputs": {
      "seed": 571287840061540,
      "steps": 30,
      "cfg": 10,
      "sampler_name": "dpmpp_2m",
      "scheduler": "normal",
      "denoise": 1,
      "model": ["4", 0],
      "positive": ["6", 0],
      "negative": ["7", 0],
      "latent_image": ["5", 0]
    },
    "class_type": "KSampler",
    "_meta": { "title": "K采样器" }
  },
  "9": {
    "inputs": {
      "filename_prefix": "星澜",
      "images": ["8", 0]
    },
    "class_type": "SaveImage",
    "_meta": { "title": "保存图像" }
  },
  "8": {
    "inputs": {
      "samples": ["3", 0],
      "vae": ["4", 2]
    },
    "class_type": "VAEDecode",
    "_meta": { "title": "VAE解码" }
  },
  "5": {
    "inputs": {
      "width": 1920,
      "height": 1080,
      "batch_size": 1
    },
    "class_type": "EmptyLatentImage",
    "_meta": { "title": "空Latent图像" }
  },
  "6": {
    "inputs": {
      "text": "",
      "clip": ["4", 1]
    },
    "class_type": "CLIPTextEncode",
    "_meta": { "title": "CLIP文本编码" }
  },
  "7": {
    "inputs": {
      "text": "worst quality, low quality, normal quality, blurry, pixelated, ugly, deformed, disfigured, bad anatomy, extra limbs, missing fingers, watermark, text, signature, cropped, out of frame, mutation, distorted proportions, overexposed, underexposed, cartoon, anime, illustration, painting, sketch, comic, deformed buildings, missing windows, no reflections, no rain",
      "clip": ["4", 1]
    },
    "class_type": "CLIPTextEncode",
    "_meta": { "title": "CLIP文本编码" }
  },
  "4": {
    "inputs": {
      "ckpt_name": "sd_xl_base_1.0.safetensors"
    },
    "class_type": "CheckpointLoaderSimple",
    "_meta": { "title": "Checkpoint加载器（简易）" }
  }
}

// OmniGen2 工作流模板 (质量模式)
const OMNIGEN2_WORKFLOW = {
  "9": {
    "inputs": { "filename_prefix": "星澜", "images": ["42:8", 0] },
    "class_type": "SaveImage",
    "_meta": { "title": "保存图像" }
  },
  "42:28": {
    "inputs": {
      "noise": ["42:21", 0],
      "guider": ["42:27", 0],
      "sampler": ["42:20", 0],
      "sigmas": ["42:23", 0],
      "latent_image": ["42:11", 0]
    },
    "class_type": "SamplerCustomAdvanced",
    "_meta": { "title": "自定义采样器（高级）" }
  },
  "42:20": {
    "inputs": { "sampler_name": "euler" },
    "class_type": "KSamplerSelect",
    "_meta": { "title": "K采样器选择" }
  },
  "42:27": {
    "inputs": {
      "cfg_conds": 5,
      "cfg_cond2_negative": 2,
      "style": "regular",
      "model": ["42:12", 0],
      "cond1": ["42:6", 0],
      "cond2": ["42:7", 0],
      "negative": ["42:7", 0]
    },
    "class_type": "DualCFGGuider",
    "_meta": { "title": "双CFG引导器" }
  },
  "42:23": {
    "inputs": {
      "scheduler": "simple",
      "steps": 20,
      "denoise": 1,
      "model": ["42:12", 0]
    },
    "class_type": "BasicScheduler",
    "_meta": { "title": "基本调度器" }
  },
  "42:13": {
    "inputs": { "vae_name": "ae.safetensors" },
    "class_type": "VAELoader",
    "_meta": { "title": "加载VAE" }
  },
  "42:10": {
    "inputs": {
      "clip_name": "qwen_2.5_vl_fp16.safetensors",
      "type": "omnigen2",
      "device": "default"
    },
    "class_type": "CLIPLoader",
    "_meta": { "title": "加载CLIP" }
  },
  "42:12": {
    "inputs": {
      "unet_name": "omnigen2_fp16.safetensors",
      "weight_dtype": "default"
    },
    "class_type": "UNETLoader",
    "_meta": { "title": "UNet加载器" }
  },
  "42:8": {
    "inputs": { "samples": ["42:28", 0], "vae": ["42:13", 0] },
    "class_type": "VAEDecode",
    "_meta": { "title": "VAE解码" }
  },
  "42:7": {
    "inputs": {
      "text": "blurry, low quality, distorted, ugly, bad anatomy, deformed, poorly drawn",
      "clip": ["42:10", 0]
    },
    "class_type": "CLIPTextEncode",
    "_meta": { "title": "CLIP文本编码" }
  },
  "42:6": {
    "inputs": {
      "text": "",
      "clip": ["42:10", 0]
    },
    "class_type": "CLIPTextEncode",
    "_meta": { "title": "CLIP文本编码" }
  },
  "42:11": {
    "inputs": { "width": 1024, "height": 1024, "batch_size": 1 },
    "class_type": "EmptySD3LatentImage",
    "_meta": { "title": "空Latent图像（SD3）" }
  },
  "42:21": {
    "inputs": { "noise_seed": 0 },
    "class_type": "RandomNoise",
    "_meta": { "title": "随机噪波" }
  }
}

// 初始化 OpenAI 客户端（NVIDIA API）
const openai = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY || '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',
  baseURL: 'https://integrate.api.nvidia.com/v1'
})

// Flux.2-klein-4b API 调用（人气模式）
async function callFluxAPI(prompt, width, height, seed) {
  const invokeUrl = "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.2-klein-4b"
  const apiKey = process.env.NVIDIA_API_KEY || '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'

  // 确保 seed 在有效范围内（0 到 2^32-1）
  const validSeed = (seed || 0) % 4294967296

  // 验证参数
  if (!prompt || prompt.trim() === '') {
    throw new Error('提示词不能为空')
  }

  // Flux.2-klein-4b 支持的尺寸
  const validSizes = [
    { width: 512, height: 512 },
    { width: 768, height: 768 },
    { width: 1024, height: 1024 },
    { width: 512, height: 768 },
    { width: 768, height: 512 },
    { width: 1024, height: 768 },
    { width: 768, height: 1024 }
  ]

  // 检查尺寸是否有效
  const sizeValid = validSizes.some(s => s.width === width && s.height === height)
  if (!sizeValid) {
    console.warn(`⚠️ 尺寸 ${width}x${height} 可能不被 Flux.2-klein-4b 支持，尝试使用...`)
  }

  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Accept": "application/json",
  }

  const payload = {
    "prompt": prompt,
    "width": width,
    "height": height,
    "seed": validSeed,
    "steps": 4
  }

  console.log(`📤 Flux API 请求参数：`, {
    prompt: prompt.substring(0, 100) + (prompt.length > 100 ? '...' : ''),
    width,
    height,
    seed: validSeed,
    steps: 4
  })

  const response = await fetch(invokeUrl, {
    method: "post",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json", ...headers }
  })

  if (response.status !== 200) {
    const errBody = await (await response.blob()).text()
    console.error(`❌ Flux API 错误响应：`, errBody)
    throw new Error(`Flux API 调用失败: ${response.status} ${errBody}`)
  }

  const response_body = await response.json()

  // 处理返回的 base64 图片
  if (response_body.artifacts && Array.isArray(response_body.artifacts)) {
    response_body.images = response_body.artifacts.map((artifact, idx) => {
      // 将 base64 转换为 data URL
      const base64Data = artifact.base64
      const dataUrl = `data:image/png;base64,${base64Data}`
      return {
        url: dataUrl,
        width: width,
        height: height,
        seed: artifact.seed || validSeed
      }
    })
  }

  return response_body
}

// Token 估算函数（用于调试和监控）
function estimateTokens(text) {
  const chineseCount = (text.match(/[\u4e00-\u9fa5]/g) || []).length
  const englishCount = text.length - chineseCount
  return Math.ceil(chineseCount * 1.5 + englishCount * 1)
}

// LLM 提示词增强函数（智能检索知识库）
async function enhancePrompt(description) {
  try {
    // 智能检索：只注入最相关的3-5个类别
    let knowledgePrompt = ''
    let ragInfo = null // RAG 匹配信息
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
        console.log(`📊 Token 优化：${originalTokens} → ${reducedTokens} tokens (节省 ${((savedTokens / originalTokens) * 100).toFixed(1)}%)`)

        // 构建返回给前端的 RAG 信息
        ragInfo = {
          matchedCount: matchedCategories.length,
          categories: matchedCategories.map(cat => ({
            category: cat.category,
            score: cat.score
          })),
          tokenOptimization: {
            original: originalTokens,
            reduced: reducedTokens,
            saved: savedTokens,
            savedPercent: ((savedTokens / originalTokens) * 100).toFixed(1)
          }
        }
      } else {
        console.log('⚠️  没有匹配的知识库类别，使用通用规则')
        ragInfo = {
          matchedCount: 0,
          categories: [],
          message: '没有匹配的知识库类别，使用通用规则'
        }
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

    console.log(`🧠 LLM 增强完成：`)
    console.log(`   描述：${description}`)
    console.log(`   正向：${result.positive}`)
    console.log(`   负向：${result.negative}`)
    console.log(`   步数：${result.steps}  CFG：${result.cfg}  种子：${result.seed}`)

    // 添加 RAG 信息到结果中
    result._rag = ragInfo

    return result
  } catch (error) {
    console.error('LLM增强失败:', error.message || error)
    throw error
  }
}

// 提交生成任务（只返回 prompt_id）
app.post('/api/generate', async (req, res) => {
  try {
    const { description, positive, negative, seed, steps, cfg, width, height, resolution, workflow: workflowType } = req.body

    // 判断使用模式：有 description 则通过 LLM 增强，否则使用旧参数
    let finalPositive, finalNegative, finalSeed, finalSteps, finalCfg, finalWidth, finalHeight
    let enhanced = null // 存储完整的 LLM 增强结果（包括 RAG 信息）

    // Flux 模式不使用 LLM 增强，直接使用用户输入
    if (workflowType === 'flux') {
      if (!description) {
        return res.status(400).json({ success: false, message: '请提供图片描述' })
      }
      finalPositive = description
      finalNegative = "blurry, low quality, distorted, ugly, bad anatomy, deformed, poorly drawn"
      finalSteps = 4  // Flux API 固定使用 4 步
      finalCfg = 5
      finalSeed = Math.floor(Math.random() * 999999999999)

      // 处理分辨率/比例
      if (resolution) {
        // 检查是否是比例格式（包含冒号）
        if (resolution.includes(':')) {
          // 比例格式，转换为尺寸
          const sizeStr = convertAspectRatioToSize(resolution)
          const [w, h] = sizeStr.split('x').map(Number)
          finalWidth = w
          finalHeight = h
          console.log(`🎨 Flux 模式：比例 ${resolution} → 尺寸 ${finalWidth}x${finalHeight}`)
        } else {
          // 尺寸格式，直接使用
          const [w, h] = resolution.split('x').map(Number)
          finalWidth = w
          finalHeight = h
          console.log(`🎨 Flux 模式：使用尺寸 ${finalWidth}x${finalHeight}`)
        }
      } else {
        finalWidth = width || 1024
        finalHeight = height || 1024
      }
      console.log(`🎨 Flux 模式：直接使用用户描述（${finalPositive.length} 字符）`)
    } else if (description) {
      // 其他模式：通过 LLM 增强
      try {
        enhanced = await enhancePrompt(description)
        finalPositive = enhanced.positive
        finalNegative = enhanced.negative || "blurry, low quality, distorted, ugly, bad anatomy, deformed, poorly drawn"
        finalSteps = enhanced.steps || 20
        finalCfg = enhanced.cfg || 5
        finalSeed = enhanced.seed || Math.floor(Math.random() * 999999999999)

        // 处理分辨率/比例
        if (resolution) {
          // 检查是否是比例格式（包含冒号）
          if (resolution.includes(':')) {
            // 比例格式，转换为尺寸
            const sizeStr = convertAspectRatioToSize(resolution)
            const [w, h] = sizeStr.split('x').map(Number)
            finalWidth = w
            finalHeight = h
          } else {
            // 尺寸格式，直接使用
            const [w, h] = resolution.split('x').map(Number)
            finalWidth = w
            finalHeight = h
          }
        } else {
          finalWidth = width || 1024
          finalHeight = height || 1024
        }

        // 显示 LLM 生成的提示词和参数
        console.log(`🧠 LLM 增强完成：
  描述：${description}
  正向：${finalPositive}
  反向：${finalNegative}
  步数：${finalSteps}  CFG：${finalCfg}  种子：${finalSeed}
  分辨率：${finalWidth}x${finalHeight}`)
      } catch (llmErr) {
        console.warn('LLM增强失败，回退到默认参数:', llmErr.message)
        finalPositive = description  // 直接使用用户描述作为正向提示词
        finalNegative = "blurry, low quality, distorted, ugly, bad anatomy, deformed, poorly drawn"
        finalSteps = 20
        finalCfg = 5
        finalSeed = Math.floor(Math.random() * 999999999999)

        // 处理分辨率/比例
        if (resolution) {
          // 检查是否是比例格式（包含冒号）
          if (resolution.includes(':')) {
            // 比例格式，转换为尺寸
            const sizeStr = convertAspectRatioToSize(resolution)
            const [w, h] = sizeStr.split('x').map(Number)
            finalWidth = w
            finalHeight = h
          } else {
            // 尺寸格式，直接使用
            const [w, h] = resolution.split('x').map(Number)
            finalWidth = w
            finalHeight = h
          }
        } else {
          finalWidth = width || 1024
          finalHeight = height || 1024
        }
      }
    } else {
      // 旧协议：直接使用参数
      if (!positive) {
        return res.status(400).json({ success: false, message: '请提供图片描述或正向提示词' })
      }
      finalPositive = positive
      finalNegative = negative || "blurry, low quality, distorted, ugly, bad anatomy, deformed, poorly drawn"
      finalSeed = seed || Math.floor(Math.random() * 999999999999)
      finalSteps = steps || 20
      finalCfg = cfg || 5
      finalWidth = width || 1024
      finalHeight = height || 1024
    }

    // 根据工作流类型选择工作流（默认：SDXL）
    let prompt_id = null
    let workflowName = ''

    if (workflowType === 'flux') {
      // Flux.2-klein-4b（人气模式）- 直接调用 NVIDIA API
      workflowName = 'Flux.2-klein-4b（人气）'
      console.log(`🎨 使用工作流：${workflowName}`)

      // 生成唯一的 prompt_id
      prompt_id = `flux_${Date.now()}_${Math.floor(Math.random() * 10000)}`

      // 调用 Flux API（异步执行，不阻塞响应）
      callFluxAPI(finalPositive, finalWidth, finalHeight, finalSeed)
        .then(result => {
          console.log(`✅ Flux API 调用成功：${prompt_id}`)
          // 将结果保存到临时文件供状态查询
          const fluxResults = loadFluxResults()
          fluxResults[prompt_id] = {
            status: 'completed',
            completed: true,
            images: result.images || [],
            result: result
          }
          saveFluxResults(fluxResults)
        })
        .catch(err => {
          console.error(`❌ Flux API 调用失败：${prompt_id}`, err.message)
          const fluxResults = loadFluxResults()
          fluxResults[prompt_id] = {
            status: 'error',
            completed: false,
            error: err.message
          }
          saveFluxResults(fluxResults)
        })

    } else {
      // SDXL 或 OmniGen2 - 使用 ComfyUI 工作流
      const selectedWorkflow = workflowType === 'quality' ? OMNIGEN2_WORKFLOW : SDXL_WORKFLOW
      const workflow = JSON.parse(JSON.stringify(selectedWorkflow))
      workflowName = workflowType === 'quality' ? 'OmniGen2（质量）' : 'SDXL（快速）'
      console.log(`🎨 使用工作流：${workflowName}`)

      // 填充参数（根据工作流类型分别处理）
      if (workflowType === 'quality') {
        // OmniGen2 节点映射
        workflow["42:21"]["inputs"]["noise_seed"] = finalSeed
        workflow["42:23"]["inputs"]["steps"] = finalSteps
        workflow["42:27"]["inputs"]["cfg_conds"] = finalCfg
        workflow["42:11"]["inputs"]["width"] = finalWidth
        workflow["42:11"]["inputs"]["height"] = finalHeight
        workflow["42:6"]["inputs"]["text"] = finalPositive
        workflow["42:7"]["inputs"]["text"] = finalNegative
      } else {
        // SDXL 节点映射
        workflow["3"]["inputs"]["seed"] = finalSeed
        workflow["3"]["inputs"]["steps"] = finalSteps
        workflow["3"]["inputs"]["cfg"] = finalCfg
        workflow["5"]["inputs"]["width"] = finalWidth
        workflow["5"]["inputs"]["height"] = finalHeight
        workflow["6"]["inputs"]["text"] = finalPositive
        workflow["7"]["inputs"]["text"] = finalNegative
      }

      console.log(`📤 收到 星澜智能绘图 请求：`)
      console.log(JSON.stringify(req.body, null, 2))

      // 提交任务到ComfyUI
      const postPrompt = () => {
        return new Promise((resolve, reject) => {
          const postData = JSON.stringify({ prompt: workflow })
          const apiUrl = new URL('/prompt', COMFYUI_SERVER)
          const options = {
            hostname: apiUrl.hostname,
            port: apiUrl.port || 443,
            path: apiUrl.pathname,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(postData)
            }
          }

          const request = https.request(options, (response) => {
            let data = ''
            response.on('data', chunk => data += chunk)
            response.on('end', () => {
              try {
                resolve(JSON.parse(data))
              } catch (e) {
                reject(new Error('解析响应失败: ' + e.message))
              }
            })
          })

          request.on('error', reject)
          request.write(postData)
          request.end()
        })
      }

      const promptResult = await postPrompt()
      prompt_id = promptResult.prompt_id
      console.log(`✅ 任务提交成功：${prompt_id}`)
    }

    // 记录任务元数据（用于进度学习）
    progressLearner.startTask(prompt_id, finalWidth, finalHeight)

    // 返回预估总时长（秒）
    const estimatedDuration = progressLearner.getEstimatedDuration(finalWidth, finalHeight)

    // 如果使用了LLM增强，返回增强后的提示词供前端显示
    const responseData = {
      success: true,
      prompt_id,
      estimatedDuration
    }
    if (description && finalPositive && enhanced) {
      responseData.enhanced = {
        positive: finalPositive,
        negative: finalNegative,
        steps: finalSteps,
        cfg: finalCfg,
        seed: finalSeed,
        rag: enhanced._rag // RAG 匹配信息
      }
    }

    res.json(responseData)
  } catch (error) {
    console.error('❌ 服务器错误：', error)
    res.status(500).json({ success: false, message: error.message || '服务器内部错误' })
  }
})

// 查询任务状态
app.get('/api/status', async (req, res) => {
  try {
    const { prompt_id } = req.query

    if (!prompt_id) {
      return res.status(400).json({ success: false, message: '请提供 prompt_id' })
    }

    // 检查是否是 Flux 任务（以 flux_ 开头）
    if (prompt_id.startsWith('flux_')) {
      const fluxResults = loadFluxResults()
      const fluxTask = fluxResults[prompt_id]

      if (!fluxTask) {
        // 任务还在处理中
        return res.json({
          success: true,
          status: 'pending',
          completed: false,
          progress: 50, // Flux API 是同步的，但为了兼容前端显示，给一个中间进度
          estimatedDuration: 30 // Flux API 通常很快
        })
      }

      if (fluxTask.status === 'error') {
        return res.json({
          success: true,
          status: 'error',
          completed: false,
          error: fluxTask.error
        })
      }

      if (fluxTask.completed && fluxTask.result) {
        // Flux API 返回的图片格式需要转换
        let images = []
        if (fluxTask.result.images && Array.isArray(fluxTask.result.images)) {
          images = fluxTask.result.images.map((img, idx) => ({
            filename: `flux_${prompt_id}_${idx}.png`,
            url: img.url, // Flux API 返回的 data URL
            width: img.width || 1024,
            height: img.height || 1024
          }))
        } else if (fluxTask.result.image) {
          // 单张图片
          images = [{
            filename: `flux_${prompt_id}.png`,
            url: fluxTask.result.image,
            width: fluxTask.result.width || 1024,
            height: fluxTask.result.height || 1024
          }]
        }

        return res.json({
          success: true,
          status: 'completed',
          completed: true,
          progress: 100,
          images
        })
      }

      // 默认返回处理中
      return res.json({
        success: true,
        status: 'pending',
        completed: false,
        progress: 50,
        estimatedDuration: 30
      })
    }

    // 原有的 ComfyUI 任务查询逻辑
    const history = await pollHistory(prompt_id)

    if (!history[prompt_id]) {
      // 任务可能还在队列中，使用学习器中的元数据计算进度
      const estimatedProgress = progressLearner.getProgress(prompt_id)
      // 同时返回预估总时长
      const meta = progressLearner.taskMeta[prompt_id]
      const estimatedDuration = meta ? progressLearner.getEstimatedDuration(meta.width, meta.height) : 180
      return res.json({ success: true, status: 'pending', completed: false, progress: estimatedProgress, estimatedDuration })
    }

    const task = history[prompt_id]
    const status = task.status?.status_str || 'unknown'
    const completed = task.status?.completed || false

    // 计算进度（0-99）
    let progress = progressLearner.getProgress(prompt_id)

    // 如果完成，提取图片信息并更新学习记录
    let images = null
    if (completed && task.outputs?.['9']?.images) {
      images = task.outputs['9'].images.map(img => ({
        filename: img.filename,
        // 改为通过后端代理访问，避免跨域问题
        url: `/api/proxy-image?filename=${encodeURIComponent(img.filename)}`,
        width: img.width,
        height: img.height
      }))
      progress = 100
    }

    // 获取预估总时长（秒），用于前端平滑进度计算（在更新学习记录前获取）
    const meta = progressLearner.taskMeta[prompt_id]
    const estimatedDuration = meta ? progressLearner.getEstimatedDuration(meta.width, meta.height) : 180

    // 完成时更新学习记录（在返回响应后执行）
    if (completed) {
      progressLearner.completeTask(prompt_id)
    }

    res.json({
      success: true,
      status,
      completed,
      progress,
      estimatedDuration,
      images,
      error: task.error || null
    })
  } catch (error) {
    console.error('❌ 查询状态失败：', error)
    res.status(500).json({ success: false, message: error.message || '查询失败' })
  }
})

// 代理图片请求，解决跨域问题
app.get('/api/proxy-image', async (req, res) => {
  try {
    const { filename } = req.query
    if (!filename) {
      return res.status(400).send('Missing filename')
    }

    // 请求ComfyUI的图片
    const imageUrl = `${COMFYUI_SERVER}/view?filename=${encodeURIComponent(filename)}&subfolder=&type=output`
    const imageResp = await new Promise((resolve, reject) => {
      https.get(imageUrl, (response) => {
        let data = Buffer.from('')
        response.on('data', chunk => data = Buffer.concat([data, chunk]))
        response.on('end', () => resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body: data
        }))
      }).on('error', reject).end()
    })

    // 设置允许跨域
    res.set('Access-Control-Allow-Origin', '*')
    res.set('Content-Type', 'image/png')
    res.status(imageResp.statusCode).send(imageResp.body)
  } catch (error) {
    console.error('❌ 代理图片失败：', error)
    res.status(500).send('Failed to fetch image')
  }
})

// 轮询历史记录辅助函数
function pollHistory(prompt_id) {
  return new Promise((resolve, reject) => {
    const apiUrl = new URL(`/history/${prompt_id}`, COMFYUI_SERVER)
    https.request({
      hostname: apiUrl.hostname,
      port: apiUrl.port || 443,
      path: apiUrl.pathname,
      method: 'GET'
    }, (response) => {
      let data = ''
      response.on('data', chunk => data += chunk)
      response.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(new Error('解析历史记录失败: ' + e.message))
        }
      })
    }).on('error', reject).end()
  })
}

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// 热重载知识库
app.post('/api/reload-knowledge', (req, res) => {
  try {
    const data = fs.readFileSync(KNOWLEDGE_FILE, 'utf-8')
    knowledgeBase = JSON.parse(data)
    const count = knowledgeBase.categories?.length || 0
    console.log(`🔄 知识库重载成功：${count} 个类别`)
    res.json({
      success: true,
      message: '知识库重载成功',
      count,
      name: knowledgeBase.knowledge_base_name
    })
  } catch (err) {
    console.error('❌ 知识库重载失败：', err.message)
    res.status(500).json({
      success: false,
      message: '知识库重载失败',
      error: err.message
    })
  }
})

// 全局错误处理器
app.use((err, req, res, next) => {
  console.error('全局错误：', err)
  if (!res.headersSent) {
    res.status(500).json({ success: false, message: '服务器内部错误' })
  }
})

// 处理 favicon 请求（避免 404）
app.get('/favicon.ico', (req, res) => {
  const path = require('path')
  const fs = require('fs')
  const faviconPath = path.join(__dirname, 'public', 'favicon.svg')
  if (fs.existsSync(faviconPath)) {
    res.type('image/svg+xml')
    res.sendFile(faviconPath)
  } else {
    res.status(204).end()
  }
})

// 托管静态文件
app.use(express.static('public'))

const PORT = 10005
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 服务器启动成功！`)
  console.log(`📍 本地访问：http://localhost:${PORT}`)
  console.log(`🔌 ComfyUI后端：${COMFYUI_SERVER}\n`)
})