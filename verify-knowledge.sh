#!/bin/bash

# 智能知识库检索系统 - 快速验证脚本

echo "🧪 智能知识库检索系统验证"
echo "=================================="
echo ""

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 测试用例
declare -A TESTS=(
    ["测试1: 江南水乡"]="江南水乡风景"
    ["测试2: 写实人像"]="写实风格的人像"
    ["测试3: 古风汉服"]="古风汉服美女，手持团扇"
    ["测试4: 治愈动漫"]="新海诚风格的治愈系动漫场景"
    ["测试5: 日出"]="海边日出"
)

# 运行测试
for test_name in "${!TESTS[@]}"; do
    description="${TESTS[$test_name]}"

    echo "▶️  $test_name"
    echo "   描述：$description"

    # 发送请求
    response=$(curl -s -X POST http://localhost:10005/api/generate \
        -H "Content-Type: application/json" \
        -d "{\"description\": \"$description\", \"resolution\": \"1024x1024\"}")

    # 检查是否成功
    if echo "$response" | grep -q '"success":true'; then
        echo -e "   ✅ ${GREEN}请求成功${NC}"

        # 提取正向提示词（前100个字符）
        positive=$(echo "$response" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('enhanced', {}).get('positive', '')[:150])" 2>/dev/null || echo "")

        if [ -n "$positive" ]; then
            echo "   提示词：$positive..."
        fi
    else
        echo -e "   ❌ ${YELLOW}请求失败${NC}"
        echo "   响应：$response"
    fi
    echo ""
done

echo "=================================="
echo "✅ 测试完成"
echo ""
echo "📊 查看完整日志："
echo "   tail -f /tmp/comfyui-server.log"
echo ""
echo "🔍 查看知识库匹配详情："
echo "   tail -50 /tmp/comfyui-server.log | grep -A 10 '匹配'"
