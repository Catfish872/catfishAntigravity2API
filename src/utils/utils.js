import config from '../config/config.js';
import tokenManager from '../auth/token_manager.js';
import { generateRequestId } from './idGenerator.js';
import os from 'os';

function extractImagesFromContent(content) {
  const result = { text: '', images: [] };

  // 如果content是字符串，直接返回
  if (typeof content === 'string') {
    result.text = content;
    return result;
  }

  // 如果content是数组（multimodal格式）
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text') {
        result.text += item.text;
      } else if (item.type === 'image_url') {
        // 提取base64图片数据
        const imageUrl = item.image_url?.url || '';

        // 匹配 data:image/{format};base64,{data} 格式
        const match = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (match) {
          const format = match[1]; // 例如 png, jpeg, jpg
          const base64Data = match[2];
          result.images.push({
            inlineData: {
              mimeType: `image/${format}`,
              data: base64Data
            }
          })
        }
      }
    }
  }

  return result;
}
function handleUserMessage(extracted, antigravityMessages){
  antigravityMessages.push({
    role: "user",
    parts: [
      {
        text: extracted.text
      },
      ...extracted.images
    ]
  })
}
function handleAssistantMessage(message, antigravityMessages){
  // 1. 检查内容
  const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;
  let content = message.content || '';

  
  if (hasToolCalls) {
    // 把工具调用转成文本描述
    // 格式: [Thinking Process] I am calling tool: xxx with args: xxx
    const toolDescriptions = message.tool_calls.map(tc => 
      `[System Note: Model requested tool '${tc.function.name}' with args: ${tc.function.arguments}]`
    ).join('\n');

    // 把这段描述拼接到 content 后面
    if (content) content += '\n';
    content += toolDescriptions;
  }

  // 2. 构造消息 parts
  // 注意：我们现在只发 text，不再发 functionCall 对象了！
  const parts = [];
  if (content && content.trim() !== '') {
      parts.push({ text: content });
  } else {
      // 防止空消息报错
      parts.push({ text: "..." });
  }
    
  // 3. 推入消息队列
  // 简化逻辑：不再尝试合并上一条消息，直接作为新的 Model 消息推入
  // 只要 role 是 model，Google 就能理解这是它自己说的话
  antigravityMessages.push({
    role: "model",
    parts: parts
  });
}
function handleToolCall(message, antigravityMessages){
  // 从之前的 model 消息中找到对应的 functionCall name
  let functionName = '';
  for (let i = antigravityMessages.length - 1; i >= 0; i--) {
    if (antigravityMessages[i].role === 'model') {
      const parts = antigravityMessages[i].parts;
      for (const part of parts) {
        if (part.functionCall && part.functionCall.id === message.tool_call_id) {
          functionName = part.functionCall.name;
          break;
        }
      }
      if (functionName) break;
    }
  }
  
  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const functionResponse = {
    functionResponse: {
      id: message.tool_call_id,
      name: functionName,
      response: {
        output: message.content
      }
    }
  };
  
  // 如果上一条消息是 user 且包含 functionResponse，则合并
  if (lastMessage?.role === "user" && lastMessage.parts.some(p => p.functionResponse)) {
    lastMessage.parts.push(functionResponse);
  } else {
    antigravityMessages.push({
      role: "user",
      parts: [functionResponse]
    });
  }
}
function openaiMessageToAntigravity(openaiMessages){
  const antigravityMessages = [];
  
  for (const message of openaiMessages) {
    if (message.role === "user") {
      const extracted = extractImagesFromContent(message.content);
      handleUserMessage(extracted, antigravityMessages);
    } else if (message.role === "assistant") {
      handleAssistantMessage(message, antigravityMessages);
    } else if (message.role === "tool") {
      // =================================================================
      // 【完全复刻 cli2api 逻辑】
      // 将 role 伪装为 "user"，但内容依然保持 functionResponse 结构
      // =================================================================
      
      // 1. 找回函数名 (逻辑与 Python 版一致：如果没有 name 就去历史记录里倒查)
      let functionName = message.name; 
      if (!functionName) {
          for (let i = antigravityMessages.length - 1; i >= 0; i--) {
            if (antigravityMessages[i].role === 'model') { // Antigravity 里 assistant 叫 model
              const parts = antigravityMessages[i].parts;
              for (const part of parts) {
                if (part.functionCall && part.functionCall.id === message.tool_call_id) {
                  functionName = part.functionCall.name;
                  break;
                }
              }
            }
            if (functionName) break;
          }
      }

      // 2. 构造消息：Role 是 user，但 Part 是 functionResponse
      const fakeUserToolMessage = {
        role: "user",  // <--- 关键点：伪装成用户
        parts: [{
          functionResponse: {
            name: functionName || "unknown_tool",
            response: {
              content: message.content // 工具返回的 JSON 字符串结果
            }
          }
        }]
      };

      // 3. 推入消息队列
      // 这里的逻辑比 handleToolCall 更简单直接，不做上一条消息合并，直接作为新消息发送
      // 这也是 cli2api 的做法
      antigravityMessages.push(fakeUserToolMessage);
    }
  }
  
  return antigravityMessages;
}
function generateGenerationConfig(parameters, enableThinking, actualModelName){
  const generationConfig = {
    topP: parameters.top_p ?? config.defaults.top_p,
    topK: parameters.top_k ?? config.defaults.top_k,
    temperature: parameters.temperature ?? config.defaults.temperature,
    candidateCount: 1,
    maxOutputTokens: parameters.max_tokens ?? config.defaults.max_tokens,
    stopSequences: [
      "<|user|>",
      "<|bot|>",
      "<|context_request|>",
      "<|endoftext|>",
      "<|end_of_turn|>"
    ],
    thinkingConfig: {
      includeThoughts: enableThinking,
      thinkingBudget: enableThinking ? 1024 : 0
    }
  }
  if (enableThinking && actualModelName.includes("claude")){
    delete generationConfig.topP;
  }
  return generationConfig
}
function convertOpenAIToolsToAntigravity(openaiTools){
  if (!openaiTools || openaiTools.length === 0) return [];
  return openaiTools.map((tool)=>{
    delete tool.function.parameters.$schema;
    return {
      functionDeclarations: [
        {
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters
        }
      ]
    }
  })
}

