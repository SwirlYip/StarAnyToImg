#!/bin/bash

# 测试知识库生效性脚本

echo "🧪 开始测试知识库功能"
echo "================================"
echo ""

# 1. 备份原知识库
echo "📦 1. 备份原知识库..."
cp knowledge.json knowledge.json.backup
echo "   ✅ 已备份到 knowledge.json.backup"
echo ""

# 2. 替换为测试知识库
echo "🔄 2. 替换为测试知识库（3 个类别）..."
cp test-knowledge-minimal.json knowledge.json
echo "   ✅ 已替换为测试知识库"
echo ""

# 3. 重启服务器（如果需要）
echo "🚀 3. 重启服务器（按 Ctrl+C 后手动运行 node server.js）"
echo "   或者服务器会自动热重载知识库"
echo ""

# 4. 等待用户重启
read -p "❓ 服务器已重启吗？(y/n) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ 请先重启服务器（node server.js），然后重新运行此脚本"
    mv knowledge.json.backup knowledge.json
    exit 1
fi

echo ""
echo "🧪 开始测试生成..."
echo ""

# 5. 测试 1：紫色天空
echo "测试 1：紫色天空"
curl -s -X POST http://localhost:10005/api/generate \
    -H "Content-Type: application/json" \
    -d '{"description": "天空场景", "resolution": "1024x1024"}' \
    | jq -r '"正向提示词: \(.enhanced.positive // "无")"'
echo ""
echo ""

# 6. 测试 2：火焰海浪
echo "测试 2：火焰海浪"
curl -s -X POST http://localhost:10005/api/generate \
    -H "Content-Type: application/json" \
    -d '{"description": "海浪场景", "resolution": "1024x1024"}' \
    | jq -r '"正向提示词: \(.enhanced.positive // "无")"'
echo ""
echo ""

# 7. 测试 3：钻石森林
echo "测试 3：钻石森林"
curl -s -X POST http://localhost:10005/api/generate \
    -H "Content-Type: application/json" \
    -d '{"description": "森林场景", "resolution": "1024x1024"}' \
    | jq -r '"正向提示词: \(.enhanced.positive // "无")"'
echo ""
echo ""

echo "================================"
echo "✅ 测试完成"
echo ""
echo "📊 分析结果："
echo "   如果看到 'purple sky'、'burning waves'、'diamond forest' 等词 → 知识库生效 ✅"
echo "   如果只是通用描述 → 知识库未生效 ❌"
echo ""
echo "🔄 恢复原知识库："
echo "   mv knowledge.json.backup knowledge.json"
