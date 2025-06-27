import { ILLMService, Message, StreamHandlers, ModelInfo, ModelOption } from './types';
import { ModelConfig } from '../model/types';
import { ModelManager, modelManager as defaultModelManager } from '../model/manager';
import { APIError, RequestConfigError, ERROR_MESSAGES } from './errors';
import OpenAI from 'openai';
import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { isVercel, getProxyUrl } from '../../utils/environment';

/**
 * LLM服务实现 - 基于官方SDK
 */
export class LLMService implements ILLMService {
  constructor(private modelManager: ModelManager) { }

  /**
   * 验证消息格式
   */
  private validateMessages(messages: Message[]): void {
    if (!Array.isArray(messages)) {
      throw new RequestConfigError('消息必须是数组格式');
    }
    if (messages.length === 0) {
      throw new RequestConfigError('消息列表不能为空');
    }
    messages.forEach(msg => {
      if (!msg.role || !msg.content) {
        throw new RequestConfigError('消息格式无效: 缺少必要字段');
      }
      if (!['system', 'user', 'assistant'].includes(msg.role)) {
        throw new RequestConfigError(`不支持的消息类型: ${msg.role}`);
      }
      if (typeof msg.content !== 'string') {
        throw new RequestConfigError('消息内容必须是字符串');
      }
    });
  }

  /**
   * 验证模型配置
   */
  private validateModelConfig(modelConfig: ModelConfig): void {
    if (!modelConfig) {
      throw new RequestConfigError('模型配置不能为空');
    }
    if (!modelConfig.provider) {
      throw new RequestConfigError('模型提供商不能为空');
    }
    if (!modelConfig.apiKey) {
      throw new RequestConfigError(ERROR_MESSAGES.API_KEY_REQUIRED);
    }
    if (!modelConfig.defaultModel) {
      throw new RequestConfigError('默认模型不能为空');
    }
    if (!modelConfig.enabled) {
      throw new RequestConfigError('模型未启用');
    }
  }

  /**
   * 获取OpenAI实例
   */
  private getOpenAIInstance(modelConfig: ModelConfig, isStream: boolean = false): OpenAI {

    const apiKey = modelConfig.apiKey || '';

    // 处理baseURL，如果以'/chat/completions'结尾则去掉
    let processedBaseURL = modelConfig.baseURL;
    if (processedBaseURL?.endsWith('/chat/completions')) {
      processedBaseURL = processedBaseURL.slice(0, -'/chat/completions'.length);
    }

    // 使用代理处理跨域问题
    let finalBaseURL = processedBaseURL;
    // 如果模型配置启用了Vercel代理且当前环境是Vercel，则使用代理
    // 允许所有API包括OpenAI使用代理
    if (modelConfig.useVercelProxy === true && isVercel() && processedBaseURL) {
      finalBaseURL = getProxyUrl(processedBaseURL, isStream);
    }

    // 创建OpenAI实例配置
    const defaultTimeout = isStream ? 90000 : 60000;
    const timeout = modelConfig.llmParams?.timeout !== undefined
                    ? modelConfig.llmParams.timeout
                    : defaultTimeout;
    const config: any = {
      apiKey: apiKey,
      baseURL: finalBaseURL,
      dangerouslyAllowBrowser: true,
      timeout: timeout, // Use the new timeout logic
      maxRetries: isStream ? 2 : 3
    };

    const instance = new OpenAI(config);

    return instance;
  }

  /**
   * 获取Gemini实例
   */
  private getGeminiModel(modelConfig: ModelConfig, systemInstruction?: string, isStream: boolean = false): GenerativeModel {
    const apiKey = modelConfig.apiKey || '';
    const genAI = new GoogleGenerativeAI(apiKey);

    // 创建模型配置
    const modelOptions: any = {
      model: modelConfig.defaultModel
    };

    // 如果有系统指令，添加到模型配置中
    if (systemInstruction) {
      modelOptions.systemInstruction = systemInstruction;
    }

    // 处理baseURL，如果以'/v1beta'结尾则去掉
    let processedBaseURL = modelConfig.baseURL;
    if (processedBaseURL?.endsWith('/v1beta')) {
      processedBaseURL = processedBaseURL.slice(0, -'/v1beta'.length);
    }
    // 使用代理处理跨域问题
    let finalBaseURL = processedBaseURL;
    // 如果模型配置启用了Vercel代理且当前环境是Vercel，则使用代理
    // 允许所有API包括OpenAI使用代理
    if (modelConfig.useVercelProxy === true && isVercel() && processedBaseURL) {
      finalBaseURL = getProxyUrl(processedBaseURL, isStream);
    }
    return genAI.getGenerativeModel(modelOptions, { "baseUrl": finalBaseURL });
  }

