import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateAssistantResponse, generateAssistantResponseNoStream, getAvailableModels, closeRequester } from '../api/client.js';
import { generateRequestBody } from '../utils/utils.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';
import tokenManager from '../auth/token_manager.js';
import adminRouter from '../routes/admin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// 工具函数：生成响应元数据
const createResponseMeta = () => ({
  id: `chatcmpl-${Date.now()}`,
  created: Math.floor(Date.now() / 1000)
});

// 工具函数：设置流式响应头
const setStreamHeaders = (res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
};

// 工具函数：构建流式数据块
const createStreamChunk = (id, created, model, delta, finish_reason = null) => ({
  id,
  object: 'chat.completion.chunk',
  created,
  model,
  choices: [{ index: 0, delta, finish_reason }]
});

// 工具函数：写入流式数据
const writeStreamData = (res, data) => {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};

// 工具函数：结束流式响应
const endStream = (res, id, created, model, finish_reason) => {
  writeStreamData(res, createStreamChunk(id, created, model, {}, finish_reason));
  res.write('data: [DONE]\n\n');
  res.end();
};

app.use(express.json({ limit: config.security.maxRequestSize }));

// 静态文件服务
app.use('/images', express.static(path.join(__dirname, '../../public/images')));
app.use(express.static(path.join(__dirname, '../../public')));

// 管理路由
app.use('/admin', adminRouter);

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: `请求体过大，最大支持 ${config.security.maxRequestSize}` });
  }
  next(err);
});

app.use((req, res, next) => {
  const ignorePaths = ['/images', '/favicon.ico', '/.well-known'];
  if (!ignorePaths.some(path => req.path.startsWith(path))) {
    const start = Date.now();
    res.on('finish', () => {
      logger.request(req.method, req.path, res.statusCode, Date.now() - start);
    });
  }
  next();
});

app.use((req, res, next) => {
  if (req.path.startsWith('/v1/')) {
    const apiKey = config.security?.apiKey;
    if (apiKey) {
      const authHeader = req.headers.authorization;
      const providedKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
      if (providedKey !== apiKey) {
        logger.warn(`API Key 验证失败: ${req.method} ${req.path}`);
        return res.status(401).json({ error: 'Invalid API Key' });
      }
    }
  }
  next();
});

