const express = require('express')
const cors = require('cors')
const http = require('http')
const { OpenAI } = require('openai')
const app = express()

const COMFYUI_SERVER = 'http://43.130.105.192:8188'
const fs = require('fs')
const path = require('path')

const LEARNING_FILE = path.join(__dirname, 'learning.json')

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

// 星澜智能绘图工作流模板
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

// LLM 提示词增强函数
async function enhancePrompt(description) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'qwen/qwen3-next-80b-a3b-instruct',
      messages: [
        {
          role: 'system',
          content: `你是专业AI文生图/图生视频提示词工程师，精通Stable Diffusion、SVD、Open-Sora、WAN Video。
你的任务：把用户输入的自然语言，转化为精准、高质量、可直接商用的提示词，并确定合适的参数。

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
    return JSON.parse(jsonStr)
  } catch (error) {
    console.error('LLM增强失败:', error.message || error)
    throw error
  }
}

// 提交生成任务（只返回 prompt_id）
app.post('/api/generate', async (req, res) => {
  try {
    const { description, positive, negative, seed, steps, cfg, width, height, resolution } = req.body

    // 判断使用模式：有 description 则通过 LLM 增强，否则使用旧参数
    let finalPositive, finalNegative, finalSeed, finalSteps, finalCfg, finalWidth, finalHeight

    if (description) {
      // 新协议：通过 LLM 增强
      try {
        const enhanced = await enhancePrompt(description)
        finalPositive = enhanced.positive
        finalNegative = enhanced.negative || "blurry, low quality, distorted, ugly, bad anatomy, deformed, poorly drawn"
        finalSteps = enhanced.steps || 20
        finalCfg = enhanced.cfg || 5
        finalSeed = enhanced.seed || Math.floor(Math.random() * 999999999999)
        if (resolution) {
          [finalWidth, finalHeight] = resolution.split('x').map(Number)
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
        if (resolution) {
          [finalWidth, finalHeight] = resolution.split('x').map(Number)
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

    const workflow = JSON.parse(JSON.stringify(OMNIGEN2_WORKFLOW))

    // 填充参数
    workflow["42:6"]["inputs"]["text"] = finalPositive
    workflow["42:7"]["inputs"]["text"] = finalNegative
    workflow["42:21"]["inputs"]["noise_seed"] = finalSeed
    workflow["42:23"]["inputs"]["steps"] = finalSteps
    workflow["42:27"]["inputs"]["cfg_conds"] = finalCfg
    workflow["42:11"]["inputs"]["width"] = finalWidth
    workflow["42:11"]["inputs"]["height"] = finalHeight

    console.log(`📤 收到 星澜智能绘图 请求：描述="${description?.substring(0,30)}..." 分辨率：${finalWidth}x${finalHeight} 步数：${finalSteps} CFG：${finalCfg} 种子：${finalSeed}`)

    // 提交任务到ComfyUI
    const postPrompt = () => {
      return new Promise((resolve, reject) => {
        const postData = JSON.stringify({ prompt: workflow })
        const options = {
          hostname: '43.130.105.192',
          port: 8188,
          path: '/prompt',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          }
        }

        const request = http.request(options, (response) => {
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
    const prompt_id = promptResult.prompt_id
    console.log(`✅ 任务提交成功：${prompt_id}`)

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
    if (description && finalPositive) {
      responseData.enhanced = {
        positive: finalPositive,
        negative: finalNegative,
        steps: finalSteps,
        cfg: finalCfg,
        seed: finalSeed
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
    const imageUrl = `http://43.130.105.192:8188/view?filename=${encodeURIComponent(filename)}&subfolder=&type=output`
    const imageResp = await new Promise((resolve, reject) => {
      http.get(imageUrl, (response) => {
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
    http.request({
      hostname: '43.130.105.192',
      port: 8188,
      path: `/history/${prompt_id}`,
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

// 全局错误处理器
app.use((err, req, res, next) => {
  console.error('全局错误：', err)
  if (!res.headersSent) {
    res.status(500).json({ success: false, message: '服务器内部错误' })
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