  /**
   * 发送OpenAI消息
   */
  private async sendOpenAIMessage(messages: Message[], modelConfig: ModelConfig): Promise<string> {
    const openai = this.getOpenAIInstance(modelConfig);

    const formattedMessages = messages.map(msg => ({
      role: msg.role,
      content: msg.content
    }));

    const {
      timeout, // Handled in getOpenAIInstance
      model: llmParamsModel, // Avoid overriding main model
      messages: llmParamsMessages, // Avoid overriding main messages
      ...restLlmParams
    } = modelConfig.llmParams || {};

    const completionConfig: any = {
      model: modelConfig.defaultModel,
      messages: formattedMessages,
      ...restLlmParams // Spread other params from llmParams
    };
    const response = await openai.chat.completions.create(completionConfig);

    return response.choices[0].message.content || '';
  }

  /**
   * 发送Gemini消息
   */
  private async sendGeminiMessage(messages: Message[], modelConfig: ModelConfig): Promise<string> {
    // 提取系统消息
    const systemMessages = messages.filter(msg => msg.role === 'system');
    const systemInstruction = systemMessages.length > 0
      ? systemMessages.map(msg => msg.content).join('\n')
      : '';

    // 获取带有系统指令的模型实例
    const model = this.getGeminiModel(modelConfig, systemInstruction, false);

    // 过滤出用户和助手消息
    const conversationMessages = messages.filter(msg => msg.role !== 'system');

    // 创建聊天会话
    const generationConfig = this.buildGeminiGenerationConfig(modelConfig.llmParams);

    const chatOptions: any = {
      history: this.formatGeminiHistory(conversationMessages)
    };
    if (Object.keys(generationConfig).length > 0) {
      chatOptions.generationConfig = generationConfig;
    }
    const chat = model.startChat(chatOptions);

    // 获取最后一条用户消息
    const lastUserMessage = conversationMessages.length > 0 &&
      conversationMessages[conversationMessages.length - 1].role === 'user'
      ? conversationMessages[conversationMessages.length - 1].content
      : '';

    // 如果没有用户消息，返回空字符串
    if (!lastUserMessage) {
      return '';
    }

    // 发送消息并获取响应
    const result = await chat.sendMessage(lastUserMessage);
    return result.response.text();
  }

  /**
   * 格式化Gemini历史消息
   */
  private formatGeminiHistory(messages: Message[]): any[] {
    if (messages.length <= 1) {
      return [];
    }

    // 排除最后一条消息（将由sendMessage单独发送）
    const historyMessages = messages.slice(0, -1);
    const formattedHistory = [];

    for (let i = 0; i < historyMessages.length; i++) {
      const msg = historyMessages[i];
      if (msg.role === 'user') {
        formattedHistory.push({
          role: 'user',
          parts: [{ text: msg.content }]
        });
      } else if (msg.role === 'assistant') {
        formattedHistory.push({
          role: 'model',
          parts: [{ text: msg.content }]
        });
      }
    }

    return formattedHistory;
  }

  /**
   * 发送消息
   */
  async sendMessage(messages: Message[], provider: string): Promise<string> {
    try {
      if (!provider) {
        throw new RequestConfigError('模型提供商不能为空');
      }

      const modelConfig = await this.modelManager.getModel(provider);
      if (!modelConfig) {
        throw new RequestConfigError(`模型 ${provider} 不存在`);
      }

      this.validateModelConfig(modelConfig);
      this.validateMessages(messages);

      console.log('发送消息:', {
        provider: modelConfig.provider,
        model: modelConfig.defaultModel,
        messagesCount: messages.length
      });

      if (modelConfig.provider === 'gemini') {
        return this.sendGeminiMessage(messages, modelConfig);
      } else if (modelConfig.provider.toLowerCase() === 'azure') {
        // 使用原生HTTP请求，直接调用Azure OpenAI API
        return this.sendAzureHttpMessage(messages, modelConfig);
      } else {
        // OpenAI兼容格式的API，包括DeepSeek和自定义模型
        return this.sendOpenAIMessage(messages, modelConfig);
      }
    } catch (error: any) {
      if (error instanceof RequestConfigError || error instanceof APIError) {
        throw error;
      }
      throw new APIError(`发送消息失败: ${error.message}`);
    }
  }