function modelMapping(modelName){
  if (modelName === "claude-sonnet-4-5-thinking"){
    return "claude-sonnet-4-5";
  } else if (modelName === "claude-opus-4-5"){
    return "claude-opus-4-5-thinking";
  } else if (modelName === "gemini-2.5-flash-thinking"){
    return "gemini-2.5-flash";
  }
  return modelName;
}

function isEnableThinking(modelName){
  return modelName.endsWith('-thinking') ||
    modelName === 'gemini-2.5-pro' ||
    modelName.startsWith('gemini-3-pro-') ||
    modelName === "rev19-uic3-1p" ||
    modelName === "gpt-oss-120b-medium"
}

function generateRequestBody(openaiMessages,modelName,parameters,openaiTools,token){
  
  const enableThinking = isEnableThinking(modelName);
  const actualModelName = modelMapping(modelName);
  
  // 修改点 2: 提取 System Prompt 逻辑
  // 先尝试从客户端消息中找到 role 为 'system' 的第一条消息
  const clientSystemMessage = openaiMessages.find(msg => msg.role === 'system');
  
  // 如果客户端发了，就用客户端的；否则用环境变量里的 config.systemInstruction 兜底
  const finalSystemInstruction = clientSystemMessage 
    ? clientSystemMessage.content 
    : config.systemInstruction;

  return{
    project: token.projectId,
    requestId: generateRequestId(),
    request: {
      contents: openaiMessageToAntigravity(openaiMessages),
      systemInstruction: {
        role: "user",
        // 使用计算出的最终 Prompt
        parts: [{ text: finalSystemInstruction || '' }] 
      },
      tools: convertOpenAIToolsToAntigravity(openaiTools),
      toolConfig: {
        functionCallingConfig: {
          mode: "VALIDATED"
        }
      },
      generationConfig: generateGenerationConfig(parameters, enableThinking, actualModelName),
      sessionId: token.sessionId
    },
    model: actualModelName,
    userAgent: "antigravity"
  }
}
function getDefaultIp(){
  const interfaces = os.networkInterfaces();
  if (interfaces.WLAN){
    for (const inter of interfaces.WLAN){
      if (inter.family === 'IPv4' && !inter.internal){
          return inter.address;
      }
    }
  } else if (interfaces.wlan2) {
    for (const inter of interfaces.wlan2) {
      if (inter.family === 'IPv4' && !inter.internal) {
        return inter.address;
      }
    }
  }
  return '127.0.0.1';
}
export{
  generateRequestId,
  generateRequestBody,
  getDefaultIp
}