app.get('/v1/models', async (req, res) => {
  try {
    const models = await getAvailableModels();
    res.json(models);
  } catch (error) {
    logger.error('获取模型列表失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});



app.post('/v1/chat/completions', async (req, res) => {
  const { messages, model, stream = false, tools, ...params} = req.body;
  try {
    if (!messages) {
      return res.status(400).json({ error: 'messages is required' });
    }
    const token = await tokenManager.getToken();
    if (!token) {
      throw new Error('没有可用的token，请运行 npm run login 获取token');
    }
    const isImageModel = model.includes('-image');
    const requestBody = generateRequestBody(messages, model, params, tools, token);
    if (isImageModel) {
      requestBody.request.generationConfig={
        candidateCount: 1,
        // imageConfig:{
        //   aspectRatio: "1:1"
        // }
      }
      requestBody.requestType="image_gen";
      //requestBody.request.systemInstruction.parts[0].text += "现在你作为绘画模型聚焦于帮助用户生成图片";
      delete requestBody.request.systemInstruction;
      delete requestBody.request.tools;
      delete requestBody.request.toolConfig;
    }
    //console.log(JSON.stringify(requestBody,null,2))
    
    const { id, created } = createResponseMeta();
    
    if (stream) {
      setStreamHeaders(res);
      
      if (isImageModel) {
        const { content } = await generateAssistantResponseNoStream(requestBody, token);
        writeStreamData(res, createStreamChunk(id, created, model, { content }));
        endStream(res, id, created, model, 'stop');
      } else {
        let hasToolCall = false;
        await generateAssistantResponse(requestBody, token, (data) => {
          // 【核心修改点】
          // 如果是 thinking 类型，放入 reasoning_content (DeepSeek 标准)
          // 如果是 text 类型，放入 content
          let delta = {};
          
          if (data.type === 'tool_calls') {
              delta = { tool_calls: data.tool_calls };
              hasToolCall = true;
          } else if (data.type === 'thinking') {
              // 这里是关键！把思考过程给到 reasoning_content
              delta = { reasoning_content: data.content };
          } else {
              // 普通文本
              delta = { content: data.content };
          }
          writeStreamData(res, createStreamChunk(id, created, model, delta));
        });
        endStream(res, id, created, model, hasToolCall ? 'tool_calls' : 'stop');
      }
    } else {
      // 非流式响应处理
      
      // 1. 解构出 reasoning_content
      const { content, toolCalls, reasoning_content } = await generateAssistantResponseNoStream(requestBody, token);
      
      const message = { role: 'assistant', content };
      
      // 2. 如果有工具调用，加上
      if (toolCalls.length > 0) message.tool_calls = toolCalls;
      
      // 3. 【核心修改点】如果有思考内容，加上 reasoning_content 字段 (DeepSeek 标准)
      if (reasoning_content) {
          message.reasoning_content = reasoning_content;
      }
      
      res.json({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{
          index: 0,
          message, // message 对象里现在包含了 clean 的 content 和独立的 reasoning_content
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
        }]
      });
    }
  } catch (error) {
    logger.error('生成响应失败:', error.message);
    if (!res.headersSent) {
      // 尝试解析错误状态码，如果包含 429 或 capacity 等字眼，强制设为 429
      let status = 500;
      if (error.message.includes('429') || error.message.includes('capacity') || error.message.includes('RESOURCE_EXHAUSTED')) {
        status = 429;
      } else if (error.status) {
        status = error.status;
      }

      // 构造标准的 OpenAI 错误对象
      const errorResponse = {
        error: {
          message: error.message || "Internal Server Error",
          type: "server_error",
          param: null,
          code: status === 429 ? "rate_limit_exceeded" : "internal_error"
        }
      };

      if (stream) {
        // 如果是流式，虽然头已经发了 200 (在 setStreamHeaders 之后)，
        // 但我们可以发送一个特殊的 error 块然后结束，或者干脆直接断开
        // 标准做法是流式开启后很难改状态码，但可以发送错误内容
        // 这里最好的做法是：如果在 setStreamHeaders 之前就错了，发 JSON 错误
        // 如果流传输中途错了，目前的做法（写在内容里）其实是无奈之举
        // 但既然 Antigravity 的错误通常发生在连接建立初期，我们应该尽量在 setHeaders 前捕获
        
        // *修正逻辑：如果还没发 Header，发标准 JSON 错误*
        if (!res.headersSent) {
             return res.status(status).json(errorResponse);
        }
        
        // 如果流已经开始了，只能发内容提示错误，或者直接 res.end() 截断
        writeStreamData(res, createStreamChunk(id, created, model, { content: `\n\n[System Error: ${error.message}]` }));
        endStream(res, id, created, model, 'stop');
      } else {
        // 非流式，直接返回对应的 HTTP 状态码
        res.status(status).json(errorResponse);
      }
    }
  }
});

const server = app.listen(config.server.port, config.server.host, () => {
  logger.info(`服务器已启动: ${config.server.host}:${config.server.port}`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`端口 ${config.server.port} 已被占用`);
    process.exit(1);
  } else if (error.code === 'EACCES') {
    logger.error(`端口 ${config.server.port} 无权限访问`);
    process.exit(1);
  } else {
    logger.error('服务器启动失败:', error.message);
    process.exit(1);
  }
});

const shutdown = () => {
  logger.info('正在关闭服务器...');
  closeRequester();
  server.close(() => {
    logger.info('服务器已关闭');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