  /**
   * 发送Azure OpenAI HTTP请求消息
   */
  private async sendAzureHttpMessage(messages: Message[], modelConfig: ModelConfig): Promise<string> {
    const formattedMessages = messages.map(msg => ({
      role: msg.role,
      content: msg.content
    }));

    const requestBody = {
      model: modelConfig.defaultModel,
      messages: formattedMessages,
      ...modelConfig.llmParams
    };

    // 处理Azure OpenAI的URL和api-version参数
    let finalURL = modelConfig.baseURL;
    
    // 移除末尾的斜杠，避免判断错误
    finalURL = finalURL.replace(/\/+$/, '');
    
    // 如果URL还没有包含api-version参数，添加默认值
    if (!finalURL.includes('api-version=')) {
      const separator = finalURL.includes('?') ? '&' : '?';
      finalURL = `${finalURL}${separator}api-version=2024-02-15-preview`;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (modelConfig.apiKey) {
      // 检查是否是Azure OpenAI (通过URL判断)
      if (modelConfig.baseURL?.includes('openai.azure.com')) {
        // Azure OpenAI使用api-key头
        headers['api-key'] = modelConfig.apiKey;
      } else {
        // 其他API使用Authorization Bearer Token
        headers['Authorization'] = `Bearer ${modelConfig.apiKey}`;
      }
    }

    try {
      const response = await fetch(finalURL, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        // 安全的错误日志，不暴露请求详情
        console.error(`Azure OpenAI API请求失败: ${response.status} ${response.statusText}`);
        throw new APIError(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      
      // 尝试解析不同格式的响应
      if (data.choices && data.choices[0] && data.choices[0].message) {
        // OpenAI格式
        return data.choices[0].message.content || '';
      } else if (data.response) {
        // 简单格式
        return data.response;
      } else if (data.content) {
        // 另一种格式
        return data.content;
      } else if (typeof data === 'string') {
        // 纯文本响应
        return data;
      } else {
        throw new APIError('无法解析API响应格式');
      }
    } catch (error: any) {
      // 安全的错误处理，不暴露敏感信息
      if (error instanceof APIError) {
        throw error;
      }
      console.error('Azure OpenAI请求异常:', error.name, error.message);
      throw new APIError(`请求失败: ${error.message}`);
    }
  }

  /**
   * 发送消息（流式）
   */
  async sendMessageStream(
    messages: Message[],
    provider: string,
    callbacks: StreamHandlers
  ): Promise<void> {
    try {
      console.log('开始流式请求:', { provider, messagesCount: messages.length });
      this.validateMessages(messages);

      const modelConfig = await this.modelManager.getModel(provider);
      if (!modelConfig) {
        throw new RequestConfigError(`模型 ${provider} 不存在`);
      }

      this.validateModelConfig(modelConfig);

      console.log('获取到模型实例:', {
        provider: modelConfig.provider,
        model: modelConfig.defaultModel
      });

      if (modelConfig.provider === 'gemini') {
        await this.streamGeminiMessage(messages, modelConfig, callbacks);
      } else if (modelConfig.provider.toLowerCase() === 'azure') {
        // 对于azure类型，目前不支持流式，回退到普通请求
        const result = await this.sendAzureHttpMessage(messages, modelConfig);
        callbacks.onToken(result);
        callbacks.onComplete();
      } else {
        // OpenAI兼容格式的API，包括DeepSeek和自定义模型
        await this.streamOpenAIMessage(messages, modelConfig, callbacks);
      }
    } catch (error) {
      console.error('流式请求失败:', error);
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * 流式发送OpenAI消息
   */
  private async streamOpenAIMessage(
    messages: Message[],
    modelConfig: ModelConfig,
    callbacks: StreamHandlers
  ): Promise<void> {
    // 获取流式OpenAI实例
    const openai = this.getOpenAIInstance(modelConfig, true);

    const formattedMessages = messages.map(msg => ({
      role: msg.role,
      content: msg.content
    }));

    try {
      console.log('开始创建流式请求...');
      const {
        timeout, // Handled in getOpenAIInstance
        model: llmParamsModel, // Avoid overriding main model
        messages: llmParamsMessages, // Avoid overriding main messages
        stream: llmParamsStream, // Avoid overriding main stream flag
        ...restLlmParams
      } = modelConfig.llmParams || {};

      const completionConfig: any = {
        model: modelConfig.defaultModel,
        messages: formattedMessages,
        stream: true, // Essential for streaming
        ...restLlmParams // User-defined parameters from llmParams
      };
      
      // 直接使用流式响应，无需类型转换
      const stream = await openai.chat.completions.create(completionConfig);

      console.log('成功获取到流式响应');

      // 使用类型断言来确保TypeScript知道这是流式响应
      for await (const chunk of stream as any) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          callbacks.onToken(content);
          // 添加小延迟，让UI有时间更新
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }

      console.log('流式响应完成');
      callbacks.onComplete();
    } catch (error) {
      console.error('流式处理过程中出错:', error);
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * 流式发送Gemini消息
   */
  private async streamGeminiMessage(
    messages: Message[],
    modelConfig: ModelConfig,
    callbacks: StreamHandlers
  ): Promise<void> {
    // 提取系统消息
    const systemMessages = messages.filter(msg => msg.role === 'system');
    const systemInstruction = systemMessages.length > 0
      ? systemMessages.map(msg => msg.content).join('\n')
      : '';

    // 获取带有系统指令的模型实例
    const model = this.getGeminiModel(modelConfig, systemInstruction, true);

    // 过滤出用户和助手消息
    const conversationMessages = messages.filter(msg => msg.role !== 'system');

    // 创建聊天会话
    const generationConfig = this.buildGeminiGenerationConfig(modelConfig.llmParams);

    const chatOptions: any = {
      history: this.formatGeminiHistory(conversationMessages)
    };
    if (Object.keys(generationConfig).length > 0) {
      chatOptions.generationConfig = generationConfig;
    }
    const chat = model.startChat(chatOptions);

    // 获取最后一条用户消息
    const lastUserMessage = conversationMessages.length > 0 &&
      conversationMessages[conversationMessages.length - 1].role === 'user'
      ? conversationMessages[conversationMessages.length - 1].content
      : '';

    // 如果没有用户消息，返回空字符串
    if (!lastUserMessage) {
      callbacks.onComplete();
      return;
    }

    try {
      console.log('开始创建Gemini流式请求...');
      const result = await chat.sendMessageStream(lastUserMessage);

      console.log('成功获取到流式响应');

      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) {
          callbacks.onToken(text);
          // 添加小延迟，让UI有时间更新
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }

      console.log('流式响应完成');
      callbacks.onComplete();
    } catch (error) {
      console.error('流式处理过程中出错:', error);
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * 测试连接
   */
  async testConnection(provider: string): Promise<void> {
    try {
      if (!provider) {
        throw new RequestConfigError('模型提供商不能为空');
      }
      console.log('测试连接provider:', {
        provider: provider,
      });

      // 发送一个简单的测试消息
      const testMessages: Message[] = [
        {
          role: 'user',
          content: '请回答ok'
        }
      ];

      // 使用 sendMessage 进行测试
      await this.sendMessage(testMessages, provider);

    } catch (error: any) {
      if (error instanceof RequestConfigError || error instanceof APIError) {
        throw error;
      }
      throw new APIError(`连接测试失败: ${error.message}`);
    }
  }

  /**
   * 获取模型列表，以下拉选项格式返回
   * @param provider 提供商标识
   * @param customConfig 自定义配置（可选）
   */
  async fetchModelList(
    provider: string,
    customConfig?: Partial<ModelConfig>
  ): Promise<ModelOption[]> {
    try {
      // 获取基础配置
      let modelConfig = await this.modelManager.getModel(provider);

      // 如果提供了自定义配置，则合并到基础配置
      if (customConfig) {
        modelConfig = {
          ...modelConfig,
          ...(customConfig as ModelConfig),
        };
      }

      if (!modelConfig) {
        console.warn(`模型 ${provider} 不存在，使用自定义配置`);
        if (!customConfig) {
          throw new RequestConfigError(`模型 ${provider} 不存在`);
        }
        modelConfig = customConfig as ModelConfig;
      }

      // 验证必要的配置（仅验证API URL和密钥）
      if (!modelConfig.baseURL) {
        throw new RequestConfigError('API URL不能为空');
      }
      if (!modelConfig.apiKey) {
        throw new RequestConfigError(ERROR_MESSAGES.API_KEY_REQUIRED);
      }

      let models: ModelInfo[] = [];

      // 根据不同提供商实现不同的获取模型列表逻辑
      console.log(`获取 ${modelConfig.name || provider} 的模型列表`);

      if (provider === 'gemini' || modelConfig.provider === 'gemini') {
        models = await this.fetchGeminiModelsInfo(modelConfig);
      } else if (provider === 'anthropic' || modelConfig.provider === 'anthropic') {
        models = await this.fetchAnthropicModelsInfo(modelConfig);
      } else if (provider === 'deepseek' || modelConfig.provider === 'deepseek') {
        models = await this.fetchDeepSeekModelsInfo(modelConfig);
      } else {
        // OpenAI兼容格式的API，包括自定义模型和Ollama
        models = await this.fetchOpenAICompatibleModelsInfo(modelConfig);
      }

      // 转换为选项格式
      return models.map(model => ({
        value: model.id,
        label: model.name
      }));
    } catch (error: any) {
      console.error('获取模型列表失败:', error);
      if (error instanceof RequestConfigError || error instanceof APIError) {
        throw error;
      }
      throw new APIError(`获取模型列表失败: ${error.message}`);
    }
  }

  /**
   * 获取OpenAI兼容API的模型信息
   */
  private async fetchOpenAICompatibleModelsInfo(modelConfig: ModelConfig): Promise<ModelInfo[]> {
    const openai = this.getOpenAIInstance(modelConfig);

    try {
      // 尝试标准 OpenAI 格式的模型列表请求
      const response = await openai.models.list();

      // 只处理标准 OpenAI 格式
      if (response && response.data && Array.isArray(response.data)) {
        return response.data
          .map(model => ({
            id: model.id,
            name: model.id
          }))
          .sort((a, b) => a.id.localeCompare(b.id));
      }

      // 如果格式不匹配标准格式，记录并返回空数组
      console.warn('API返回格式与预期不符:', response);
      return [];

    } catch (error: any) {
      console.error('获取模型列表失败:', error);

      // 发生错误时返回空数组
      return [];
    }
  }
  /**
   * 获取Gemini模型信息
   */
  private async fetchGeminiModelsInfo(modelConfig: ModelConfig): Promise<ModelInfo[]> {
    console.log(`获取${modelConfig.name || 'Gemini'}的模型列表`);

    // Gemini API没有直接获取模型列表的接口，返回预定义列表
    return [
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' }
    ];
  }

  /**
   * 获取Anthropic模型信息
   */
  private async fetchAnthropicModelsInfo(modelConfig: ModelConfig): Promise<ModelInfo[]> {
    console.log(`获取${modelConfig.name || 'Anthropic'}的模型列表`);

    // Anthropic API的获取模型列表功能未兼容openai格式，所以这里返回一个默认列表
    return [
      { id: 'claude-opus-4-20250514', name: 'Claude 4.0 Opus' },
      { id: 'claude-sonnet-4-20250514', name: 'Claude 4.0 Sonnet' },
      { id: 'claude-3-7-sonnet-latest', name: 'Claude 3.7 Sonnet' },
      { id: 'claude-3-5-haiku-latest', name: 'Claude 3.5 Haiku' }
    ];
  }

  /**
   * 获取DeepSeek模型信息
   */
  private async fetchDeepSeekModelsInfo(modelConfig: ModelConfig): Promise<ModelInfo[]> {
    console.log(`获取${modelConfig.name || 'DeepSeek'}的模型列表`);

    try {
      // 尝试使用OpenAI兼容API获取模型列表
      return await this.fetchOpenAICompatibleModelsInfo(modelConfig);
    } catch (error) {
      console.error('获取DeepSeek模型列表失败，使用默认列表:', error);

      // 返回默认模型
      return [
        { id: 'deepseek-chat', name: 'DeepSeek Chat' },
        { id: 'deepseek-coder', name: 'DeepSeek Coder' }
      ];
    }
  }

  /**
   * 构建Gemini生成配置
   * 
   * 注意：此方法假设传入的 llmParams 已经通过 ModelManager.validateConfig() 
   * 中的 validateLLMParams 验证，确保安全性
   */
  private buildGeminiGenerationConfig(llmParams: Record<string, any> = {}): any {
    const {
      temperature,
      maxOutputTokens,
      topP,
      topK,
      candidateCount,
      stopSequences,
      ...otherParams
    } = llmParams;

    const generationConfig: any = {};
    
    // 添加已知参数
    if (temperature !== undefined) {
      generationConfig.temperature = temperature;
    }
    if (maxOutputTokens !== undefined) {
      generationConfig.maxOutputTokens = maxOutputTokens;
    }
    if (topP !== undefined) {
      generationConfig.topP = topP;
    }
    if (topK !== undefined) {
      generationConfig.topK = topK;
    }
    if (candidateCount !== undefined) {
      generationConfig.candidateCount = candidateCount;
    }
    if (stopSequences !== undefined && Array.isArray(stopSequences)) {
      generationConfig.stopSequences = stopSequences;
    }

    // 添加其他参数 (已在上层验证过安全性)
    // 排除一些明显不属于 Gemini generationConfig 的参数
    for (const [key, value] of Object.entries(otherParams)) {
      if (!['timeout', 'model', 'messages', 'stream'].includes(key)) {
        generationConfig[key] = value;
      }
    }

    return generationConfig;
  }
}

// 导出工厂函数
export function createLLMService(modelManager: ModelManager = defaultModelManager): LLMService {
  return new LLMService(modelManager);
} 
