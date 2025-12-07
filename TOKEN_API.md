# Token 管理 API 文档

## 概述

提供对本地 Token 凭证的完整管理功能，支持增删改查和热重载。所有操作都会自动更新内存中的 Token 池。

## 认证

所有 API 请求需要在请求头中包含 API Key：

```
Authorization: Bearer sk-text  // 配置内文件配置
```

## 接口列表

### 1. 获取 Token 列表

**请求**
```bash
GET /v1/tokens
```

**响应**
```json
{
  "success": true,
  "data": [
    {
      "refresh_token": "1//xxx",
      "access_token_suffix": "...abc12345",
      "expires_in": 3599,
      "timestamp": 1234567890000,
      "enable": true,
      "projectId": "project-123"
    }
  ]
}
```

### 2. 添加新 Token

**请求**
```bash
POST /v1/tokens
Content-Type: application/json

{
  "access_token": "ya29.xxx",
  "refresh_token": "1//xxx",
  "expires_in": 3599
}
```

**响应**
```json
{
  "success": true,
  "message": "Token添加成功"
}
```

### 3. 更新 Token

**请求**
```bash
PUT /v1/tokens/{refresh_token}
Content-Type: application/json

{
  "enable": false,
  "access_token": "new_token"
}
```

**响应**
```json
{
  "success": true,
  "message": "Token更新成功"
}
```

### 4. 删除 Token

**请求**
```bash
DELETE /v1/tokens/{refresh_token}
```

**响应**
```json
{
  "success": true,
  "message": "Token删除成功"
}
```

### 5. 热重载 Token

**请求**
```bash
POST /v1/tokens/reload
```

**响应**
```json
{
  "success": true,
  "message": "Token已热重载"
}
```

## 使用示例

### 查看当前 Token 状态
```bash
curl http://localhost:8045/v1/tokens \
  -H "Authorization: Bearer sk-text"
```

### 添加新账号
```bash
curl -X POST http://localhost:8045/v1/tokens \
  -H "Authorization: Bearer sk-text" \
  -H "Content-Type: application/json" \
  -d '{
    "access_token": "ya29.a0ARrdaM...",
    "refresh_token": "1//0GWI4...",
    "expires_in": 3599
  }'
```

### 禁用某个账号
```bash
curl -X PUT http://localhost:8045/v1/tokens/1//0GWI4... \
  -H "Authorization: Bearer sk-text" \
  -H "Content-Type: application/json" \
  -d '{"enable": false}'
```

### 删除账号
```bash
curl -X DELETE http://localhost:8045/v1/tokens/1//0GWI4... \
  -H "Authorization: Bearer sk-text"
```

### 重新加载配置
```bash
curl -X POST http://localhost:8045/v1/tokens/reload \
  -H "Authorization: Bearer sk-text"
```

## 注意事项

1. **refresh_token** 作为唯一标识符，不可重复
2. 所有操作会立即生效，无需重启服务
3. 删除操作不可恢复，请谨慎使用
4. Token 过期会自动刷新，无需手动维护
5. 禁用的 Token 不会参与轮换，但仍保存在文件中

## 错误码

- `400` - 请求参数错误
- `401` - API Key 验证失败
- `500` - 服务器内部错误

## 安全建议

- 定期备份 `data/accounts.json` 文件
- 不要在日志中暴露完整的 Token 信息
- 建议使用 HTTPS 部署生产环境